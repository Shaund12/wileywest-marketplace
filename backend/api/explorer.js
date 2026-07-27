/**
 * Blockscout explorer proxy.
 *
 * Both supported chains run Blockscout, whose REST API already indexes every
 * ERC-721/1155 contract on chain and resolves token metadata (including IPFS
 * images) server-side. Reading collections from here instead of scanning logs
 * avoids the bounded-scan machinery in src/utils/nftScanner.js entirely — no
 * eth_getLogs sweeps, so no risk of the mass-collection problem those caps
 * exist to prevent.
 *
 * This is a proxy rather than a direct browser call for three reasons:
 *   1. Hyve's upstream does not reliably send browser CORS headers (its RPC
 *      already does not), so same-origin is the only safe assumption.
 *   2. The two deployments run different Blockscout versions and disagree on
 *      field names — normalization has to happen somewhere central.
 *   3. A shared server-side cache turns N browsers into 1 upstream request.
 *
 * Upstreams are allowlisted per chain so this cannot become an open proxy.
 */

const EXPLORER_TARGETS = Object.freeze({
    hyve: process.env.HYVE_EXPLORER_URL || 'https://explorer.hyvechain.com',
    vitruveo: process.env.VITRUVEO_EXPLORER_URL || 'https://explorer.vitruveo.ai',
});

// Collection lists change rarely (a new NFT contract is a rare event); token
// pages change when tokens transfer. Both tolerate minute-scale staleness.
const TTL = Object.freeze({
    collections: 10 * 60_000,
    collection: 5 * 60_000,
    instances: 2 * 60_000,
});

const MAX_CACHE_ENTRIES = 500;
const UPSTREAM_TIMEOUT_MS = 10_000;

const cache = new Map();
const inFlight = new Map();

const isAddress = (value) => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);

function getCached(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return hit.value;
}

function setCached(key, value, ttl) {
    if (!ttl) return;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expiresAt: Date.now() + ttl });
}

async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Fetch + cache + coalesce. Concurrent callers asking for the same upstream
 * path share one request, so a burst of browsers landing on the explore page
 * at once produces a single upstream hit.
 */
async function fetchUpstream(chain, path, ttl) {
    const base = EXPLORER_TARGETS[chain];
    const key = `${chain}:${path}`;

    const cached = getCached(key);
    if (cached) return { ...cached, cacheState: 'HIT' };

    let promise = inFlight.get(key);
    const coalesced = !!promise;
    if (!promise) {
        promise = (async () => {
            const upstream = await fetchWithTimeout(`${base}${path}`, UPSTREAM_TIMEOUT_MS);
            if (!upstream.ok) {
                const error = new Error(`Explorer returned HTTP ${upstream.status}`);
                error.status = upstream.status === 404 ? 404 : 502;
                throw error;
            }
            return upstream.json();
        })();
        inFlight.set(key, promise);
        promise.finally(() => inFlight.delete(key)).catch(() => undefined);
    }

    try {
        const data = await promise;
        const result = { data };
        if (!coalesced) setCached(key, result, ttl);
        return { ...result, cacheState: coalesced ? 'COALESCED' : 'MISS' };
    } catch (error) {
        if (error.name === 'AbortError') {
            const timeoutError = new Error('Explorer upstream timed out');
            timeoutError.status = 504;
            throw timeoutError;
        }
        throw error;
    }
}

/**
 * Normalize a Blockscout token record.
 *
 * The deployments disagree: Vitruveo returns `address_hash`/`holders_count`,
 * Hyve returns `address`/`holders`. Consumers should never see that split.
 */
function normalizeCollection(raw) {
    if (!raw) return null;
    const address = raw.address_hash || raw.address || null;
    if (!address) return null;

    const toCount = (value) => {
        const n = Number.parseInt(value, 10);
        return Number.isFinite(n) ? n : 0;
    };

    return {
        address,
        name: raw.name || 'Unnamed Collection',
        symbol: raw.symbol || '',
        type: raw.type || 'ERC-721',
        totalSupply: toCount(raw.total_supply),
        holders: toCount(raw.holders_count ?? raw.holders),
        iconUrl: raw.icon_url || null,
    };
}

/**
 * Normalize a token instance. `metadata` is whatever the contract's tokenURI
 * returned, so every field inside it is untrusted and optional.
 */
