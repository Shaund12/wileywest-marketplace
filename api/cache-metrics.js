/**
 * Cache Metrics API - Monitor cache performance and provide dashboard data
 * 
 * Features:
 * - Real-time cache hit/miss rates
 * - Latency percentiles
 * - Gateway performance
 * - Cache size and health
 * - Historical trends
 */

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
let supabase = null;
function initSupabase() {
    if (!supabase) {
        const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
        
        if (supabaseUrl && supabaseKey && supabaseUrl !== 'https://dummy.supabase.co') {
            supabase = createClient(supabaseUrl, supabaseKey);
        }
    }
    return supabase;
}

/**
 * Main handler for cache metrics requests
 */
module.exports = async (req, res) => {
    const client = initSupabase();
    if (!client) {
        return res.status(503).json({ error: 'Metrics service unavailable' });
    }

    // Only handle GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { timeframe = '1h', type = 'summary' } = req.query;

    try {
        let metrics;
        
        switch (type) {
            case 'summary':
                metrics = await getSummaryMetrics(client, timeframe);
                break;
            case 'latency':
                metrics = await getLatencyMetrics(client, timeframe);
                break;
            case 'cache':
                metrics = await getCacheHealthMetrics(client);
                break;
            case 'gateways':
                metrics = await getGatewayMetrics(client, timeframe);
                break;
            default:
                return res.status(400).json({ error: 'Invalid metrics type' });
        }

        // Set cache headers for metrics (short cache time)
        res.setHeader('Cache-Control', 'public, max-age=60'); // 1 minute cache
        
        return res.json({
            success: true,
            type,
            timeframe,
            timestamp: new Date().toISOString(),
            ...metrics
        });

    } catch (error) {
        console.error('Cache metrics error:', error);
        return res.status(500).json({ 
            error: 'Failed to fetch metrics',
            message: error.message 
        });
    }
};

/**
 * Get summary cache metrics
 */
async function getSummaryMetrics(client, timeframe) {
    const timeCondition = getTimeCondition(timeframe);
    
    try {
        // Get hit/miss rates for both metadata and images
        const { data: hitMissData, error: hitMissError } = await client
            .from('cache_metrics')
            .select('metric_type, cache_type, count(*)')
            .in('metric_type', ['metadata_hit', 'metadata_miss', 'image_hit', 'image_miss'])
            .gte('timestamp', timeCondition)
            .group('metric_type, cache_type');

        if (hitMissError) throw hitMissError;

        // Get average latencies
        const { data: latencyData, error: latencyError } = await client
            .from('cache_metrics')
            .select('cache_type, avg(value)::numeric as avg_latency')
            .eq('metric_type', 'latency')
            .gte('timestamp', timeCondition)
            .group('cache_type');

        if (latencyError) throw latencyError;

        // Process hit/miss data
        const stats = {
            metadata: { hits: 0, misses: 0, hitRate: 0 },
            images: { hits: 0, misses: 0, hitRate: 0 },
            latency: { metadata: 0, images: 0 }
        };

        // Parse hit/miss data
        (hitMissData || []).forEach(row => {
            const count = parseInt(row.count) || 0;
            if (row.cache_type === 'metadata') {
                if (row.metric_type === 'metadata_hit') stats.metadata.hits = count;
                if (row.metric_type === 'metadata_miss') stats.metadata.misses = count;
            } else if (row.cache_type === 'image') {
                if (row.metric_type === 'image_hit') stats.images.hits = count;
                if (row.metric_type === 'image_miss') stats.images.misses = count;
            }
        });

        // Calculate hit rates
        const metadataTotal = stats.metadata.hits + stats.metadata.misses;
        const imageTotal = stats.images.hits + stats.images.misses;
        
        stats.metadata.hitRate = metadataTotal > 0 ? 
            (stats.metadata.hits / metadataTotal * 100) : 0;
        stats.images.hitRate = imageTotal > 0 ? 
            (stats.images.hits / imageTotal * 100) : 0;

        // Parse latency data
        (latencyData || []).forEach(row => {
            const avgLatency = parseFloat(row.avg_latency) || 0;
            stats.latency[row.cache_type] = Math.round(avgLatency);
        });

        return {
            summary: stats,
            total: {
                requests: metadataTotal + imageTotal,
                hits: stats.metadata.hits + stats.images.hits,
                misses: stats.metadata.misses + stats.images.misses,
                overallHitRate: (metadataTotal + imageTotal) > 0 ? 
                    ((stats.metadata.hits + stats.images.hits) / (metadataTotal + imageTotal) * 100) : 0
            }
        };

    } catch (error) {
        console.error('Summary metrics error:', error);
        return { error: error.message };
    }
}

/**
 * Get latency percentile metrics
 */
