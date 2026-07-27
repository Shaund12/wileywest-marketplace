/**
 * Metadata cache (ported from api/metadata-cache.js → pg).
 * Cache-first NFT metadata: reads metadata_cache, falls back to on-chain
 * tokenURI + IPFS fetch, then caches the normalized result.
 */
const { ethers } = require('ethers');
const { pool } = require('../db/pgClient');

const CACHE_CONFIG = {
    METADATA_TTL: 6 * 60 * 60 * 1000,
    DEFAULT_PLACEHOLDER: 'https://via.placeholder.com/300x300/1a1a1a/fff?text=NFT',
};
const IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
const ERC721_ABI = ['function tokenURI(uint256 tokenId) view returns (string)'];
const ERC1155_ABI = ['function uri(uint256 tokenId) view returns (string)'];

// A contract lives on exactly one chain, and this endpoint is called for both.
// Resolving against a single RPC (VITE_RPC_URL, which is Hyve in production)
// meant every Vitruveo NFT returned "No URI method" — the address has no code
// on Hyve, so tokenURI() and uri() both come back empty '0x'. Try each chain.
const CHAIN_RPCS = [
    process.env.VITE_RPC_URL,
    process.env.HYVE_RPC_URL || 'https://rpc.hyvechain.com',
    process.env.VITRUVEO_RPC_URL || 'https://rpc.vitruveo.ai',
].filter(Boolean).filter((url, i, all) => all.indexOf(url) === i);

// Explorer RPCs as a second attempt: the public upstreams (Hyve especially)
// return 504s under load, and a failed read here becomes a placeholder image.
const CHAIN_RPC_FALLBACKS = [
    'https://explorer.hyvechain.com/api/eth-rpc',
    'https://explorer.vitruveo.ai/api/eth-rpc',
];

module.exports = async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { contract, tokenId, refresh } = req.query;
    if (!contract || !tokenId) return res.status(400).json({ error: 'Missing required parameters: contract and tokenId' });

    try {
        const startTime = Date.now();
        const cacheKey = `${contract.toLowerCase()}-${tokenId}`;
        if (refresh !== 'true') {
            const cached = await getCachedMetadata(cacheKey);
            if (cached && !isExpired(cached.ttl_expires_at)) {
                await recordCacheHit('metadata_hit');
                await pool.query(`UPDATE metadata_cache SET hits = hits + 1, last_hit = NOW() WHERE id = $1`, [cached.id]);
                await recordLatency('metadata', Date.now() - startTime);
                res.setHeader('X-Cache-Status', 'HIT');
                return res.json({ ...cached.metadata, cached: true, cacheKey });
            }
        }
        await recordCacheHit('metadata_miss');
        const metadata = await fetchMetadataFromContract(contract, tokenId);
        if (!metadata.success) {
            await recordCacheHit('metadata_error');
            return res.status(404).json({ error: 'Metadata not found', contract, tokenId, details: metadata.error });
        }
        const normalized = normalizeMetadata(metadata.data, contract, tokenId);
        await cacheMetadata({ contractAddress: contract, tokenId, cacheKey, metadata: normalized, tokenUri: metadata.tokenUri });
        await recordLatency('metadata', Date.now() - startTime);
        res.setHeader('X-Cache-Status', 'MISS');
        return res.json({ ...normalized, cached: false, cacheKey });
    } catch (error) {
        await recordCacheHit('metadata_error');
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
};

/** Read tokenURI/uri from one RPC, or null if the contract isn't there. */
async function readTokenUri(rpcUrl, contractAddress, tokenId) {
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    try {
        // A contract with no code returns empty '0x', which ethers reports as a
        // BAD_DATA decode failure — indistinguishable here from a real revert,
        // so both simply mean "not on this chain, try the next one".
        try {
            return await new ethers.Contract(contractAddress, ERC721_ABI, provider).tokenURI(tokenId);
        } catch {
            return await new ethers.Contract(contractAddress, ERC1155_ABI, provider).uri(tokenId);
        }
    } catch {
        return null;
    } finally {
        provider.destroy?.();
    }
}

async function fetchMetadataFromContract(contractAddress, tokenId) {
    try {
        let tokenURI = null;
        for (const rpcUrl of [...CHAIN_RPCS, ...CHAIN_RPC_FALLBACKS]) {
            tokenURI = await readTokenUri(rpcUrl, contractAddress, tokenId);
            if (tokenURI) break;
        }
        if (!tokenURI) return { success: false, error: 'No URI method on any configured chain' };
        return { success: true, data: await fetchMetadataFromURI(tokenURI), tokenUri: tokenURI };
    } catch (error) { return { success: false, error: error.message }; }
}

