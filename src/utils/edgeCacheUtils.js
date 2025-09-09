/**
 * Edge Cache Utils - Frontend utilities for instant metadata and image loading
 * 
 * Features:
 * - Cache-first metadata loading
 * - Proxy-based image URLs
 * - Placeholder generation
 * - Performance metrics
 * - Fallback handling
 */

import { debugLog, debugWarn, criticalError } from './debugUtils';

// Cache configuration
const CACHE_CONFIG = {
    METADATA_TTL: 6 * 60 * 60 * 1000, // 6 hours
    IMAGE_TTL: 24 * 60 * 60 * 1000,   // 24 hours
    PLACEHOLDER_FALLBACK: '#1a1a1a',   // Default dark color
    DEFAULT_NFT_PLACEHOLDER: 'https://via.placeholder.com/300x300/1a1a1a/fff?text=NFT'
};

// Feature flag for gradual rollout
const EDGE_CACHE_ENABLED = localStorage.getItem('edgeCache') !== 'false';

// In-memory cache for current session
const sessionCache = new Map();

/**
 * Get metadata with cache-first approach
 * @param {string} contractAddress - NFT contract address
 * @param {string} tokenId - Token ID
 * @param {boolean} useCache - Whether to use cache (default: true)
 * @returns {Promise<Object>} Normalized metadata object
 */
export const getCachedMetadata = async (contractAddress, tokenId, useCache = true) => {
    const cacheKey = `${contractAddress.toLowerCase()}-${tokenId}`;
    const startTime = Date.now();
    
    try {
        // Check session cache first for instant response
        if (useCache && sessionCache.has(cacheKey)) {
            const cached = sessionCache.get(cacheKey);
            if (!isExpired(cached.timestamp, CACHE_CONFIG.METADATA_TTL)) {
                debugLog(`✅ Session cache hit for metadata: ${cacheKey}`);
                return {
                    ...cached.metadata,
                    cached: true,
                    source: 'session',
                    latency: Date.now() - startTime
                };
            } else {
                sessionCache.delete(cacheKey);
            }
        }

        // Use edge cache API if enabled
        if (EDGE_CACHE_ENABLED && useCache) {
            try {
                const apiUrl = `/api/metadata-cache?contract=${contractAddress}&tokenId=${tokenId}`;
                const response = await fetch(apiUrl, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    cache: 'default' // Allow browser caching
                });

                if (response.ok) {
                    const metadata = await response.json();
                    
                    // Cache in session for instant subsequent access
                    sessionCache.set(cacheKey, {
                        metadata,
                        timestamp: Date.now()
                    });

                    debugLog(`✅ Edge cache response for metadata: ${cacheKey}`, {
                        cached: metadata.cached,
                        latency: metadata.latency
                    });

                    return {
                        ...metadata,
                        source: 'edge',
                        latency: Date.now() - startTime
                    };
                }
            } catch (error) {
                debugWarn(`Edge cache API failed for ${cacheKey}, falling back:`, error);
            }
        }

        // Fallback to legacy metadata loading
        debugLog(`📡 Falling back to legacy metadata loading for: ${cacheKey}`);
        const fallbackMetadata = await loadMetadataFallback(contractAddress, tokenId);
        
        // Cache the fallback result
        if (fallbackMetadata) {
            sessionCache.set(cacheKey, {
                metadata: fallbackMetadata,
                timestamp: Date.now()
            });
        }

        return {
            ...fallbackMetadata,
            source: 'fallback',
            latency: Date.now() - startTime
        };

    } catch (error) {
        criticalError('Metadata loading failed completely:', error);
        
        // Return fallback metadata to prevent crashes
        const fallbackMetadata = createFallbackMetadata(contractAddress, tokenId, error.message);
        return {
            ...fallbackMetadata,
            source: 'error',
            latency: Date.now() - startTime
        };
    }
};

/**
 * Get proxy image URL for instant loading
 * @param {string} imageUrl - Original image URL (IPFS, HTTP, etc.)
 * @param {boolean} placeholder - Return placeholder data instead of full image
 * @returns {Promise<string|Object>} Proxy URL or placeholder data
 */
export const getProxyImageUrl = async (imageUrl, placeholder = false) => {
    if (!imageUrl || imageUrl === CACHE_CONFIG.DEFAULT_NFT_PLACEHOLDER) {
        return placeholder ? 
            { dominantColor: CACHE_CONFIG.PLACEHOLDER_FALLBACK, type: 'fallback' } : 
            imageUrl;
    }

    try {
        // Use edge cache API if enabled
        if (EDGE_CACHE_ENABLED) {
            const placeholderParam = placeholder ? '&placeholder=true' : '';
            const apiUrl = `/api/image-proxy?url=${encodeURIComponent(imageUrl)}${placeholderParam}`;
            
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                cache: 'default'
            });

            if (response.ok) {
                const result = await response.json();
                
                if (placeholder) {
                    return result.placeholder || { 
                        dominantColor: CACHE_CONFIG.PLACEHOLDER_FALLBACK, 
                        type: 'fallback' 
                    };
                }
                
                return result.url || imageUrl;
            }
        }

        // Fallback to original URL
        if (placeholder) {
            return { 
                dominantColor: CACHE_CONFIG.PLACEHOLDER_FALLBACK, 
                type: 'fallback' 
            };
        }
        
        return imageUrl;

    } catch (error) {
        debugWarn('Image proxy failed, using original URL:', error);
        
        if (placeholder) {
            return { 
                dominantColor: CACHE_CONFIG.PLACEHOLDER_FALLBACK, 
                type: 'error' 
            };
        }
        
        return imageUrl;
    }
};

