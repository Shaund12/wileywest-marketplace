import { ethers } from 'ethers';
import { debugWarn, debugLog } from './debugUtils';

// Standard ERC721 and ERC1155 minimal ABIs for ownership verification
const ERC721_ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function balanceOf(address owner) view returns (uint256)'
];

const ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)'
];

/**
 * Verify if a user owns a specific NFT
 * @param {Object} nft - NFT object with contractAddress, tokenId, and type
 * @param {string} userAddress - User's wallet address
 * @param {Object} provider - Ethers provider
 * @returns {Promise<boolean>} True if user owns the NFT
 */
export const verifyNFTOwnership = async (nft, userAddress, provider) => {
    if (!provider || !userAddress || !nft.contractAddress || !nft.tokenId) {
        return false;
    }

    try {
        let isOwner = false;
        
        if (nft.type === 'ERC1155') {
            // For ERC1155, check balance
            const contract = new ethers.Contract(nft.contractAddress, ERC1155_ABI, provider);
            const balance = await contract.balanceOf(userAddress, nft.tokenId);
            isOwner = balance > 0;
        } else {
            // For ERC721, check owner
            const contract = new ethers.Contract(nft.contractAddress, ERC721_ABI, provider);
            try {
                const owner = await contract.ownerOf(nft.tokenId);
                isOwner = owner.toLowerCase() === userAddress.toLowerCase();
            } catch (ownerError) {
                // Token might not exist or might be ERC1155
                debugWarn(`Failed to get owner for ${nft.contractAddress}:${nft.tokenId}`, ownerError);
                isOwner = false;
            }
        }

        return isOwner;
    } catch (error) {
        debugWarn(`Ownership verification failed for ${nft.contractAddress}:${nft.tokenId}`, error);
        return false;
    }
};

/**
 * Filter a list of NFTs to only include those owned by the user
 * @param {Array} nfts - Array of NFT objects
 * @param {string} userAddress - User's wallet address
 * @param {Object} provider - Ethers provider
 * @param {Function} statusCallback - Optional callback for status updates
 * @returns {Promise<Array>} Array of owned NFTs
 */
export const filterOwnedNFTs = async (nfts, userAddress, provider, statusCallback = null) => {
    if (!nfts || nfts.length === 0 || !userAddress || !provider) {
        return [];
    }

    debugLog(`🔍 Verifying ownership of ${nfts.length} NFTs...`);
    
    if (statusCallback) {
        statusCallback(`🔍 Verifying ownership of ${nfts.length} NFTs...`);
    }
    
    // Verify ownership in batches for better performance
    const batchSize = 10;
    const ownedNFTs = [];
    
    for (let i = 0; i < nfts.length; i += batchSize) {
        const batch = nfts.slice(i, i + batchSize);
        const verificationPromises = batch.map(async (nft) => {
            const isOwned = await verifyNFTOwnership(nft, userAddress, provider);
            return isOwned ? nft : null;
        });
        
        const batchResults = await Promise.all(verificationPromises);
        const ownedInBatch = batchResults.filter(nft => nft !== null);
        ownedNFTs.push(...ownedInBatch);
        
        // Progress update
        if (statusCallback) {
            statusCallback(`Verifying ownership ${Math.min(i + batchSize, nfts.length)}/${nfts.length}...`);
        }
    }

    const removedCount = nfts.length - ownedNFTs.length;
    if (removedCount > 0) {
        debugLog(`🧹 Removed ${removedCount} NFTs that are no longer owned by user`);
        if (statusCallback) {
            statusCallback(`✅ Ownership verified - ${removedCount} outdated NFTs removed`);
        }
    } else if (statusCallback) {
        statusCallback(`✅ All ${ownedNFTs.length} NFTs confirmed as owned`);
    }

    return ownedNFTs;
};

/**
 * Refresh user NFT collections by verifying ownership and updating cache
 * @param {string} userAddress - User's wallet address
 * @param {Object} provider - Ethers provider
 * @param {Function} getCachedProfile - Function to get cached profile
 * @param {Function} cacheProfileData - Function to cache profile data
 * @param {Function} statusCallback - Optional callback for status updates
 * @returns {Promise<Array>} Array of owned NFTs
 */
export const refreshUserNFTCollections = async (
    userAddress, 
    provider, 
    getCachedProfile, 
    cacheProfileData, 
    statusCallback = null
) => {
    if (!userAddress || !provider || !getCachedProfile) {
        return [];
    }

    try {
        if (statusCallback) {
            statusCallback('🔄 Refreshing NFT collections...');
        }

        // Get cached profile data
        const cachedProfile = await getCachedProfile(userAddress);
        if (!cachedProfile || !cachedProfile.nfts || cachedProfile.nfts.length === 0) {
            if (statusCallback) {
                statusCallback('📭 No cached NFT collection found');
            }
            return [];
        }

        // Verify ownership of cached NFTs
        const ownedNfts = await filterOwnedNFTs(
            cachedProfile.nfts, 
            userAddress, 
            provider, 
            statusCallback
        );

        // Update cache with verified NFTs if we have caching capability
        if (cacheProfileData && ownedNfts.length !== cachedProfile.nfts.length) {
            try {
                const updatedProfileData = {
                    ...cachedProfile,
                    nfts: ownedNfts,
                    updated_at: new Date().toISOString()
                };
                await cacheProfileData(userAddress, updatedProfileData);
                debugLog(`✅ Updated cache with ${ownedNfts.length} verified NFTs`);
                if (statusCallback) {
                    statusCallback(`✅ Cache updated with ${ownedNfts.length} verified NFTs`);
                }
            } catch (cacheError) {
                debugWarn('Failed to update cache with verified NFTs:', cacheError);
            }
        }

        return ownedNfts;
    } catch (error) {
        debugWarn('Error refreshing user NFT collections:', error);
        if (statusCallback) {
            statusCallback('❌ Failed to refresh NFT collections');
        }
        return [];
    }
};