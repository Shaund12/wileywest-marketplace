/**
 * Comprehensive metadata loading utility with IPFS gateway rotation and fallbacks
 * Handles NFT metadata loading with robust error handling and caching
 */

import { ethers } from 'ethers';
import { debugLog, debugWarn, criticalError } from './debugUtils';
import { fetchMetadataWithFallback, normalizeNFTMetadata, MARKETPLACE_CONFIG } from './nftUtils';

// Global metadata cache to prevent duplicate fetches
const metadataLoadingCache = new Map();
const metadataResultCache = new Map();

/**
 * Enhanced metadata loader with comprehensive fallback strategies
 * @param {string} contractAddress - NFT contract address
 * @param {string} tokenId - Token ID
 * @param {Object} provider - Ethers provider
 * @param {Object} existingMetadata - Any existing metadata to enhance
 * @returns {Promise<Object>} Normalized metadata object
 */
export const loadNFTMetadata = async (contractAddress, tokenId, provider, existingMetadata = null) => {
    // Validate inputs
    if (!contractAddress || contractAddress === 'undefined' || contractAddress === 'null') {
        debugWarn('Invalid contract address provided to loadNFTMetadata');
        return createFallbackMetadata(tokenId, 'Invalid contract address');
    }

    if (!tokenId && tokenId !== '0' && tokenId !== 0) {
        debugWarn('Invalid token ID provided to loadNFTMetadata');
        return createFallbackMetadata(tokenId, 'Invalid token ID');
    }

    const cacheKey = `${contractAddress.toLowerCase()}-${tokenId}`;
    
    // Check if we already have a result cached
    if (metadataResultCache.has(cacheKey)) {
        const cached = metadataResultCache.get(cacheKey);
        // Check if cache is still valid (30 minutes)
        if (Date.now() - cached.timestamp < 30 * 60 * 1000) {
            debugLog(`📦 Using cached metadata for ${contractAddress}:${tokenId}`);
            return cached.data;
        } else {
            metadataResultCache.delete(cacheKey);
        }
    }

    // Check if we're already loading this metadata
    if (metadataLoadingCache.has(cacheKey)) {
        debugLog(`⏳ Metadata loading in progress for ${contractAddress}:${tokenId}, waiting...`);
        return await metadataLoadingCache.get(cacheKey);
    }

    // Start loading metadata
    const loadingPromise = loadMetadataInternal(contractAddress, tokenId, provider, existingMetadata);
    metadataLoadingCache.set(cacheKey, loadingPromise);

    try {
        const result = await loadingPromise;
        
        // Cache the result
        metadataResultCache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });
        
        return result;
    } catch (error) {
        criticalError(`Failed to load metadata for ${contractAddress}:${tokenId}`, error);
        const fallback = createFallbackMetadata(tokenId, error.message);
        
        // Cache the fallback briefly to prevent repeated failures
        metadataResultCache.set(cacheKey, {
            data: fallback,
            timestamp: Date.now()
        });
        
        return fallback;
    } finally {
        metadataLoadingCache.delete(cacheKey);
    }
};

/**
 * Internal metadata loading logic with multiple strategies
 */
const loadMetadataInternal = async (contractAddress, tokenId, provider, existingMetadata) => {
    debugLog(`🔍 Loading metadata for ${contractAddress}:${tokenId}`);

    let metadata = null;
    let loadingStrategy = 'unknown';

    try {
        // Strategy 1: Use existing metadata if provided and valid
        if (existingMetadata && typeof existingMetadata === 'object') {
            debugLog(`📋 Using provided metadata for ${contractAddress}:${tokenId}`);
            metadata = existingMetadata;
            loadingStrategy = 'provided';
        }
        
        // Strategy 2: Try to fetch from contract if no existing metadata or metadata is incomplete
        if (!metadata || !metadata.name || !metadata.image) {
            try {
                debugLog(`🔗 Fetching metadata from contract for ${contractAddress}:${tokenId}`);
                metadata = await fetchMetadataFromContract(contractAddress, tokenId, provider);
                loadingStrategy = 'contract';
                debugLog(`✅ Successfully fetched metadata from contract`);
            } catch (contractError) {
                debugWarn(`Contract metadata fetch failed: ${contractError.message}`);
                
                // If we have partial existing metadata, use it
                if (existingMetadata && typeof existingMetadata === 'object') {
                    metadata = existingMetadata;
                    loadingStrategy = 'partial';
                }
            }
        }

        // Strategy 3: If still no metadata, create basic fallback
        if (!metadata) {
            debugLog(`📝 Creating fallback metadata for ${contractAddress}:${tokenId}`);
            metadata = createBasicMetadata(contractAddress, tokenId);
            loadingStrategy = 'fallback';
        }

        // Normalize and enhance the metadata
        const normalized = normalizeNFTMetadata(metadata, contractAddress, tokenId);
        
        // Add loading strategy info for debugging
        normalized.loadingStrategy = loadingStrategy;
        normalized.loadedAt = Date.now();

        debugLog(`✅ Metadata loaded successfully using ${loadingStrategy} strategy for ${contractAddress}:${tokenId}`);
        return normalized;

    } catch (error) {
        criticalError(`Error in metadata loading for ${contractAddress}:${tokenId}:`, error);
        throw error;
    }
};

/**
 * Fetch metadata directly from NFT contract
 */
