/**
 * Centralized collection and NFT utilities
 * Handles name resolution, metadata processing, and common NFT operations
 */

import { ethers } from 'ethers';
import { debugLog, debugWarn, criticalError } from './debugUtils';

/**
 * Configuration for marketplace scanning and display
 */
export const MARKETPLACE_CONFIG = {
    // Scan range for marketplace listings (configurable)
    MAX_LISTING_SCAN: parseInt(import.meta.env?.VITE_MAX_LISTING_SCAN) || 50,
    MIN_LISTING_SCAN: 1,
    
    // Contract call timeouts
    CONTRACT_CALL_TIMEOUT: 8000,
    METADATA_FETCH_TIMEOUT: 10000,
    
    // Cache settings
    CACHE_TTL: 24 * 60 * 60 * 1000, // 24 hours
    METADATA_CACHE_SIZE: 1000,
    
    // Concurrency limits
    MAX_CONCURRENT_METADATA_FETCHES: 3,
    MAX_CONCURRENT_CONTRACT_CALLS: 2,
    
    // Fallback settings - Updated with working gateways  
    DEFAULT_NFT_PLACEHOLDER: 'https://picsum.photos/seed/default/300/300',
    IPFS_GATEWAYS: [
        'https://ipfs.io/ipfs/',              // Official gateway - most reliable
        'https://dweb.link/ipfs/',            // Protocol Labs gateway
        'https://gateway.pinata.cloud/ipfs/', // Pinata gateway - good CORS support
        'https://w3s.link/ipfs/',             // Web3.Storage gateway
        'https://nftstorage.link/ipfs/',      // NFT.Storage gateway
        'https://4everland.io/ipfs/',         // 4everland gateway
    ]
};

/**
 * Cache for processed metadata to avoid reprocessing
 */
const metadataCache = new Map();

/**
 * Create a content-based signature for cache invalidation
 * @param {Object} data - Data to create signature for
 * @returns {string} Content signature
 */
export const createContentSignature = (data) => {
    try {
        // Create a signature based on significant fields
        const significantFields = {
            name: data.name,
            description: data.description,
            image: data.image,
            tokenId: data.tokenId,
            pricePerUnit: data.pricePerUnit,
            active: data.active,
            // Include metadata if present
            metadata: data.metadata ? {
                name: data.metadata.name,
                description: data.metadata.description,
                image: data.metadata.image
            } : null
        };
        
        // Create a simple hash of the stringified object
        const str = JSON.stringify(significantFields);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    } catch (error) {
        debugWarn('Error creating content signature:', error);
        return Date.now().toString();
    }
};

/**
 * Standardized BigInt handling for price calculations
 * @param {string|number|BigInt} value - Value to convert
 * @returns {string} Standardized string representation
 */
export const standardizeBigInt = (value) => {
    try {
        if (!value) return '0';
        
        // Handle different input types
        if (typeof value === 'string') {
            // Remove any non-numeric characters except decimal point
            const cleaned = value.replace(/[^\d.]/g, '');
            if (!cleaned || cleaned === '.') return '0';
            
            // Convert to BigInt if it's a whole number
            if (!cleaned.includes('.')) {
                return BigInt(cleaned).toString();
            }
            
            // For decimal numbers, convert to wei (18 decimals)
            const [whole, decimal = ''] = cleaned.split('.');
            const paddedDecimal = decimal.padEnd(18, '0').slice(0, 18);
            return BigInt(whole + paddedDecimal).toString();
        }
        
        if (typeof value === 'number') {
            return BigInt(Math.floor(value)).toString();
        }
        
        if (typeof value === 'bigint') {
            return value.toString();
        }
        
        // Try to convert object with toString method
        if (value && typeof value.toString === 'function') {
            return BigInt(value.toString()).toString();
        }
        
        return '0';
    } catch (error) {
        debugWarn('Error standardizing BigInt:', error, 'for value:', value);
        return '0';
    }
};

/**
 * Normalize metadata description with length trimming
 * @param {string} description - Raw description
 * @param {number} maxLength - Maximum length (default: 500)
 * @returns {string} Normalized description
 */
export const normalizeDescription = (description, maxLength = 500) => {
    if (!description || typeof description !== 'string') {
        return '';
    }
    
    // Trim whitespace and normalize line breaks
    let normalized = description.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Remove excessive line breaks (more than 2 consecutive)
    normalized = normalized.replace(/\n{3,}/g, '\n\n');
    
    // Trim to max length if needed
    if (normalized.length > maxLength) {
        // Try to cut at word boundary
        const cutPoint = normalized.lastIndexOf(' ', maxLength - 3);
        if (cutPoint > maxLength * 0.8) {
            normalized = normalized.substring(0, cutPoint) + '...';
        } else {
            normalized = normalized.substring(0, maxLength - 3) + '...';
        }
    }
    
    return normalized;
};

