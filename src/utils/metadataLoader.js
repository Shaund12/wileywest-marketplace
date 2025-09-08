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
 * Ultra-fast metadata loader optimized for custom blockchain performance
 * @param {string} contractAddress - NFT contract address
 * @param {string} tokenId - Token ID
 * @param {Object} provider - Ethers provider
 * @param {Object} existingMetadata - Any existing metadata to enhance
 * @returns {Promise<Object>} Normalized metadata object
 */
export const loadNFTMetadata = async (contractAddress, tokenId, provider, existingMetadata = null) => {
    // Validate inputs
    if (!contractAddress || contractAddress === 'undefined' || contractAddress === 'null') {
        return createFallbackMetadata(tokenId, 'Invalid contract address');
    }

    if (!tokenId && tokenId !== '0' && tokenId !== 0) {
        return createFallbackMetadata(tokenId, 'Invalid token ID');
    }

    const cacheKey = `${contractAddress.toLowerCase()}-${tokenId}`;
    
    // Check if we already have a result cached (extended cache time for better performance)
    if (metadataResultCache.has(cacheKey)) {
        const cached = metadataResultCache.get(cacheKey);
        // Extended cache time to 2 hours for better performance
        if (Date.now() - cached.timestamp < 2 * 60 * 60 * 1000) {
            return cached.data;
        } else {
            metadataResultCache.delete(cacheKey);
        }
    }

    // Check if we're already loading this metadata
    if (metadataLoadingCache.has(cacheKey)) {
        return await metadataLoadingCache.get(cacheKey);
    }

    // Start loading metadata with optimized performance
    const loadingPromise = loadMetadataInternal(contractAddress, tokenId, provider, existingMetadata);
    metadataLoadingCache.set(cacheKey, loadingPromise);

    try {
        const result = await loadingPromise;
        
        // Cache the result for longer period
        metadataResultCache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });
        
        return result;
    } catch (error) {
        const fallback = createFallbackMetadata(tokenId, error.message);
        
        // Cache the fallback for shorter period to retry sooner
        metadataResultCache.set(cacheKey, {
            data: fallback,
            timestamp: Date.now() - (60 * 60 * 1000) // Cache for only 1 hour to retry sooner
        });
        
        return fallback;
    } finally {
        metadataLoadingCache.delete(cacheKey);
    }
};

/**
 * Ultra-fast internal metadata loading optimized for custom blockchain
 */
const loadMetadataInternal = async (contractAddress, tokenId, provider, existingMetadata) => {
    let metadata = null;
    let loadingStrategy = 'unknown';

    try {
        // Strategy 1: Use existing metadata if provided and complete
        if (existingMetadata?.name && existingMetadata?.image) {
            metadata = existingMetadata;
            loadingStrategy = 'provided';
        }
        
        // Strategy 2: Fast contract fetch with aggressive timeout (only if no existing metadata)
        else if (!metadata) {
            try {
                metadata = await fetchMetadataFromContract(contractAddress, tokenId, provider);
                loadingStrategy = 'contract';
            } catch (contractError) {
                // Quick fallback to basic metadata
                metadata = createBasicMetadata(contractAddress, tokenId);
                loadingStrategy = 'fallback';
            }
        }

        // Strategy 3: Final fallback if nothing else worked
        if (!metadata) {
            metadata = createBasicMetadata(contractAddress, tokenId);
            loadingStrategy = 'emergency_fallback';
        }

        // Fast normalize without extensive processing
        const normalized = fastNormalizeMetadata(metadata, contractAddress, tokenId);
        normalized.loadingStrategy = loadingStrategy;
        normalized.loadedAt = Date.now();

        return normalized;

    } catch (error) {
        // Emergency fallback - don't throw errors for metadata loading
        return createFallbackMetadata(tokenId, error.message);
    }
};

