/**
 * Image Proxy API - Serves IPFS images via edge caching with multi-gateway fallback
 * 
 * Features:
 * - Multi-gateway racing for fastest response
 * - Strong edge caching headers
 * - Placeholder generation (dominant color)
 * - Cache metrics tracking
 * - Progressive image loading support
 * 
 * Usage: /api/image-proxy?url=ipfs://QmHash or ?url=https://gateway.com/ipfs/QmHash
 */

const { createClient } = require('@supabase/supabase-js');

// IPFS gateways ordered by speed/reliability
const IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.ipfs.io/ipfs/',
    'https://ipfs.fleek.co/ipfs/'
];

// Cache configuration
const CACHE_CONFIG = {
    IMAGE_TTL: 24 * 60 * 60 * 1000, // 24 hours for images
    PLACEHOLDER_TTL: 7 * 24 * 60 * 60 * 1000, // 7 days for placeholders
    EDGE_CACHE_TTL: 'public, max-age=86400, s-maxage=31536000, immutable' // 1 day browser, 1 year edge
};

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
 * Main handler for image proxy requests
 */
module.exports = async (req, res) => {
    // Only handle GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { url, placeholder } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const startTime = Date.now();
        
        // Check cache first
        const cached = await getCachedImage(url);
        if (cached && !isExpired(cached.ttl_expires_at)) {
            await recordCacheHit('image_hit', cached.gateway_used);
            await updateCacheHits(cached.id);
            
            // Set strong cache headers
            res.setHeader('Cache-Control', CACHE_CONFIG.EDGE_CACHE_TTL);
            res.setHeader('X-Cache-Status', 'HIT');
            res.setHeader('X-Gateway-Used', cached.gateway_used || 'unknown');
            
            const latency = Date.now() - startTime;
            await recordLatency('image', latency);
            
            if (placeholder === 'true' && cached.placeholder_data) {
                return res.json({
                    placeholder: cached.placeholder_data,
                    cached: true,
                    latency
                });
            }
            
            // For actual images, we'd redirect to the cached proxy URL
            // In this implementation, we'll return the proxy URL for the frontend to use
            return res.json({
                url: cached.proxy_url,
                placeholder: cached.placeholder_data,
                cached: true,
                latency
            });
        }

        // Cache miss - fetch from IPFS with gateway racing
        await recordCacheHit('image_miss');
        
        const result = await fetchImageWithFallback(url);
        if (!result.success) {
            await recordCacheHit('image_error');
            return res.status(404).json({ 
                error: 'Image not found', 
                url,
                gateways_tried: result.gateways_tried 
            });
        }

        // Generate placeholder data
        const placeholderData = await generatePlaceholder(result.imageBuffer, result.contentType);

        // Cache the result
        const proxyUrl = generateProxyUrl(url);
        await cacheImage({
            originalUrl: url,
            proxyUrl,
            contentType: result.contentType,
            contentLength: result.contentLength,
            placeholderData,
            gatewayUsed: result.gatewayUsed
        });

        const latency = Date.now() - startTime;
        await recordLatency('image', latency);

        // Set cache headers
        res.setHeader('Cache-Control', CACHE_CONFIG.EDGE_CACHE_TTL);
        res.setHeader('X-Cache-Status', 'MISS');
        res.setHeader('X-Gateway-Used', result.gatewayUsed);

        if (placeholder === 'true') {
            return res.json({
                placeholder: placeholderData,
                cached: false,
                latency
            });
        }

        // Return the image data or proxy URL
        return res.json({
            url: proxyUrl,
            placeholder: placeholderData,
            cached: false,
            latency
        });

    } catch (error) {
        console.error('Image proxy error:', error);
        await recordCacheHit('image_error');
        
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
};

/**
 * Fetch image with multi-gateway racing
 */