const fetchMetadataFromContract = async (contractAddress, tokenId, provider) => {
    const ERC721_ABI = [
        'function tokenURI(uint256 tokenId) view returns (string)',
        'function uri(uint256 tokenId) view returns (string)', // ERC1155
        'function name() view returns (string)',
        'function symbol() view returns (string)'
    ];

    try {
        const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
        
        // Try to get token URI
        let tokenURI;
        try {
            tokenURI = await contract.tokenURI(tokenId);
        } catch {
            // Fallback to ERC1155 URI method
            try {
                tokenURI = await contract.uri(tokenId);
            } catch {
                throw new Error('No tokenURI or uri method available');
            }
        }

        if (!tokenURI || tokenURI === '') {
            throw new Error('Empty tokenURI returned');
        }

        debugLog(`🌐 Fetching metadata from URI: ${tokenURI}`);

        // If it's a data URI, parse it directly
        if (tokenURI.startsWith('data:')) {
            const jsonString = tokenURI.split(',')[1];
            const decodedData = atob(jsonString);
            return JSON.parse(decodedData);
        }

        // If it's an HTTP/HTTPS URI, fetch directly
        if (tokenURI.startsWith('http://') || tokenURI.startsWith('https://')) {
            const response = await fetch(tokenURI, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(MARKETPLACE_CONFIG.METADATA_FETCH_TIMEOUT)
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
        }

        // If it's an IPFS URI, use our enhanced fetcher with fallbacks
        if (tokenURI.startsWith('ipfs://') || tokenURI.includes('/ipfs/')) {
            return await fetchMetadataWithFallback(tokenURI);
        }

        throw new Error(`Unsupported URI format: ${tokenURI}`);

    } catch (error) {
        debugWarn(`Contract metadata fetch failed for ${contractAddress}:${tokenId}: ${error.message}`);
        throw error;
    }
};

/**
 * Create basic fallback metadata when no other source is available
 */
const createBasicMetadata = (contractAddress, tokenId) => {
    return {
        name: `NFT #${tokenId}`,
        description: `Token #${tokenId} from contract ${contractAddress}`,
        image: MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        attributes: [],
        contractAddress: contractAddress,
        tokenId: tokenId
    };
};

/**
 * Create fallback metadata with error information
 */
const createFallbackMetadata = (tokenId, errorMessage) => {
    return {
        name: `NFT #${tokenId || 'Unknown'}`,
        description: `Metadata unavailable: ${errorMessage}`,
        image: MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        imageUrl: MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        attributes: [],
        collection: null,
        contractAddress: null,
        tokenId: tokenId || 'Unknown',
        loaded: true,
        loading: false,
        error: errorMessage,
        timestamp: Date.now(),
        loadingStrategy: 'error_fallback'
    };
};

/**
 * Enhanced image URL resolver with multiple fallback strategies
 * @param {string} imageUrl - Original image URL
 * @param {number} retryCount - Current retry attempt
 * @returns {Promise<string>} Working image URL or placeholder
 */
export const resolveImageUrl = async (imageUrl, retryCount = 0) => {
    if (!imageUrl || typeof imageUrl !== 'string') {
        return MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
    }

    // If it's already an HTTP URL, test if it works
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        try {
            const response = await fetch(imageUrl, { 
                method: 'HEAD',
                signal: AbortSignal.timeout(5000)
            });
            if (response.ok) {
                return imageUrl;
            }
        } catch {
            // Continue to IPFS resolution if HTTP fails
        }
    }

    // Handle IPFS URLs with gateway rotation
    if (imageUrl.startsWith('ipfs://') || imageUrl.includes('/ipfs/')) {
        const gateways = MARKETPLACE_CONFIG.IPFS_GATEWAYS;
        const maxRetries = Math.min(retryCount + 1, gateways.length);

        for (let i = 0; i < maxRetries; i++) {
            try {
                let hash = imageUrl;
                if (imageUrl.startsWith('ipfs://')) {
                    hash = imageUrl.replace('ipfs://', '');
                } else if (imageUrl.includes('/ipfs/')) {
                    hash = imageUrl.split('/ipfs/')[1];
                }

                const gateway = gateways[i];
                const resolvedUrl = `${gateway}${hash}`;

                // Test if the URL works
                const response = await fetch(resolvedUrl, { 
                    method: 'HEAD',
                    signal: AbortSignal.timeout(5000)
                });

                if (response.ok) {
                    debugLog(`✅ Image resolved via ${gateway.split('/')[2]}`);
                    return resolvedUrl;
                }
            } catch (error) {
                debugWarn(`Gateway ${i + 1} failed for image: ${error.message}`);
                continue;
            }
        }
    }

    // Handle Arweave URLs
    if (imageUrl.startsWith('ar://')) {
        const hash = imageUrl.replace('ar://', '');
        return `https://arweave.net/${hash}`;
    }

    // If all else fails, return placeholder
    debugWarn(`Could not resolve image URL: ${imageUrl}, using placeholder`);
    return MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
};

/**
 * Cleanup old cache entries to prevent memory leaks
 */
export const cleanupMetadataCache = () => {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    // Clean result cache
    for (const [key, cached] of metadataResultCache.entries()) {
        if (now - cached.timestamp > maxAge) {
            metadataResultCache.delete(key);
        }
    }

    // Clean loading cache (should be empty but just in case)
    metadataLoadingCache.clear();

    debugLog(`🧹 Cleaned metadata cache, ${metadataResultCache.size} entries remaining`);
};

// Set up periodic cache cleanup
if (typeof window !== 'undefined') {
    setInterval(cleanupMetadataCache, 30 * 60 * 1000); // Every 30 minutes
}

export default {
    loadNFTMetadata,
    resolveImageUrl,
    cleanupMetadataCache
};