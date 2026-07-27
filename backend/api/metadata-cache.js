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

async function fetchMetadataFromContract(contractAddress, tokenId) {
    try {
        const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        let tokenURI;
        try { tokenURI = await new ethers.Contract(contractAddress, ERC721_ABI, provider).tokenURI(tokenId); }
        catch { try { tokenURI = await new ethers.Contract(contractAddress, ERC1155_ABI, provider).uri(tokenId); } catch (e) { return { success: false, error: `No URI method: ${e.message}` }; } }
        if (!tokenURI) return { success: false, error: 'Empty tokenURI' };
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

function normalizeMetadata(m, contractAddress, tokenId) {
    return {
        name: m?.name || `NFT #${tokenId}`, description: m?.description || '',
        image: m?.image || m?.imageUrl || CACHE_CONFIG.DEFAULT_PLACEHOLDER,
        imageUrl: m?.image || m?.imageUrl || CACHE_CONFIG.DEFAULT_PLACEHOLDER,
        attributes: m?.attributes || m?.traits || [], contractAddress: contractAddress.toLowerCase(),
        tokenId: tokenId.toString(), collection: m?.collection || null,
        externalUrl: m?.external_url || m?.externalUrl || null, animationUrl: m?.animation_url || m?.animationUrl || null,
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
