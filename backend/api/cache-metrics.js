/**
 * Cache metrics (ported from api/cache-metrics.js → pg). Aggregates hit/miss
 * and latency data from cache_metrics and health from the cache tables. The
 * original relied on PostgREST aggregate syntax; here we use real SQL.
 */
const { pool } = require('../db/pgClient');

module.exports = async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { timeframe = '1h', type = 'summary' } = req.query;
    try {
        let metrics;
        switch (type) {
            case 'summary': metrics = await getSummaryMetrics(timeframe); break;
            case 'latency': metrics = await getLatencyMetrics(timeframe); break;
            case 'cache': metrics = await getCacheHealthMetrics(); break;
            case 'gateways': metrics = await getGatewayMetrics(timeframe); break;
            default: return res.status(400).json({ error: 'Invalid metrics type' });
        }
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.json({ success: true, type, timeframe, timestamp: new Date().toISOString(), ...metrics });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch metrics', message: error.message });
    }
};

function since(timeframe) {
    const hours = { '15m': 0.25, '1h': 1, '6h': 6, '24h': 24, '7d': 168 }[timeframe] ?? 1;
    return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function getSummaryMetrics(timeframe) {
    const t = since(timeframe);
    const { rows: hm } = await pool.query(
        `SELECT metric_type, cache_type, COUNT(*)::int AS count FROM cache_metrics
         WHERE metric_type IN ('metadata_hit','metadata_miss','image_hit','image_miss') AND timestamp >= $1
         GROUP BY metric_type, cache_type`, [t]);
    const { rows: lat } = await pool.query(
        `SELECT cache_type, AVG(value)::numeric AS avg_latency FROM cache_metrics
         WHERE metric_type = 'latency' AND timestamp >= $1 GROUP BY cache_type`, [t]);
    const stats = { metadata: { hits: 0, misses: 0, hitRate: 0 }, images: { hits: 0, misses: 0, hitRate: 0 }, latency: { metadata: 0, images: 0 } };
    hm.forEach((row) => {
        if (row.cache_type === 'metadata') { if (row.metric_type === 'metadata_hit') stats.metadata.hits = row.count; if (row.metric_type === 'metadata_miss') stats.metadata.misses = row.count; }
        else if (row.cache_type === 'image') { if (row.metric_type === 'image_hit') stats.images.hits = row.count; if (row.metric_type === 'image_miss') stats.images.misses = row.count; }
    });
    const mTot = stats.metadata.hits + stats.metadata.misses, iTot = stats.images.hits + stats.images.misses;
    stats.metadata.hitRate = mTot ? (stats.metadata.hits / mTot * 100) : 0;
    stats.images.hitRate = iTot ? (stats.images.hits / iTot * 100) : 0;
    lat.forEach((row) => { stats.latency[row.cache_type] = Math.round(parseFloat(row.avg_latency) || 0); });
    return { summary: stats, total: { requests: mTot + iTot, hits: stats.metadata.hits + stats.images.hits, misses: stats.metadata.misses + stats.images.misses, overallHitRate: (mTot + iTot) ? ((stats.metadata.hits + stats.images.hits) / (mTot + iTot) * 100) : 0 } };
}

async function getLatencyMetrics(timeframe) {
    const t = since(timeframe);
    const { rows } = await pool.query(
        `SELECT cache_type,
           AVG(value)::numeric AS avg, MIN(value)::numeric AS min, MAX(value)::numeric AS max,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY value) AS p99
         FROM cache_metrics WHERE metric_type = 'latency' AND timestamp >= $1 GROUP BY cache_type`, [t]);
    const latency = {};
    rows.forEach((r) => { latency[r.cache_type] = { p50: Math.round(r.p50 || 0), p95: Math.round(r.p95 || 0), p99: Math.round(r.p99 || 0), avg: Math.round(r.avg || 0), min: Math.round(r.min || 0), max: Math.round(r.max || 0) }; });
    return { latency };
}

async function getCacheHealthMetrics() {
    const [metadata, images] = await Promise.all([tableStats('metadata_cache'), tableStats('image_cache')]);
    const { rows: q } = await pool.query(`SELECT status, COUNT(*)::int AS count FROM prewarm_queue GROUP BY status`);
    const queue = {}; q.forEach((r) => { queue[r.status] = r.count; });
    return { metadata, images, prewarmQueue: queue, health: { metadataHealthy: metadata.total > 0, imageHealthy: images.total > 0, queueHealthy: (queue.failed || 0) < (queue.completed || 1) * 0.1 } };
}

async function getGatewayMetrics(timeframe) {
    const t = since(timeframe);
    const { rows } = await pool.query(
        `SELECT gateway_used, COUNT(*)::int AS count, AVG(hits)::numeric AS avg_hits FROM image_cache
         WHERE created_at >= $1 AND gateway_used IS NOT NULL GROUP BY gateway_used ORDER BY count DESC`, [t]);
    const gateways = {};
    rows.forEach((r) => { gateways[r.gateway_used] = { usage: r.count, avgHits: Math.round(parseFloat(r.avg_hits) || 0) }; });
    return { gateways };
}

async function tableStats(tableName) {
    const allowed = { metadata_cache: 'metadata_cache', image_cache: 'image_cache' };
    const tbl = allowed[tableName];
    if (!tbl) return { total: 0, active: 0, expired: 0, hitRate: 0 };
    const { rows: total } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${tbl}`);
    const { rows: exp } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${tbl} WHERE ttl_expires_at < NOW()`);
    const t = total[0].c, e = exp[0].c, active = t - e;
    return { total: t, active, expired: e, hitRate: active > 0 ? (active / (t || 1) * 100) : 0 };
}