async function getLatencyMetrics(client, timeframe) {
    const timeCondition = getTimeCondition(timeframe);
    
    try {
        // Get latency percentiles using PostgreSQL percentile functions
        const { data, error } = await client.rpc('get_latency_percentiles', {
            time_condition: timeCondition
        });

        if (error) {
            // Fallback to simple average if RPC doesn't exist
            const { data: avgData, error: avgError } = await client
                .from('cache_metrics')
                .select('cache_type, avg(value)::numeric as avg_latency, min(value)::numeric as min_latency, max(value)::numeric as max_latency')
                .eq('metric_type', 'latency')
                .gte('timestamp', timeCondition)
                .group('cache_type');

            if (avgError) throw avgError;

            const fallbackData = {};
            (avgData || []).forEach(row => {
                fallbackData[row.cache_type] = {
                    p50: Math.round(parseFloat(row.avg_latency) || 0),
                    p95: Math.round(parseFloat(row.max_latency) || 0),
                    p99: Math.round(parseFloat(row.max_latency) || 0),
                    avg: Math.round(parseFloat(row.avg_latency) || 0),
                    min: Math.round(parseFloat(row.min_latency) || 0),
                    max: Math.round(parseFloat(row.max_latency) || 0)
                };
            });

            return { latency: fallbackData };
        }

        return { latency: data };

    } catch (error) {
        console.error('Latency metrics error:', error);
        return { error: error.message };
    }
}

/**
 * Get cache health metrics (current state)
 */
async function getCacheHealthMetrics(client) {
    try {
        // Get cache table sizes and health
        const [metadataStats, imageStats] = await Promise.all([
            getCacheTableStats(client, 'metadata_cache'),
            getCacheTableStats(client, 'image_cache')
        ]);

        // Get pre-warm queue status
        const { data: queueStats, error: queueError } = await client
            .from('prewarm_queue')
            .select('status, count(*)')
            .group('status');

        const queueStatusCounts = {};
        (queueStats || []).forEach(row => {
            queueStatusCounts[row.status] = parseInt(row.count) || 0;
        });

        return {
            metadata: metadataStats,
            images: imageStats,
            prewarmQueue: queueStatusCounts,
            health: {
                metadataHealthy: metadataStats.total > 0,
                imageHealthy: imageStats.total > 0,
                queueHealthy: (queueStatusCounts.failed || 0) < (queueStatusCounts.completed || 1) * 0.1 // Less than 10% failure rate
            }
        };

    } catch (error) {
        console.error('Cache health metrics error:', error);
        return { error: error.message };
    }
}

/**
 * Get gateway performance metrics
 */
async function getGatewayMetrics(client, timeframe) {
    const timeCondition = getTimeCondition(timeframe);
    
    try {
        // Get gateway usage from image cache
        const { data: gatewayData, error: gatewayError } = await client
            .from('image_cache')
            .select('gateway_used, count(*), avg(hits)::numeric as avg_hits')
            .gte('created_at', timeCondition)
            .group('gateway_used')
            .order('count', { ascending: false });

        if (gatewayError) throw gatewayError;

        const gateways = {};
        (gatewayData || []).forEach(row => {
            if (row.gateway_used) {
                gateways[row.gateway_used] = {
                    usage: parseInt(row.count) || 0,
                    avgHits: Math.round(parseFloat(row.avg_hits) || 0)
                };
            }
        });

        return { gateways };

    } catch (error) {
        console.error('Gateway metrics error:', error);
        return { error: error.message };
    }
}

/**
 * Get cache table statistics
 */
async function getCacheTableStats(client, tableName) {
    try {
        const { count, error } = await client
            .from(tableName)
            .select('*', { count: 'exact', head: true });

        if (error) throw error;

        // Get expired entries count
        const { count: expiredCount, error: expiredError } = await client
            .from(tableName)
            .select('*', { count: 'exact', head: true })
            .lt('ttl_expires_at', new Date().toISOString());

        const expired = expiredError ? 0 : expiredCount;
        const active = (count || 0) - expired;

        return {
            total: count || 0,
            active,
            expired,
            hitRate: active > 0 ? ((active / (count || 1)) * 100) : 0
        };

    } catch (error) {
        return { total: 0, active: 0, expired: 0, hitRate: 0, error: error.message };
    }
}

/**
 * Get time condition for SQL queries based on timeframe
 */
function getTimeCondition(timeframe) {
    const now = new Date();
    let hoursBack;
    
    switch (timeframe) {
        case '15m':
            hoursBack = 0.25;
            break;
        case '1h':
            hoursBack = 1;
            break;
        case '6h':
            hoursBack = 6;
            break;
        case '24h':
            hoursBack = 24;
            break;
        case '7d':
            hoursBack = 24 * 7;
            break;
        default:
            hoursBack = 1;
    }
    
    return new Date(now.getTime() - (hoursBack * 60 * 60 * 1000)).toISOString();
}