function normalizeInstance(raw, contractAddress) {
    if (!raw) return null;
    const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    const attributes = Array.isArray(metadata.attributes) ? metadata.attributes : [];

    return {
        tokenId: raw.id != null ? String(raw.id) : null,
        contract: contractAddress,
        name: metadata.name || (raw.id != null ? `#${raw.id}` : 'Unknown'),
        description: metadata.description || '',
        // media_url is frequently a raw ipfs:// URI; image_url is the
        // explorer's already-resolved gateway URL. Prefer the resolved one.
        imageUrl: raw.image_url || metadata.image || null,
        rawImage: raw.media_url || metadata.image || null,
        animationUrl: raw.animation_url || null,
        owner: raw.owner?.hash || null,
        attributes: attributes
            .filter((a) => a && typeof a === 'object')
            .map((a) => ({ trait: a.trait_type ?? a.traitType ?? '', value: a.value })),
    };
}

/**
 * GET /api/explorer/:chain/collections
 * GET /api/explorer/:chain/collections/:address
 * GET /api/explorer/:chain/collections/:address/instances?cursor=<n>
 */
module.exports = async function explorerHandler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { chain } = req.params;
    if (!EXPLORER_TARGETS[chain]) return res.status(404).json({ error: 'Unsupported chain' });

    const address = req.params.address;
    const wantsInstances = req.params.section === 'instances';

    try {
        // ── Single collection's tokens ──────────────────────────────────
        if (address && wantsInstances) {
            if (!isAddress(address)) return res.status(400).json({ error: 'Invalid contract address' });

            // Blockscout paginates instances at 50/page via an opaque
            // `unique_token` cursor. Pass it through rather than trying to
            // walk every page server-side — a 54k-token collection must not
            // become one request.
            const cursor = req.query.cursor;
            let path = `/api/v2/tokens/${address}/instances`;
            if (cursor !== undefined) {
                const parsed = Number.parseInt(cursor, 10);
                if (!Number.isFinite(parsed) || parsed < 0) {
                    return res.status(400).json({ error: 'Invalid cursor' });
                }
                path += `?unique_token=${parsed}`;
            }

            const { data, cacheState } = await fetchUpstream(chain, path, TTL.instances);
            const items = Array.isArray(data.items) ? data.items : [];

            res.setHeader('Cache-Control', 'public, max-age=60');
            res.setHeader('X-BlockDust-Explorer-Cache', cacheState);
            return res.json({
                success: true,
                chain,
                contract: address,
                items: items.map((item) => normalizeInstance(item, address)).filter(Boolean),
                nextCursor: data.next_page_params?.unique_token ?? null,
            });
        }

        // ── Single collection's detail ──────────────────────────────────
        if (address) {
            if (!isAddress(address)) return res.status(400).json({ error: 'Invalid contract address' });

            const { data, cacheState } = await fetchUpstream(
                chain,
                `/api/v2/tokens/${address}`,
                TTL.collection,
            );
            const collection = normalizeCollection(data);
            if (!collection) return res.status(404).json({ error: 'Collection not found' });

            res.setHeader('Cache-Control', 'public, max-age=120');
            res.setHeader('X-BlockDust-Explorer-Cache', cacheState);
            return res.json({ success: true, chain, collection });
        }

        // ── All NFT collections on chain ────────────────────────────────
        // Blockscout filters one type per request, so ERC-721 and ERC-1155
        // are two calls. Both are cached and coalesced.
        const [erc721, erc1155] = await Promise.all([
            fetchUpstream(chain, '/api/v2/tokens?type=ERC-721', TTL.collections),
            fetchUpstream(chain, '/api/v2/tokens?type=ERC-1155', TTL.collections)
                // A chain with no ERC-1155s (or an older Blockscout that
                // rejects the filter) should not fail the whole page.
                .catch(() => ({ data: { items: [] }, cacheState: 'MISS' })),
        ]);

        const collections = [...(erc721.data.items || []), ...(erc1155.data.items || [])]
            .map(normalizeCollection)
            .filter(Boolean)
            // Busiest collections first — holder count is the best available
            // proxy for real activity and pushes spam contracts down.
            .sort((a, b) => b.holders - a.holders || b.totalSupply - a.totalSupply);

        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-BlockDust-Explorer-Cache', erc721.cacheState);
        return res.json({ success: true, chain, count: collections.length, collections });
    } catch (error) {
        return res.status(error.status || 502).json({
            error: 'Explorer upstream unavailable',
            detail: error.message,
        });
    }
};

module.exports.EXPLORER_TARGETS = EXPLORER_TARGETS;
module.exports.normalizeCollection = normalizeCollection;
module.exports.normalizeInstance = normalizeInstance;
