/**
 * Client for the same-origin Blockscout proxy (backend/api/explorer.js).
 *
 * This is the cheap path for browsing on-chain collections: the explorer has
 * already indexed every NFT contract and resolved its token metadata, so a
 * collection listing costs one HTTP request instead of an eth_getLogs sweep.
 * Prefer it over src/utils/nftScanner.js for read-only discovery UI — the
 * scanner's block-window caps exist to bound RPC cost and should stay bounded.
 *
 * Responses are already normalized across the two Blockscout deployments
 * (which disagree on field names), so callers see one consistent shape.
 */

import { CHAINS, getActiveChainId } from '../config/chains.js';

/** Map a numeric chain id to the proxy's chain slug. */
export function chainSlug(chainId = getActiveChainId()) {
    return CHAINS[chainId]?.key || null;
}

/**
 * A short-lived client cache on top of the server's. The server cache already
 * protects the upstream; this one exists so that going NFT detail → back does
 * not re-fetch a list the user just looked at.
 */
const CLIENT_TTL_MS = 60_000;
const clientCache = new Map();

function readCache(key) {
    const hit = clientCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        clientCache.delete(key);
        return null;
    }
    return hit.value;
}

function writeCache(key, value) {
    if (clientCache.size >= 100) clientCache.delete(clientCache.keys().next().value);
    clientCache.set(key, { value, expiresAt: Date.now() + CLIENT_TTL_MS });
}

export function clearExplorerCache() {
    clientCache.clear();
}

async function getJson(path, { signal } = {}) {
    const cached = readCache(path);
    if (cached) return cached;

    const res = await fetch(path, { headers: { accept: 'application/json' }, signal });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
        throw new Error(body?.error || `Explorer request failed (HTTP ${res.status})`);
    }
    writeCache(path, body);
    return body;
}

/**
 * Every NFT collection on a chain, busiest first.
 * Returns [] for a chain with no explorer slug rather than throwing.
 */
export async function fetchCollections(chainId = getActiveChainId(), opts = {}) {
    const slug = chainSlug(chainId);
    if (!slug) return { collections: [], count: 0 };

    const body = await getJson(`/api/explorer/${slug}/collections`, opts);
    return { collections: body.collections || [], count: body.count || 0 };
}

/** One collection's on-chain summary (name, symbol, supply, holders). */
export async function fetchCollection(address, chainId = getActiveChainId(), opts = {}) {
    const slug = chainSlug(chainId);
    if (!slug || !address) return null;

    const body = await getJson(`/api/explorer/${slug}/collections/${address}`, opts);
    return body.collection || null;
}

/**
 * One page of a collection's tokens (50 per page, metadata pre-resolved).
 *
 * `cursor` is the `nextCursor` from the previous page; omit it for page one.
 * Always paginate — some collections hold 50k+ tokens and must never be
 * fetched whole.
 */
export async function fetchCollectionTokens(address, { chainId = getActiveChainId(), cursor = null, signal } = {}) {
    const slug = chainSlug(chainId);
    if (!slug || !address) return { items: [], nextCursor: null };

    const query = cursor != null ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const body = await getJson(`/api/explorer/${slug}/collections/${address}/instances${query}`, { signal });
    return { items: body.items || [], nextCursor: body.nextCursor ?? null };
}