async function fetchMetadataFromURI(tokenURI) {
    if (tokenURI.startsWith('data:')) { return JSON.parse(Buffer.from(tokenURI.split(',')[1], 'base64').toString('utf8')); }
    if (tokenURI.startsWith('http')) {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
        try { const r = await fetch(tokenURI, { headers: { Accept: 'application/json' }, signal: ctrl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } finally { clearTimeout(t); }
    }
    if (tokenURI.startsWith('ipfs://') || tokenURI.includes('/ipfs/')) {
        const hash = tokenURI.startsWith('ipfs://') ? tokenURI.replace('ipfs://', '') : tokenURI.split('/ipfs/')[1];
        for (const gw of IPFS_GATEWAYS) {
            try { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000); const r = await fetch(`${gw}${hash}`, { headers: { Accept: 'application/json' }, signal: ctrl.signal }); clearTimeout(t); if (r.ok) return await r.json(); } catch { /* next */ }
        }
        throw new Error('All IPFS gateways failed');
    }
    throw new Error(`Unsupported URI format: ${tokenURI}`);
}

/**
 * Rewrite ipfs:// (and bare-CID) image URIs to the same-origin gateway.
 * A browser cannot load an ipfs:// URL, so returning one verbatim rendered
 * a broken image on every NFT whose metadata used the canonical scheme.
 */
function resolveImageUri(uri) {
    if (!uri || typeof uri !== 'string') return null;
    if (uri.startsWith('ipfs://')) {
        return `/api/ipfs/ipfs/${uri.replace(/^ipfs:\/\/(ipfs\/)?/, '')}`;
    }
    if (uri.includes('/ipfs/')) {
        return `/api/ipfs/ipfs/${uri.split('/ipfs/')[1]}`;
    }
    // Bare CIDv0/CIDv1 with no scheme.
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{50,})/.test(uri)) {
        return `/api/ipfs/ipfs/${uri}`;
    }
    return uri;
}

function normalizeMetadata(m, contractAddress, tokenId) {
    const rawImage = m?.image || m?.imageUrl;
    const image = resolveImageUri(rawImage) || CACHE_CONFIG.DEFAULT_PLACEHOLDER;
    return {
        name: m?.name || `NFT #${tokenId}`, description: m?.description || '',
        image,
        imageUrl: image,
        attributes: m?.attributes || m?.traits || [], contractAddress: contractAddress.toLowerCase(),
        tokenId: tokenId.toString(), collection: m?.collection || null,
        externalUrl: m?.external_url || m?.externalUrl || null,
        animationUrl: resolveImageUri(m?.animation_url || m?.animationUrl),
        backgroundColor: m?.background_color || m?.backgroundColor || null,
        loaded: true, loading: false, error: null, timestamp: Date.now(), loadingStrategy: 'cache_api',
    };
}

async function getCachedMetadata(cacheKey) {
    const { rows } = await pool.query(`SELECT * FROM metadata_cache WHERE cache_key = $1`, [cacheKey]);
    return rows[0] || null;
}
async function cacheMetadata(d) {
    const ttl = new Date(Date.now() + CACHE_CONFIG.METADATA_TTL);
    await pool.query(
        `INSERT INTO metadata_cache (contract_address, token_id, cache_key, metadata, image_url, token_uri, ttl_expires_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (cache_key) DO UPDATE SET metadata = EXCLUDED.metadata, image_url = EXCLUDED.image_url,
           token_uri = EXCLUDED.token_uri, ttl_expires_at = EXCLUDED.ttl_expires_at, updated_at = NOW()`,
        [d.contractAddress.toLowerCase(), d.tokenId.toString(), d.cacheKey, d.metadata, d.metadata.image, d.tokenUri, ttl.toISOString()],
    );
}
async function recordCacheHit(metricType) { try { await pool.query(`INSERT INTO cache_metrics (metric_type, cache_type, value) VALUES ($1,'metadata',1)`, [metricType]); } catch { /* ignore */ } }
async function recordLatency(cacheType, latency) { try { await pool.query(`INSERT INTO cache_metrics (metric_type, cache_type, value) VALUES ('latency',$1,$2)`, [cacheType, latency]); } catch { /* ignore */ } }
function isExpired(ttl) { return new Date(ttl) < new Date(); }