/**
 * Enhanced collection name resolution with smart fallbacks
 * @param {Object} listing - Listing object
 * @param {Object} contractInfo - Contract information
 * @returns {string} Resolved collection name
 */
export const resolveCollectionName = (listing, contractInfo = {}) => {
    // Priority order for name resolution
    const nameCandidates = [
        listing?.metadata?.name,
        listing?.name,
        listing?.title,
        contractInfo?.name,
        listing?.metadata?.collection?.name,
        listing?.collection?.name
    ].filter(Boolean);
    
    if (nameCandidates.length > 0) {
        // Use the first valid name, but apply smart filtering
        let chosenName = nameCandidates[0];
        
        // If the name is just a number or very generic, try the next option
        if (nameCandidates.length > 1) {
            const isGeneric = /^(#?\d+|NFT #?\d+|Token #?\d+|Untitled)$/i.test(chosenName);
            if (isGeneric && contractInfo?.name && contractInfo.name.length > 5) {
                chosenName = `${contractInfo.name} #${listing.tokenId}`;
            }
        }
        
        return chosenName;
    }
    
    // Enhanced fallback with contract heuristics
    if (listing?.nftContract) {
        const contractAddr = listing.nftContract;
        const shortAddr = `${contractAddr.slice(0, 6)}...${contractAddr.slice(-4)}`;
        
        // Try to create a more descriptive name
        if (contractInfo?.symbol && contractInfo.symbol.length > 2) {
            return `${contractInfo.symbol} #${listing.tokenId || '0'}`;
        }
        
        return `${shortAddr} #${listing.tokenId || '0'}`;
    }
    
    return `NFT #${listing.tokenId || '0'}`;
};

/**
 * Resolve IPFS URLs with multiple gateway fallbacks and retry logic
 * @param {string} uri - Original URI
 * @param {number} gatewayIndex - Which gateway to use (for fallback rotation)
 * @returns {string} Resolved HTTP URL
 */
export const resolveIPFSUrl = (uri, gatewayIndex = 0) => {
    if (!uri || typeof uri !== 'string') return uri;
    
    if (uri.startsWith('ipfs://')) {
        const hash = uri.replace('ipfs://', '');
        // Use specific gateway index, or default to first available
        const gateways = MARKETPLACE_CONFIG.IPFS_GATEWAYS;
        const gateway = gateways[gatewayIndex % gateways.length] || gateways[0];
        return `${gateway}${hash}`;
    }
    
    // Handle ar:// Arweave URIs
    if (uri.startsWith('ar://')) {
        const hash = uri.replace('ar://', '');
        return `https://arweave.net/${hash}`;
    }
    
    return uri;
};

/**
 * Fetch metadata with IPFS gateway rotation and retry logic
 * @param {string} uri - Metadata URI
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<Object>} Metadata object
 */
export const fetchMetadataWithFallback = async (uri, maxRetries = 3) => {
    if (!uri) throw new Error('No URI provided');
    
    const gateways = MARKETPLACE_CONFIG.IPFS_GATEWAYS;
    let lastError;
    
    // Try each gateway
    for (let gatewayIndex = 0; gatewayIndex < gateways.length && gatewayIndex < maxRetries; gatewayIndex++) {
        try {
            const resolvedUrl = resolveIPFSUrl(uri, gatewayIndex);
            
            debugLog(`🌐 Fetching metadata from ${resolvedUrl.split('/')[2]} (attempt ${gatewayIndex + 1}/${maxRetries})`);
            
            const response = await fetch(resolvedUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                },
                signal: AbortSignal.timeout(MARKETPLACE_CONFIG.METADATA_FETCH_TIMEOUT)
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const metadata = await response.json();
            debugLog(`✅ Successfully fetched metadata from ${resolvedUrl.split('/')[2]}`);
            return metadata;
            
        } catch (error) {
            lastError = error;
            debugWarn(`❌ Gateway ${gatewayIndex + 1} failed:`, error.message);
            
            // Don't retry on timeout or network errors for the same gateway
            if (error.name === 'TimeoutError' || error.name === 'TypeError') {
                continue;
            }
        }
    }
    
    throw new Error(`All IPFS gateways failed. Last error: ${lastError?.message || 'Unknown error'}`);
};

/**
 * Process and normalize NFT metadata
 * @param {Object} rawMetadata - Raw metadata from contract or IPFS
 * @param {string} contractAddress - Contract address
 * @param {string} tokenId - Token ID
 * @returns {Object} Normalized metadata
 */
export const normalizeNFTMetadata = (rawMetadata, contractAddress, tokenId) => {
    const cacheKey = `${contractAddress}-${tokenId}`;
    
    try {
        // Create base metadata structure
        const normalized = {
            name: '',
            description: '',
            image: null,
            imageUrl: null,
            attributes: [],
            collection: null,
            contractAddress: contractAddress,
            tokenId: tokenId,
            // Metadata flags
            loaded: true,
            loading: false,
            error: null,
            timestamp: Date.now()
        };
        
        if (!rawMetadata || typeof rawMetadata !== 'object') {
            // Use fallback metadata
            normalized.name = `NFT #${tokenId}`;
            normalized.description = 'Metadata unavailable';
            normalized.error = 'No metadata provided';
            return normalized;
        }
        
        // Process name
        normalized.name = rawMetadata.name || `NFT #${tokenId}`;
        
        // Process description with normalization
        normalized.description = normalizeDescription(rawMetadata.description);
        
        // Process image with IPFS resolution and fallback
        if (rawMetadata.image) {
            try {
                normalized.image = resolveIPFSUrl(rawMetadata.image);
                normalized.imageUrl = normalized.image;
            } catch (e) {
                debugWarn('Error resolving image URL:', e);
                normalized.image = MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
                normalized.imageUrl = normalized.image;
            }
        } else if (rawMetadata.image_url) {
            try {
                normalized.image = resolveIPFSUrl(rawMetadata.image_url);
                normalized.imageUrl = normalized.image;
            } catch (e) {
                debugWarn('Error resolving image_url:', e);
                normalized.image = MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
                normalized.imageUrl = normalized.image;
            }
        } else if (rawMetadata.imageUrl) {
            try {
                normalized.image = resolveIPFSUrl(rawMetadata.imageUrl);
                normalized.imageUrl = normalized.image;
            } catch (e) {
                debugWarn('Error resolving imageUrl:', e);
                normalized.image = MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
                normalized.imageUrl = normalized.image;
            }
        } else {
            // No image found, use placeholder
            normalized.image = MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
            normalized.imageUrl = normalized.image;
        }
        
        // Process attributes
        if (Array.isArray(rawMetadata.attributes)) {
            normalized.attributes = rawMetadata.attributes
                .filter(attr => attr && typeof attr === 'object')
                .map(attr => ({
                    trait_type: attr.trait_type || attr.name || 'Property',
                    value: attr.value !== undefined ? attr.value : attr.trait_value,
                    display_type: attr.display_type || null
                }))
                .filter(attr => attr.value !== undefined && attr.value !== null);
        } else if (rawMetadata.traits && Array.isArray(rawMetadata.traits)) {
            // Handle alternative traits format
            normalized.attributes = rawMetadata.traits
                .filter(trait => trait && typeof trait === 'object')
                .map(trait => ({
                    trait_type: trait.trait_type || trait.name || 'Property',
                    value: trait.value !== undefined ? trait.value : trait.trait_value,
                    display_type: trait.display_type || null
                }))
                .filter(attr => attr.value !== undefined && attr.value !== null);
        }
        
        // Process collection info
        if (rawMetadata.collection) {
            normalized.collection = {
                name: rawMetadata.collection.name || null,
                description: rawMetadata.collection.description || null,
                image: rawMetadata.collection.image ? resolveIPFSUrl(rawMetadata.collection.image) : null
            };
        }
        
        // Cache the normalized metadata
        metadataCache.set(cacheKey, {
            ...normalized,
            signature: createContentSignature(normalized)
        });
        
        return normalized;
        
    } catch (error) {
        criticalError('Error normalizing NFT metadata:', error);
        
        // Return fallback metadata on error
        return {
            name: `NFT #${tokenId}`,
            description: 'Error processing metadata',
            image: null,
            imageUrl: null,
            attributes: [],
            collection: null,
            contractAddress: contractAddress,
            tokenId: tokenId,
            loaded: true,
            loading: false,
            error: error.message || 'Processing error',
            timestamp: Date.now()
        };
    }
};

/**
 * Get cached metadata with signature validation
 * @param {string} contractAddress - Contract address
 * @param {string} tokenId - Token ID
 * @returns {Object|null} Cached metadata or null
 */
export const getCachedMetadata = (contractAddress, tokenId) => {
    const cacheKey = `${contractAddress}-${tokenId}`;
    const cached = metadataCache.get(cacheKey);
    
    if (!cached) return null;
    
    // Check if cache is still valid (24 hours)
    const isExpired = Date.now() - cached.timestamp > MARKETPLACE_CONFIG.CACHE_TTL;
    if (isExpired) {
        metadataCache.delete(cacheKey);
        return null;
    }
    
    return cached;
};

/**
 * Validate cache against new data using content signature
 * @param {Object} cachedData - Cached data
 * @param {Object} newData - New data to compare
 * @returns {boolean} True if cache is still valid
 */
export const isCacheValid = (cachedData, newData) => {
    if (!cachedData || !cachedData.signature) return false;
    
    const newSignature = createContentSignature(newData);
    return cachedData.signature === newSignature;
};

/**
 * Clean up old cache entries to prevent memory bloat
 */
export const cleanupMetadataCache = () => {
    const now = Date.now();
    const expiredKeys = [];
    
    for (const [key, data] of metadataCache.entries()) {
        if (now - data.timestamp > MARKETPLACE_CONFIG.CACHE_TTL) {
            expiredKeys.push(key);
        }
    }
    
    expiredKeys.forEach(key => metadataCache.delete(key));
    
    // If cache is still too large, remove oldest entries
    if (metadataCache.size > MARKETPLACE_CONFIG.METADATA_CACHE_SIZE) {
        const sortedEntries = Array.from(metadataCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        const toRemove = sortedEntries.slice(0, metadataCache.size - MARKETPLACE_CONFIG.METADATA_CACHE_SIZE);
        toRemove.forEach(([key]) => metadataCache.delete(key));
    }
    
    debugLog(`Cleaned up metadata cache, ${metadataCache.size} entries remaining`);
};

/**
 * Generate collection stats from listings data
 * @param {Array} listings - Array of listing objects
 * @returns {Object} Collection statistics
 */
export const generateCollectionStats = (listings) => {
    if (!Array.isArray(listings) || listings.length === 0) {
        return {
            totalListings: 0,
            uniqueCollections: 0,
            averagePrice: '0',
            totalVolume: '0',
            collections: {}
        };
    }
    
    const collections = {};
    let totalPriceSum = BigInt(0);
    let priceCount = 0;
    
    listings.forEach(listing => {
        try {
            const collectionName = resolveCollectionName(listing);
            const contractAddr = listing.nftContract || 'unknown';
            
            if (!collections[contractAddr]) {
                collections[contractAddr] = {
                    name: collectionName,
                    contractAddress: contractAddr,
                    listings: [],
                    totalVolume: BigInt(0),
                    floorPrice: null,
                    averagePrice: '0'
                };
            }
            
            collections[contractAddr].listings.push(listing);
            
            // Calculate price statistics
            if (listing.pricePerUnit) {
                const price = BigInt(standardizeBigInt(listing.pricePerUnit));
                collections[contractAddr].totalVolume += price;
                totalPriceSum += price;
                priceCount++;
                
                // Update floor price
                if (!collections[contractAddr].floorPrice || price < BigInt(collections[contractAddr].floorPrice)) {
                    collections[contractAddr].floorPrice = price.toString();
                }
            }
        } catch (error) {
            debugWarn('Error processing listing for collection stats:', error);
        }
    });
    
    // Calculate average prices for collections
    Object.values(collections).forEach(collection => {
        if (collection.listings.length > 0 && collection.totalVolume > 0) {
            collection.averagePrice = (collection.totalVolume / BigInt(collection.listings.length)).toString();
        }
    });
    
    return {
        totalListings: listings.length,
        uniqueCollections: Object.keys(collections).length,
        averagePrice: priceCount > 0 ? (totalPriceSum / BigInt(priceCount)).toString() : '0',
        totalVolume: totalPriceSum.toString(),
        collections
    };
};

/**
 * Utility to add component-specific CSS classes to prevent conflicts
 * @param {string} baseClass - Base CSS class
 * @param {string} component - Component name
 * @returns {string} Scoped CSS class
 */
export const scopedClass = (baseClass, component) => {
    return `${component}__${baseClass}`;
};

// Export configuration for external use
export { MARKETPLACE_CONFIG as config };

// Initialize cache cleanup interval
if (typeof window !== 'undefined') {
    setInterval(cleanupMetadataCache, 60 * 60 * 1000); // Clean every hour
}