/**
 * Ultra-fast metadata fetch from contract with aggressive timeouts
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
        
        // Ultra-fast token URI fetch with aggressive timeout
        let tokenURI;
        try {
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('tokenURI timeout')), 3000)); // Super fast timeout
            const uriPromise = contract.tokenURI(tokenId);
            tokenURI = await Promise.race([uriPromise, timeoutPromise]);
        } catch {
            // Quick fallback to ERC1155
            try {
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('uri timeout')), 3000));
                const uriPromise = contract.uri(tokenId);
                tokenURI = await Promise.race([uriPromise, timeoutPromise]);
            } catch {
                throw new Error('No URI method available');
            }
        }

        if (!tokenURI || tokenURI === '') {
            throw new Error('Empty tokenURI returned');
        }

        // Fast metadata fetch with aggressive timeout
        return await fastFetchMetadata(tokenURI);

    } catch (error) {
        throw error;
    }
};

/**
 * Ultra-fast metadata fetch with minimal fallback attempts
 */
const fastFetchMetadata = async (tokenURI) => {
    // Handle data URIs instantly
    if (tokenURI.startsWith('data:')) {
        const jsonString = tokenURI.split(',')[1];
        const decodedData = atob(jsonString);
        return JSON.parse(decodedData);
    }

    // For HTTP URLs, try direct fetch with short timeout
    if (tokenURI.startsWith('http://') || tokenURI.startsWith('https://')) {
        const response = await fetch(tokenURI, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(4000) // Super fast timeout
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        return await response.json();
    }

    // For IPFS, try only the first 2 fastest gateways for speed
    if (tokenURI.startsWith('ipfs://') || tokenURI.includes('/ipfs/')) {
        const hash = tokenURI.startsWith('ipfs://') 
            ? tokenURI.replace('ipfs://', '') 
            : tokenURI.split('/ipfs/')[1];

        // Only try top 2 fastest gateways for performance
        const fastGateways = [
            'https://ipfs.io/ipfs/',
            'https://dweb.link/ipfs/'
        ];

        for (const gateway of fastGateways) {
            try {
                const response = await fetch(`${gateway}${hash}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(4000) // Fast timeout
                });
                
                if (response.ok) {
                    return await response.json();
                }
            } catch {
                continue; // Try next gateway
            }
        }
        
        throw new Error('IPFS fetch failed');
    }

    throw new Error(`Unsupported URI format: ${tokenURI}`);
};

/**
 * Ultra-fast metadata normalization without heavy processing
 */
const fastNormalizeMetadata = (metadata, contractAddress, tokenId) => {
    // Quick validation and normalization
    const normalized = {
        name: metadata?.name || `NFT #${tokenId}`,
        description: metadata?.description || '',
        image: metadata?.image || metadata?.imageUrl || MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        imageUrl: metadata?.image || metadata?.imageUrl || MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        attributes: metadata?.attributes || metadata?.traits || [],
        contractAddress: contractAddress,
        tokenId: tokenId,
        loaded: true,
        loading: false,
        error: null,
        timestamp: Date.now()
    };

    // Quick IPFS resolution for images (only if needed)
    if (normalized.image && (normalized.image.startsWith('ipfs://') || normalized.image.includes('/ipfs/'))) {
        normalized.image = fastResolveIPFS(normalized.image);
        normalized.imageUrl = normalized.image;
    }

    return normalized;
};

/**
 * Ultra-fast IPFS resolution using only the fastest gateway
 */
const fastResolveIPFS = (ipfsUrl) => {
    if (!ipfsUrl) return MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
    
    let hash = ipfsUrl;
    if (ipfsUrl.startsWith('ipfs://')) {
        hash = ipfsUrl.replace('ipfs://', '');
    } else if (ipfsUrl.includes('/ipfs/')) {
        hash = ipfsUrl.split('/ipfs/')[1];
    }
    
    // Use only the fastest gateway for immediate display
    return `https://ipfs.io/ipfs/${hash}`;
};

/**
 * Create basic fallback metadata when no other source is available
 */
const createBasicMetadata = (contractAddress, tokenId) => {
    return {
        name: `NFT #${tokenId}`,
        description: `Token #${tokenId} from contract ${contractAddress}`,
        image: MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        imageUrl: MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER,
        attributes: [],
        contractAddress: contractAddress,
        tokenId: tokenId,
        loaded: true,
        loading: false,
        error: null
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
 * Ultra-fast parallel metadata loading for multiple NFTs
 * @param {Array} nfts - Array of NFT objects to load metadata for
 * @param {Object} provider - Ethers provider
 * @param {number} batchSize - Number of NFTs to process in parallel (increased for speed)
 * @returns {Promise<Array>} Array of NFTs with loaded metadata
 */
export const batchLoadMetadata = async (nfts, provider, batchSize = 15) => {
    if (!nfts || nfts.length === 0) return [];

    const results = [];
    
    // Process in larger batches for better performance
    for (let i = 0; i < nfts.length; i += batchSize) {
        const batch = nfts.slice(i, i + batchSize);
        
        // Process all NFTs in the batch in parallel with timeout protection
        const batchPromises = batch.map(async (nft) => {
            try {
                // Set a timeout for each metadata load to prevent hanging
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Metadata load timeout')), 5000)
                );
                
                const metadataPromise = loadNFTMetadata(
                    nft.contractAddress, 
                    nft.tokenId, 
                    provider, 
                    nft.metadata || null
                );
                
                const metadata = await Promise.race([metadataPromise, timeoutPromise]);
                
                return {
                    ...nft,
                    metadata: metadata
                };
            } catch (error) {
                // Return NFT with fallback metadata instead of failing
                return {
                    ...nft,
                    metadata: createFallbackMetadata(nft.tokenId, error.message)
                };
            }
        });
        
        // Wait for all in the batch to complete
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Add successful results
        batchResults.forEach(result => {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            }
        });
        
        // Small delay between batches to prevent overwhelming the network
        if (i + batchSize < nfts.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    return results;
};

/**
 * Ultra-fast image URL resolution optimized for Vitruveo blockchain
 * @param {string} imageUrl - Image URL to resolve
 * @param {number} retryCount - Number of retries attempted (for gateway rotation)
 * @returns {Promise<string>} Resolved image URL or fallback
 */
export const resolveImageUrl = async (imageUrl, retryCount = 0) => {
    if (!imageUrl || typeof imageUrl !== 'string') {
        return MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
    }

    // If it's already an HTTP URL, test if it works with fast timeout
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        try {
            const response = await fetch(imageUrl, { 
                method: 'HEAD',
                signal: AbortSignal.timeout(3000) // Fast timeout for better performance
            });
            if (response.ok) {
                return imageUrl;
            }
        } catch {
            // Continue to IPFS resolution if HTTP fails
        }
    }

    // Handle IPFS URLs with minimal gateway attempts for speed
    if (imageUrl.startsWith('ipfs://') || imageUrl.includes('/ipfs/')) {
        // Use only top 2 fastest gateways for performance (same as fastResolveIPFS)
        const fastGateways = [
            'https://ipfs.io/ipfs/',
            'https://dweb.link/ipfs/'
        ];
        
        const maxRetries = Math.min(retryCount + 1, fastGateways.length);

        for (let i = 0; i < maxRetries; i++) {
            try {
                let hash = imageUrl;
                if (imageUrl.startsWith('ipfs://')) {
                    hash = imageUrl.replace('ipfs://', '');
                } else if (imageUrl.includes('/ipfs/')) {
                    hash = imageUrl.split('/ipfs/')[1];
                }

                const gateway = fastGateways[i];
                const resolvedUrl = `${gateway}${hash}`;

                // Test if the URL works with fast timeout
                const response = await fetch(resolvedUrl, { 
                    method: 'HEAD',
                    signal: AbortSignal.timeout(3000) // Fast timeout
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