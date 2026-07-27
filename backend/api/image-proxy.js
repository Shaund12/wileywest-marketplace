/**
 * Image proxy (ported from api/image-proxy.js → pg). Races IPFS gateways for
 * the fastest response, records a proxy URL + placeholder in image_cache.
 */
const { pool } = require('../db/pgClient');

const IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/', 'https://gateway.ipfs.io/ipfs/',
];
const CACHE_CONFIG = { IMAGE_TTL: 24 * 60 * 60 * 1000, EDGE_CACHE_TTL: 'public, max-age=86400, s-maxage=31536000, immutable' };

module.exports = async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { url, placeholder } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });
    try {
        const startTime = Date.now();
        const cached = await getCachedImage(url);
        if (cached && !isExpired(cached.ttl_expires_at)) {
            await recordCacheHit('image_hit', cached.gateway_used);
            await pool.query(`UPDATE image_cache SET hits = hits + 1, last_hit = NOW() WHERE id = $1`, [cached.id]);
            res.setHeader('Cache-Control', CACHE_CONFIG.EDGE_CACHE_TTL);
            res.setHeader('X-Cache-Status', 'HIT');
            await recordLatency('image', Date.now() - startTime);
            if (placeholder === 'true' && cached.placeholder_data) return res.json({ placeholder: cached.placeholder_data, cached: true });
            return res.json({ url: cached.proxy_url, placeholder: cached.placeholder_data, cached: true });
        }
        await recordCacheHit('image_miss');
        const result = await fetchImageWithFallback(url);
        if (!result.success) { await recordCacheHit('image_error'); return res.status(404).json({ error: 'Image not found', url }); }
        const placeholderData = await generatePlaceholder(result.imageBuffer, result.contentType);
        const proxyUrl = generateProxyUrl(url);
        await cacheImage({ originalUrl: url, proxyUrl, contentType: result.contentType, contentLength: result.contentLength, placeholderData, gatewayUsed: result.gatewayUsed });
        await recordLatency('image', Date.now() - startTime);
        res.setHeader('Cache-Control', CACHE_CONFIG.EDGE_CACHE_TTL);
        res.setHeader('X-Cache-Status', 'MISS');
        if (placeholder === 'true') return res.json({ placeholder: placeholderData, cached: false });
        return res.json({ url: proxyUrl, placeholder: placeholderData, cached: false });
    } catch (error) {
        await recordCacheHit('image_error');
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
};

async function fetchImageWithFallback(url) {
    const hash = extractIPFSHash(url);
    if (!hash) return { success: false, error: 'Invalid IPFS URL' };
    const promises = IPFS_GATEWAYS.map(async (gateway) => {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
        try {
            const r = await fetch(`${gateway}${hash}`, { headers: { Accept: 'image/*' }, signal: ctrl.signal });
            clearTimeout(t);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return { success: true, imageBuffer: await r.arrayBuffer(), contentType: r.headers.get('content-type') || 'image/jpeg', contentLength: parseInt(r.headers.get('content-length') || '0', 10), gatewayUsed: gateway.split('//')[1].split('/')[0] };
        } catch (e) { clearTimeout(t); throw e; }
    });
    try { return await Promise.any(promises); } catch { return { success: false, error: 'All gateways failed' }; }
}

function extractIPFSHash(url) {
    if (!url || typeof url !== 'string') return null;
    // Strip any ipfs:// scheme and every leading path/gateway segment, then
    // take the first CID-shaped component. Splitting on '/ipfs/' is not
    // enough on its own: '/api/ipfs/ipfs/<cid>' splits into
    // ['/api', 'ipfs/<cid>'] because matches do not overlap, so the naive
    // result is the literal string "ipfs" and every lookup 404s.
    const cleaned = url.replace(/^ipfs:\/\//, '');
    const cid = cleaned
        .split('/')
        .find((part) => /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{20,})/.test(part));
    return cid || null;
}
async function generatePlaceholder(imageBuffer, contentType) {
    try {
        const hash = Array.from(new Uint8Array(imageBuffer.slice(0, 3))).map((b) => b.toString(16).padStart(2, '0')).join('');
        return { dominantColor: `#${hash}`, type: 'color', contentType, size: imageBuffer.byteLength, generated: new Date().toISOString() };
    } catch (e) { return { dominantColor: '#1a1a1a', type: 'fallback', error: e.message }; }
}
function generateProxyUrl(originalUrl) { const hash = extractIPFSHash(originalUrl); return hash ? `${IPFS_GATEWAYS[0]}${hash}` : originalUrl; }
async function getCachedImage(originalUrl) { const { rows } = await pool.query(`SELECT * FROM image_cache WHERE original_url = $1`, [originalUrl]); return rows[0] || null; }
async function cacheImage(d) {
    const ttl = new Date(Date.now() + CACHE_CONFIG.IMAGE_TTL);
    await pool.query(
        `INSERT INTO image_cache (original_url, proxy_url, content_type, content_length, placeholder_data, gateway_used, cache_status, ttl_expires_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'cached',$7,NOW())
         ON CONFLICT (original_url) DO UPDATE SET proxy_url = EXCLUDED.proxy_url, content_type = EXCLUDED.content_type,
           content_length = EXCLUDED.content_length, placeholder_data = EXCLUDED.placeholder_data,
           gateway_used = EXCLUDED.gateway_used, ttl_expires_at = EXCLUDED.ttl_expires_at, updated_at = NOW()`,
        [d.originalUrl, d.proxyUrl, d.contentType, d.contentLength, d.placeholderData, d.gatewayUsed, ttl.toISOString()],
    );
}
async function recordCacheHit(metricType, gatewayUsed = null) { try { await pool.query(`INSERT INTO cache_metrics (metric_type, cache_type, value, dimensions) VALUES ($1,'image',1,$2)`, [metricType, gatewayUsed ? { gateway: gatewayUsed } : {}]); } catch { /* ignore */ } }
async function recordLatency(cacheType, latency) { try { await pool.query(`INSERT INTO cache_metrics (metric_type, cache_type, value) VALUES ('latency',$1,$2)`, [cacheType, latency]); } catch { /* ignore */ } }
function isExpired(ttl) { return new Date(ttl) < new Date(); }
