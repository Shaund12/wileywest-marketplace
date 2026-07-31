/**
 * Comprehensive metadata loading utility with IPFS gateway rotation and fallbacks
 * Handles NFT metadata loading with robust error handling and caching
 */

import { ethers } from 'ethers';
import { debugLog, debugWarn, criticalError } from './debugUtils';
import { fetchMetadataWithFallback, normalizeNFTMetadata } from './nftUtils';
import { getReadProvider } from './networkUtils';

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
    console.log(`🔍 [LOAD NFT] Starting loadNFTMetadata for ${contractAddress}:${tokenId}`);
    
    // Validate inputs
    if (!contractAddress || contractAddress === 'undefined' || contractAddress === 'null') {
        console.log(`❌ [LOAD NFT] Invalid contract address: ${contractAddress}`);
        return createFallbackMetadata(tokenId, 'Invalid contract address');
    }

    if (!tokenId && tokenId !== '0' && tokenId !== 0) {
        console.log(`❌ [LOAD NFT] Invalid token ID: ${tokenId}`);
        return createFallbackMetadata(tokenId, 'Invalid token ID');
    }

    const cacheKey = `${contractAddress.toLowerCase()}-${tokenId}`;
    console.log(`🔑 [LOAD NFT] Cache key: ${cacheKey}`);
    
    // Check if we already have a result cached (extended cache time for better performance)
    if (metadataResultCache.has(cacheKey)) {
        const cached = metadataResultCache.get(cacheKey);
        // Extended cache time to 2 hours for better performance
        if (Date.now() - cached.timestamp < 2 * 60 * 60 * 1000) {
            console.log(`✅ [LOAD NFT] Returning cached result for ${cacheKey}`);
            return cached.data;
        } else {
            console.log(`🕒 [LOAD NFT] Cache expired for ${cacheKey}, removing`);
            metadataResultCache.delete(cacheKey);
        }
    }

    // Check if we're already loading this metadata
    if (metadataLoadingCache.has(cacheKey)) {
        console.log(`⏳ [LOAD NFT] Already loading ${cacheKey}, waiting for existing promise`);
        return await metadataLoadingCache.get(cacheKey);
    }

    console.log(`🚀 [LOAD NFT] Starting fresh load for ${cacheKey}`);
    // Start loading metadata with optimized performance
    const loadingPromise = loadMetadataInternal(contractAddress, tokenId, provider, existingMetadata);
    metadataLoadingCache.set(cacheKey, loadingPromise);

    try {
        const result = await loadingPromise;
        console.log(`✅ [LOAD NFT] Successfully loaded metadata for ${cacheKey}:`, result);
        
        // Cache the result for longer period
        metadataResultCache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });
        
        return result;
    } catch (error) {
        console.error(`❌ [LOAD NFT] Failed to load metadata for ${cacheKey}:`, error);
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
                // Before giving up, ask the backend. It resolves tokenURI across
                // every configured chain and caches the result, so it succeeds
                // in cases where the browser-side read times out or hits the
                // wrong chain. Falling straight through to createBasicMetadata
                // here is what put a picsum.photos stock image on NFTs whose
                // real metadata was available all along.
                try {
                    metadata = await fetchMetadataFromApi(contractAddress, tokenId);
                    loadingStrategy = 'api';
                } catch {
                    metadata = createBasicMetadata(contractAddress, tokenId);
                    loadingStrategy = 'fallback';
                }
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
        // Always read tokenURI through the RPC proxy, never the caller's wallet
        // provider. MetaMask relays eth_call to whatever RPC its network is
        // configured with, which times out often enough that tokenURI failed
        // and every affected NFT rendered the generated SVG placeholder
        // instead of its real image. The proxy caches and coalesces these
        // calls and fails over to the explorer RPC.
        const readProvider = getReadProvider() || provider;
        const contract = new ethers.Contract(contractAddress, ERC721_ABI, readProvider);

        // Optimized token URI fetch with Vitruveo-appropriate timeout
        let tokenURI;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000); // Increased timeout for Vitruveo
            
            try {
                const uriPromise = contract.tokenURI(tokenId);
                tokenURI = await Promise.race([uriPromise, new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('tokenURI timeout')), 8000))]);
                clearTimeout(timeoutId);
            } catch (error) {
                clearTimeout(timeoutId);
                throw error;
            }
        } catch {
            // Fallback to ERC1155
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);
                
                try {
                    const uriPromise = contract.uri(tokenId);
                    tokenURI = await Promise.race([uriPromise, new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('uri timeout')), 8000))]);
                    clearTimeout(timeoutId);
                } catch (error) {
                    clearTimeout(timeoutId);
                    throw error;
                }
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        try {
            const response = await fetch(tokenURI, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    // For IPFS, try only the first 2 fastest gateways for speed
    if (tokenURI.startsWith('ipfs://') || tokenURI.includes('/ipfs/')) {
        const hash = tokenURI.startsWith('ipfs://') 
            ? tokenURI.replace('ipfs://', '') 
            : tokenURI.split('/ipfs/')[1];

        // Use more reliable IPFS gateways for better success rate
        const reliableGateways = [
            '/api/ipfs/ipfs/',
            'https://ipfs.io/ipfs/',
            'https://dweb.link/ipfs/',
        ];

        for (const gateway of reliableGateways) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                
                try {
                    const response = await fetch(`${gateway}${hash}`, {
                        method: 'GET',
                        headers: { 'Accept': 'application/json' },
                        signal: controller.signal
                    });
                    
                    clearTimeout(timeoutId);
                    
                    if (response.ok) {
                        return await response.json();
                    }
                } catch (fetchError) {
                    clearTimeout(timeoutId);
                    throw fetchError;
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
    const image = metadata?.image || metadata?.imageUrl || null;
    // Quick validation and normalization
    const normalized = {
        name: metadata?.name || `NFT #${tokenId}`,
        description: metadata?.description || '',
        image,
        imageUrl: image,
        attributes: metadata?.attributes || metadata?.traits || [],
        contractAddress: contractAddress,
        tokenId: tokenId,
        loaded: true,
        loading: false,
        error: metadata?.error || null,
        metadataState: metadata?.metadataState || (image ? 'loaded' : 'missing_image'),
        failureProvenance: metadata?.failureProvenance || (image ? null : 'metadata_document'),
        lastAttemptedUri: metadata?.lastAttemptedUri || metadata?.tokenURI || metadata?.token_uri || null,
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
 * Enhanced IPFS resolution using multiple gateways for reliability
 * Prioritizes fast gateways but provides fallback URLs for robust loading
 */
const fastResolveIPFS = (ipfsUrl) => {
    if (!ipfsUrl) return null;
    
    let hash = ipfsUrl;
    if (ipfsUrl.startsWith('ipfs://')) {
        hash = ipfsUrl.replace('ipfs://', '');
    } else if (ipfsUrl.includes('/ipfs/')) {
        hash = ipfsUrl.split('/ipfs/')[1];
    }
    
    // Return the most reliable gateway for immediate display
    // This aligns with ListingCard's successful gateway strategy
    return `/api/ipfs/ipfs/${hash}`;
};

/**
 * Ask the backend for metadata.
 *
 * /api/metadata-cache resolves tokenURI against every configured chain and
 * caches the result, so it succeeds where a browser-side contract read fails
 * — a wallet provider pointed at the wrong chain, an RPC timeout, or a
 * contract that only answers on the chain the page is not currently on.
 */
const fetchMetadataFromApi = async (contractAddress, tokenId) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(
            `/api/metadata-cache?contract=${encodeURIComponent(contractAddress)}&tokenId=${encodeURIComponent(tokenId)}`,
            { headers: { Accept: 'application/json' }, signal: controller.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data || (!data.image && !data.imageUrl)) throw new Error('No image in API metadata');
        return data;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Create basic fallback metadata when no other source is available
 */
const createBasicMetadata = (contractAddress, tokenId) => {
    return {
        name: `NFT #${tokenId}`,
        description: `Token #${tokenId} from contract ${contractAddress}`,
        image: null,
        imageUrl: null,
        attributes: [],
        contractAddress: contractAddress,
        tokenId: tokenId,
        loaded: true,
        loading: false,
        error: 'Contract and metadata API did not return usable metadata',
        metadataState: 'metadata_unavailable',
        failureProvenance: 'contract_and_metadata_api',
        lastAttemptedUri: null
    };
};

/**
 * Create fallback metadata with error information
 */
const createFallbackMetadata = (tokenId, errorMessage) => {
    return {
        name: `NFT #${tokenId || 'Unknown'}`,
        description: `Metadata unavailable: ${errorMessage}`,
        image: null,
        imageUrl: null,
        attributes: [],
        collection: null,
        contractAddress: null,
        tokenId: tokenId || 'Unknown',
        loaded: true,
        loading: false,
        error: errorMessage,
        metadataState: 'metadata_unavailable',
        failureProvenance: 'metadata_loader',
        lastAttemptedUri: null,
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
export const batchLoadMetadata = async (nfts, provider, batchSize = 20) => {
    console.log(`📦 [BATCH LOAD] Starting batchLoadMetadata with ${nfts.length} NFTs, batchSize: ${batchSize}`);
    
    if (!nfts || nfts.length === 0) {
        console.log('❌ [BATCH LOAD] No NFTs provided, returning empty array');
        return [];
    }

    const results = [];
    
    // Process in optimized batches for Vitruveo blockchain
    for (let i = 0; i < nfts.length; i += batchSize) {
        const batch = nfts.slice(i, i + batchSize);
        console.log(`📋 [BATCH LOAD] Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(nfts.length/batchSize)} with ${batch.length} NFTs`);
        
        // Process all NFTs in the batch in parallel with increased timeout for Vitruveo
        const batchPromises = batch.map(async (nft, index) => {
            console.log(`🔍 [BATCH LOAD] Processing NFT ${i + index + 1}/${nfts.length}: ${nft.contractAddress}:${nft.tokenId}`);
            
            try {
                // Create controller for this specific NFT
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000); // Increased to 12s
                
                const metadataPromise = loadNFTMetadata(
                    nft.contractAddress, 
                    nft.tokenId, 
                    provider, 
                    nft.metadata || null
                );
                
                try {
                    const metadata = await Promise.race([
                        metadataPromise,
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Metadata load timeout')), 12000))
                    ]);
                    
                    clearTimeout(timeoutId);
                    console.log(`✅ [BATCH LOAD] Successfully loaded metadata for ${nft.contractAddress}:${nft.tokenId}`);
                    
                    return {
                        ...nft,
                        metadata: metadata
                    };
                } catch (error) {
                    clearTimeout(timeoutId);
                    throw error;
                }
            } catch (error) {
                console.error(`❌ [BATCH LOAD] Failed to load metadata for ${nft.contractAddress}:${nft.tokenId}:`, error);
                // Return NFT with fallback metadata instead of failing
                return {
                    ...nft,
                    metadata: createFallbackMetadata(nft.tokenId, error.message)
                };
            }
        });
        
        // Wait for all in the batch to complete
        console.log(`⏳ [BATCH LOAD] Waiting for batch ${Math.floor(i/batchSize) + 1} to complete...`);
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Add successful results
        batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                results.push(result.value);
                console.log(`✅ [BATCH LOAD] Added result for NFT ${i + index + 1}`);
            } else {
                console.error(`❌ [BATCH LOAD] Failed result for NFT ${i + index + 1}:`, result.reason);
            }
        });
        
        console.log(`📊 [BATCH LOAD] Batch ${Math.floor(i/batchSize) + 1} completed, ${results.length} total results so far`);
        
        // Longer delay between batches for Vitruveo blockchain stability
        if (i + batchSize < nfts.length) {
            console.log(`⏸️ [BATCH LOAD] Waiting 200ms before next batch...`);
            await new Promise(resolve => setTimeout(resolve, 200)); // Increased delay
        }
    }
    
    console.log(`🎉 [BATCH LOAD] Completed processing all batches, returning ${results.length} results`);
    return results;
};

/**
 * Enhanced image URL resolution optimized for reliability and speed
 * Returns an array of candidate URLs that can be tried by the client
 * @param {string} imageUrl - Image URL to resolve
 * @returns {Object} Object with primary URL and fallback URLs
 */
export const resolveImageUrl = async (imageUrl) => {
    if (!imageUrl || typeof imageUrl !== 'string') {
        return {
            primary: null,
            fallbacks: [],
            isIPFS: false,
            metadataState: 'missing_image'
        };
    }

    // If it's already an HTTP/HTTPS URL, use it directly
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        return {
            primary: imageUrl,
            fallbacks: [],
            isIPFS: false
        };
    }

    // Handle IPFS URLs with multiple gateway options
    if (imageUrl.startsWith('ipfs://') || imageUrl.includes('/ipfs/')) {
        let hash = imageUrl;
        if (imageUrl.startsWith('ipfs://')) {
            hash = imageUrl.replace('ipfs://', '');
        } else if (imageUrl.includes('/ipfs/')) {
            hash = imageUrl.split('/ipfs/')[1];
        }

        // Generate multiple gateway URLs for robust loading
        const gateways = [
            '/api/ipfs/ipfs/',
            'https://dweb.link/ipfs/',
            'https://ipfs.io/ipfs/',
        ];

        const gatewayUrls = gateways.map(gateway => `${gateway}${hash}`);

        return {
            primary: gatewayUrls[0], // Cloudflare as primary (most reliable)
            fallbacks: gatewayUrls.slice(1),
            isIPFS: true,
            hash: hash
        };
    }

    // Handle Arweave URLs
    if (imageUrl.startsWith('ar://')) {
        const hash = imageUrl.replace('ar://', '');
        const arweaveUrl = `https://arweave.net/${hash}`;
        return {
            primary: arweaveUrl,
            fallbacks: [],
            isIPFS: false
        };
    }

    // If unknown format, use as-is with fallback
    return {
        primary: imageUrl,
        fallbacks: [],
        isIPFS: false
    };
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
    batchLoadMetadata,
    resolveImageUrl,
    cleanupMetadataCache
};