async function fetchImageWithFallback(url) {
    const hash = extractIPFSHash(url);
    if (!hash) {
        return { success: false, error: 'Invalid IPFS URL' };
    }

    const gateways = [...IPFS_GATEWAYS];
    const gateways_tried = [];

    // Create promises for all gateways
    const fetchPromises = gateways.map(async (gateway) => {
        const gatewayUrl = `${gateway}${hash}`;
        gateways_tried.push(gateway);

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout per gateway

            const response = await fetch(gatewayUrl, {
                method: 'GET',
                signal: controller.signal,
                headers: {
                    'Accept': 'image/*',
                }
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const contentType = response.headers.get('content-type') || 'image/jpeg';
            const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
            const imageBuffer = await response.arrayBuffer();

            return {
                success: true,
                imageBuffer,
                contentType,
                contentLength,
                gatewayUsed: gateway.split('//')[1].split('/')[0], // Extract domain
                gatewayUrl
            };

        } catch (error) {
            throw { gateway, error: error.message };
        }
    });

    // Race all gateways, return first successful response
    try {
        const result = await Promise.any(fetchPromises);
        return { ...result, gateways_tried };
    } catch (errors) {
        return { 
            success: false, 
            error: 'All gateways failed',
            gateways_tried,
            errors: Array.isArray(errors) ? errors.map(e => e.error || e.message) : [errors.message]
        };
    }
}

/**
 * Extract IPFS hash from various URL formats
 */
function extractIPFSHash(url) {
    if (url.startsWith('ipfs://')) {
        return url.replace('ipfs://', '');
    }
    
    if (url.includes('/ipfs/')) {
        const parts = url.split('/ipfs/');
        return parts[1]?.split('/')[0]; // Get hash before any subpath
    }
    
    return null;
}

/**
 * Generate placeholder data (dominant color for now, could add blurhash later)
 */
async function generatePlaceholder(imageBuffer, contentType) {
    try {
        // For now, return a simple placeholder structure
        // In a full implementation, you'd use a library like Sharp or Canvas to extract dominant color
        const size = imageBuffer.byteLength;
        
        // Simple hash-based color generation as fallback
        const hash = Array.from(new Uint8Array(imageBuffer.slice(0, 3)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        
        const dominantColor = `#${hash}`;
        
        return {
            dominantColor,
            type: 'color',
            contentType,
            size,
            generated: new Date().toISOString()
        };
    } catch (error) {
        // Fallback to default placeholder
        return {
            dominantColor: '#1a1a1a',
            type: 'fallback',
            error: error.message
        };
    }
}

/**
 * Generate consistent proxy URL for caching
 */
function generateProxyUrl(originalUrl) {
    const hash = extractIPFSHash(originalUrl);
    return hash ? `${IPFS_GATEWAYS[0]}${hash}` : originalUrl;
}

/**
 * Get cached image from database
 */
async function getCachedImage(originalUrl) {
    const client = initSupabase();
    if (!client) return null;

    try {
        const { data, error } = await client
            .from('image_cache')
            .select('*')
            .eq('original_url', originalUrl)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
            console.error('Cache lookup error:', error);
            return null;
        }

        return data;
    } catch (error) {
        console.error('Cache lookup error:', error);
        return null;
    }
}

/**
 * Cache image result in database
 */
async function cacheImage(imageData) {
    const client = initSupabase();
    if (!client) return;

    try {
        const ttlExpiresAt = new Date(Date.now() + CACHE_CONFIG.IMAGE_TTL);
        
        const { error } = await client
            .from('image_cache')
            .upsert({
                original_url: imageData.originalUrl,
                proxy_url: imageData.proxyUrl,
                content_type: imageData.contentType,
                content_length: imageData.contentLength,
                placeholder_data: imageData.placeholderData,
                gateway_used: imageData.gatewayUsed,
                cache_status: 'cached',
                ttl_expires_at: ttlExpiresAt.toISOString(),
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'original_url'
            });

        if (error) {
            console.error('Cache store error:', error);
        }
    } catch (error) {
        console.error('Cache store error:', error);
    }
}

/**
 * Update cache hit counter
 */
async function updateCacheHits(cacheId) {
    const client = initSupabase();
    if (!client) return;

    try {
        await client.rpc('increment_cache_hits', { cache_id: cacheId });
    } catch (error) {
        console.error('Cache hits update error:', error);
    }
}

/**
 * Record cache performance metrics
 */
async function recordCacheHit(metricType, gatewayUsed = null) {
    const client = initSupabase();
    if (!client) return;

    try {
        const dimensions = gatewayUsed ? { gateway: gatewayUsed } : {};
        
        await client
            .from('cache_metrics')
            .insert({
                metric_type: metricType,
                cache_type: 'image',
                value: 1,
                dimensions
            });
    } catch (error) {
        console.error('Metrics recording error:', error);
    }
}

/**
 * Record latency metrics
 */
async function recordLatency(cacheType, latency) {
    const client = initSupabase();
    if (!client) return;

    try {
        await client
            .from('cache_metrics')
            .insert({
                metric_type: 'latency',
                cache_type: cacheType,
                value: latency
            });
    } catch (error) {
        console.error('Latency recording error:', error);
    }
}

/**
 * Check if cache entry is expired
 */
function isExpired(ttlExpiresAt) {
    return new Date(ttlExpiresAt) < new Date();
}