// Utility for filtering blocked NFT contracts
// These contracts should not appear in collection views, profile, or anywhere in the UI

import { FLAGS } from './featureFlags';

// List of blocked NFT contract addresses (lowercase for comparison)
// These contracts are blocked for compliance reasons (securities, revenue sharing, etc.)
const BLOCKED_CONTRACT_ADDRESSES = [
    '0xc5d518d131738481947cfa4670f94eb7b948a1ac', // V-Share (revenue sharing)
    '0x8e7c7f0df435be6773641f8cf62c590d7dde5a8a', // Vibe (securities)
    '0x72d2bfb14b3351d17a63cd4c8085e034e313c54c', // Verse (securities)
].map(addr => addr.toLowerCase());

/**
 * Check if an NFT contract address is blocked
 * @param {string} contractAddress - The contract address to check
 * @returns {boolean} - True if the contract is blocked, false otherwise
 */
export function isContractBlocked(contractAddress) {
    // Only filter if sanctions flag is enabled
    if (!FLAGS.SANCTIONS) {
        return false;
    }
    
    if (!contractAddress) {
        return false;
    }
    
    const normalizedAddress = contractAddress.toLowerCase();
    return BLOCKED_CONTRACT_ADDRESSES.includes(normalizedAddress);
}

/**
 * Filter out blocked contracts from an array of NFTs
 * @param {Array} nfts - Array of NFT objects with contractAddress property
 * @returns {Array} - Filtered array with blocked contracts removed
 */
export function filterBlockedNFTs(nfts) {
    // Only filter if sanctions flag is enabled
    if (!FLAGS.SANCTIONS) {
        return nfts;
    }
    
    if (!Array.isArray(nfts)) {
        return nfts;
    }
    
    return nfts.filter(nft => {
        if (!nft || !nft.contractAddress) {
            return true; // Keep NFTs without contract address (shouldn't happen)
        }
        return !isContractBlocked(nft.contractAddress);
    });
}

/**
 * Filter out blocked contracts from an array of listings
 * @param {Array} listings - Array of listing objects with nftContract property
 * @returns {Array} - Filtered array with blocked contracts removed
 */
export function filterBlockedListings(listings) {
    // Only filter if sanctions flag is enabled
    if (!FLAGS.SANCTIONS) {
        return listings;
    }
    
    if (!Array.isArray(listings)) {
        return listings;
    }
    
    return listings.filter(listing => {
        if (!listing || !listing.nftContract) {
            return true; // Keep listings without contract address (shouldn't happen)
        }
        return !isContractBlocked(listing.nftContract);
    });
}

/**
 * Filter out blocked contract addresses from an array of addresses
 * @param {Array} addresses - Array of contract addresses
 * @returns {Array} - Filtered array with blocked addresses removed
 */
export function filterBlockedAddresses(addresses) {
    // Only filter if sanctions flag is enabled
    if (!FLAGS.SANCTIONS) {
        return addresses;
    }
    
    if (!Array.isArray(addresses)) {
        return addresses;
    }
    
    return addresses.filter(address => !isContractBlocked(address));
}

/**
 * Get the list of all blocked contract addresses
 * @returns {Array} - Array of blocked contract addresses (lowercase)
 */
export function getBlockedContracts() {
    return [...BLOCKED_CONTRACT_ADDRESSES];
}