/**
 * Batch pre-warm metadata and images for multiple NFTs
 * @param {Array} nfts - Array of NFT objects with contractAddress and tokenId
 * @returns {Promise<Object>} Pre-warm results
 */
export const batchPrewarm = async (nfts) => {
    if (!EDGE_CACHE_ENABLED || !nfts || nfts.length === 0) {
        return { success: false, message: 'Pre-warming disabled or no NFTs provided' };
    }

    try {
        debugLog(`🔥 Starting batch pre-warm for ${nfts.length} NFTs`);
        
        const prewarmPromises = nfts.map(async (nft) => {
            try {
                const response = await fetch('/api/prewarm-cache', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contract: nft.contractAddress,
                        tokenId: nft.tokenId,
                        listingId: nft.listingId,
                        priority: 5
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    return { nft, success: true, jobId: result.jobId };
                } else {
                    return { nft, success: false, error: `HTTP ${response.status}` };
                }
            } catch (error) {
                return { nft, success: false, error: error.message };
            }
        });

        const results = await Promise.allSettled(prewarmPromises);
        const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        
        debugLog(`✅ Batch pre-warm completed: ${successful}/${nfts.length} successful`);
        
        return {
            success: true,
            total: nfts.length,
            successful,
            failed: nfts.length - successful,
            results: results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason })
        };

    } catch (error) {
        criticalError('Batch pre-warm failed:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Get cache performance metrics
 * @returns {Promise<Object>} Cache performance data
 */
export const getCacheMetrics = async () => {
    if (!EDGE_CACHE_ENABLED) {
        return { enabled: false };
    }

    try {
        const response = await fetch('/api/cache-metrics', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (response.ok) {
            return await response.json();
        }

        return { error: `HTTP ${response.status}` };
    } catch (error) {
        return { error: error.message };
    }
};

/**
 * Clear session cache (useful for debugging)
 */
export const clearSessionCache = () => {
    sessionCache.clear();
    debugLog('Session cache cleared');
};

/**
 * Enable/disable edge caching
 * @param {boolean} enabled - Whether to enable edge caching
 */
export const setEdgeCacheEnabled = (enabled) => {
    localStorage.setItem('edgeCache', enabled.toString());
    if (!enabled) {
        clearSessionCache();
    }
    debugLog(`Edge cache ${enabled ? 'enabled' : 'disabled'}`);
};

/**
 * Get current cache status
 * @returns {Object} Cache status information
 */
export const getCacheStatus = () => {
    return {
        edgeEnabled: EDGE_CACHE_ENABLED,
        sessionSize: sessionCache.size,
        sessionKeys: Array.from(sessionCache.keys())
    };
};

// Legacy metadata loading fallback
async function loadMetadataFallback(contractAddress, tokenId) {
    // Import the existing metadata loader if needed
    try {
        const { loadNFTMetadata } = await import('./metadataLoader');
        const { useWallet } = await import('../context/WalletContext');
        
        // This would need to be adapted based on your existing metadata loading logic
        // For now, return a basic fallback
        return createFallbackMetadata(contractAddress, tokenId, 'Legacy loader not available');
    } catch (error) {
        return createFallbackMetadata(contractAddress, tokenId, error.message);
    }
}

// Create fallback metadata when all else fails
function createFallbackMetadata(contractAddress, tokenId, errorMessage) {
    return {
        name: `NFT #${tokenId}`,
        description: `Token #${tokenId} from contract ${contractAddress}`,
        image: CACHE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        imageUrl: CACHE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        attributes: [],
        contractAddress: contractAddress.toLowerCase(),
        tokenId: tokenId.toString(),
        loaded: true,
        loading: false,
        error: errorMessage,
        timestamp: Date.now(),
        loadingStrategy: 'fallback'
    };
}

// Check if cached data is expired
function isExpired(timestamp, ttl) {
    return Date.now() - timestamp > ttl;
}

// Export configuration for testing
export const CACHE_CONFIG_EXPORT = CACHE_CONFIG;

export default {
    getCachedMetadata,
    getProxyImageUrl,
    batchPrewarm,
    getCacheMetrics,
    clearSessionCache,
    setEdgeCacheEnabled,
    getCacheStatus
};