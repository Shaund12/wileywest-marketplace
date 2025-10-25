/**
 * Known Collections Utility for Vitruveo NFT Collections
 * Provides centralized collection metadata and contract address registry
 */

import { debugLog, debugWarn } from './debugUtils';

/**
 * Registry of known NFT collections on Vitruveo network
 * Organized by contract address (lowercase) for fast lookups
 */
export const KNOWN_COLLECTIONS = {
    // Core Vitruveo Collections
    '0xaef0a72a661b82cb1d871fca5117486c664eef13': {
        address: '0xaEf0a72A661B82CB1d871FCA5117486C664EeF13',
        name: 'Vitruveo Core NFT',
        symbol: 'VCORE',
        description: 'Core NFTs for the Vitruveo ecosystem',
        explorerUrl: 'https://explorer.vitruveo.net/token/0xaEf0a72A661B82CB1d871FCA5117486C664EeF13',
        type: 'ERC721', // Assumed standard, can be updated
        verified: true,
        category: 'Core'
    },
    '0x8e7c7f0df435be6773641f8cf62c590d7dde5a8a': {
        address: '0x8e7C7f0DF435Be6773641f8cf62C590d7Dde5a8a',
        name: 'Vitruveo Income Building Engine',
        symbol: 'VIBE',
        description: 'Income building engine NFTs for Vitruveo ecosystem',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x8e7C7f0DF435Be6773641f8cf62C590d7Dde5a8a',
        type: 'ERC721',
        verified: true,
        category: 'DeFi'
    },
    '0x72d2bfb14b3351d17a63cd4c8085e034e313c54c': {
        address: '0x72D2bFb14b3351d17A63Cd4c8085E034e313c54c',
        name: 'Vitruveo Entertainment Revenue Sharing Engine',
        symbol: 'VERSE',
        description: 'Entertainment revenue sharing NFTs',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x72D2bFb14b3351d17A63Cd4c8085E034e313c54c',
        type: 'ERC721',
        verified: true,
        category: 'Entertainment'
    },
    '0xaba06e4a2eb17c686fc67c81d26701d9b82e3a41': {
        address: '0xABA06E4A2Eb17C686Fc67C81d26701D9b82e3a41',
        name: 'Vortex',
        symbol: 'VTX',
        description: 'Vortex NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0xABA06E4A2Eb17C686Fc67C81d26701D9b82e3a41',
        type: 'ERC721',
        verified: true,
        category: 'Gaming'
    },
    '0xfd1716e05225afe88f6f6e973a155eb0377e1657': {
        address: '0xFd1716e05225aFE88F6f6e973A155eb0377e1657',
        name: 'MintPlace',
        symbol: 'MPX',
        description: 'MintPlace NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0xFd1716e05225aFE88F6f6e973A155eb0377e1657',
        type: 'ERC721',
        verified: true,
        category: 'Marketplace'
    },
    '0xd2c4fb77517bc8d1a9da13dbea0bf4b8b29037dd': {
        address: '0xd2c4fb77517bC8D1A9dA13dbEA0Bf4B8B29037dD',
        name: 'VTRU Boosters V2',
        symbol: 'VBOOST',
        description: 'VTRU Boosters V2 NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0xd2c4fb77517bC8D1A9dA13dbEA0Bf4B8B29037dD',
        type: 'ERC721',
        verified: true,
        category: 'Utility'
    },
    '0x5c7421fcca16c685cec5aaff745a9a6bdf75ba06': {
        address: '0x5c7421fcCA16C685cEC5aaFf745a9a6BDf75Ba06',
        name: 'Vitruveo Collector Credit',
        symbol: 'VCOLC',
        description: 'Vitruveo Collector Credit NFTs',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x5c7421fcCA16C685cEC5aaFf745a9a6BDf75Ba06',
        type: 'ERC721',
        verified: true,
        category: 'Utility'
    },
    '0x8246eb7d32416888abeb23b1e715ee5a156d3abe': {
        address: '0x8246eb7D32416888aBeB23b1E715ee5A156d3aBe',
        name: 'VTRU Boosters',
        symbol: 'VBOOST',
        description: 'Original VTRU Boosters NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x8246eb7D32416888aBeB23b1E715ee5A156d3aBe',
        type: 'ERC721',
        verified: true,
        category: 'Utility'
    },
    '0x855b9fa4bb3af6d5947552830ea09f74d3f6d620': {
        address: '0x855B9fa4bb3af6d5947552830eA09f74d3F6d620',
        name: 'Sabong Evolution Hatchling',
        symbol: 'SHAT',
        description: 'Sabong Evolution Hatchling NFTs',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x855B9fa4bb3af6d5947552830eA09f74d3F6d620',
        type: 'ERC721',
        verified: true,
        category: 'Gaming'
    },
    '0x047aea572c510ece553151e0daa4fd84ac69928e': {
        address: '0x047aeA572c510ecE553151E0dAa4fd84AC69928E',
        name: 'Sabong Studios Share Units',
        symbol: 'S3U',
        description: 'Sabong Studios Share Units NFTs',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x047aeA572c510ecE553151E0dAa4fd84AC69928E',
        type: 'ERC721',
        verified: true,
        category: 'Gaming'
    },
    '0x20152506e44ba17f73dbf8fed08d23156a0344f9': {
        address: '0x20152506e44bA17f73DBf8fED08d23156A0344F9',
        name: 'Swoops',
        symbol: 'Swoops',
        description: 'Swoops NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x20152506e44bA17f73DBf8fED08d23156A0344F9',
        type: 'ERC721',
        verified: true,
        category: 'Gaming'
    },
    '0xaa5b03a28d47f29d5bcb81bb7d29a9567df785cf': {
        address: '0xAA5B03A28D47f29d5bCB81BB7d29a9567df785cf',
        name: 'SIC (SOCHAI Insiders Club)',
        symbol: 'SIC',
        description: 'SOCHAI Insiders Club NFTs',
        explorerUrl: 'https://explorer.vitruveo.net/token/0xAA5B03A28D47f29d5bCB81BB7d29a9567df785cf',
        type: 'ERC721',
        verified: true,
        category: 'Community'
    },
    '0x97336ac0c0ba1b5b4cae5d3ed65714cde1c86b5c': {
        address: '0x97336ac0c0Ba1b5B4CaE5D3ed65714cdE1c86B5c',
        name: 'Sabong Evolution Partner NFT',
        symbol: 'SEP',
        description: 'Sabong Evolution Partner NFTs',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x97336ac0c0Ba1b5B4CaE5D3ed65714cdE1c86B5c',
        type: 'ERC721',
        verified: true,
        category: 'Gaming'
    },
    '0x89207a7f75c9cb7c8f95f0c2517b029be1ae29b8': {
        address: '0x89207A7F75C9cb7C8f95f0c2517b029BE1AE29b8',
        name: 'neoNKatz',
        symbol: 'NK',
        description: 'neoNKatz NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x89207A7F75C9cb7C8f95f0c2517b029BE1AE29b8',
        type: 'ERC721',
        verified: true,
        category: 'Art'
    },
    '0x96fb9a1cb848865d8b7698ab3f645b85f37888b8': {
        address: '0x96Fb9a1Cb848865d8B7698ab3F645B85F37888b8',
        name: 'Vitruveo v3 DEX Income',
        symbol: 'VITDEX',
        description: 'Vitruveo v3 DEX Income NFTs',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x96Fb9a1Cb848865d8B7698ab3F645B85F37888b8',
        type: 'ERC721',
        verified: true,
        category: 'DeFi'
    },
    
    // Additional Collections from the issue
    '0xa1508636ffdabab8b038f705e87ef7f43b7c59d7f': {
        address: '0xA1508636fFDbaB8b038F705E87EF7F43b7c59d7F',
        name: 'VNFTz',
        symbol: 'VNFTz',
        description: 'VNFTz NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0xA1508636fFDbaB8b038F705E87EF7F43b7c59d7F',
        type: 'ERC721',
        verified: true,
        category: 'Utility'
    },
    '0x9acbdedd548de51615ff2adba468075330853215': {
        address: '0x9acbDedd548De51615Ff2adbA468075330853215',
        name: 'VMonsters',
        symbol: 'VMON',
        description: 'VMonsters NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x9acbDedd548De51615Ff2adbA468075330853215',
        type: 'ERC721',
        verified: true,
        category: 'Gaming'
    },
    '0xc5d518d131738481947cfa4670f94eb7b948a1ac': {
        address: '0xc5d518d131738481947cFa4670F94eb7b948a1ac',
        name: 'V-Share',
        symbol: 'VSHARE',
        description: 'V-Share NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0xc5d518d131738481947cFa4670F94eb7b948a1ac',
        type: 'ERC721',
        verified: true,
        category: 'DeFi'
    },
    '0xe1a5518cebd226fe2a3251f93a1f6aaef65d3131': {
        address: '0xE1A5518CEbd226FE2a3251F93A1F6AAef65d3131',
        name: 'Skoollz NFT Collection',
        symbol: 'SKLZ',
        description: 'Skoollz NFT Collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0xE1A5518CEbd226FE2a3251F93A1F6AAef65d3131',
        type: 'ERC721',
        verified: true,
        category: 'Education'
    },
    '0x2d732b0bb33566a13e586ae83fb21d2fee34e906': {
        address: '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906',
        name: 'Pixel Ninja Cats',
        symbol: 'PNCAT',
        description: 'Pixel Ninja Cats NFT collection',
        explorerUrl: 'https://explorer.vitruveo.net/token/0x2D732b0Bb33566A13E586aE83fB21d2feE34e906',
        type: 'ERC721',
        verified: true,
        category: 'Art'
    }
};

/**
 * Get all known collection addresses
 * @returns {string[]} Array of contract addresses
 */
export function getKnownCollectionAddresses() {
    return Object.values(KNOWN_COLLECTIONS).map(collection => collection.address);
}

/**
 * Get collection info by contract address
 * @param {string} address - Contract address (case insensitive)
 * @returns {Object|null} Collection info or null if not found
 */
export function getCollectionInfo(address) {
    if (!address || typeof address !== 'string') {
        return null;
    }
    
    const normalizedAddress = address.toLowerCase();
    const collection = KNOWN_COLLECTIONS[normalizedAddress];
    
    if (collection) {
        debugLog(`Found known collection: ${collection.name} (${collection.symbol})`);
        return { ...collection }; // Return a copy to prevent mutations
    }
    
    return null;
}

/**
 * Check if an address is a known collection
 * @param {string} address - Contract address to check
 * @returns {boolean} True if address is a known collection
 */
export function isKnownCollection(address) {
    if (!address || typeof address !== 'string') {
        return false;
    }
    
    const normalizedAddress = address.toLowerCase();
    return normalizedAddress in KNOWN_COLLECTIONS;
}

/**
 * Get collection name by address with fallback
 * @param {string} address - Contract address
 * @param {string} fallback - Fallback name if not found
 * @returns {string} Collection name or fallback
 */
export function getCollectionName(address, fallback = 'Unknown Collection') {
    const collection = getCollectionInfo(address);
    return collection?.name || fallback;
}

/**
 * Get collection symbol by address with fallback
 * @param {string} address - Contract address
 * @param {string} fallback - Fallback symbol if not found
 * @returns {string} Collection symbol or fallback
 */
export function getCollectionSymbol(address, fallback = 'UNKNOWN') {
    const collection = getCollectionInfo(address);
    return collection?.symbol || fallback;
}

/**
 * Get collections by category
 * @param {string} category - Category to filter by
 * @returns {Object[]} Array of collections in the category
 */
export function getCollectionsByCategory(category) {
    if (!category || typeof category !== 'string') {
        return [];
    }
    
    return Object.values(KNOWN_COLLECTIONS).filter(
        collection => collection.category?.toLowerCase() === category.toLowerCase()
    );
}

/**
 * Get all categories
 * @returns {string[]} Array of unique categories
 */
export function getCollectionCategories() {
    const categories = new Set();
    Object.values(KNOWN_COLLECTIONS).forEach(collection => {
        if (collection.category) {
            categories.add(collection.category);
        }
    });
    return Array.from(categories).sort();
}

/**
 * Search collections by name or symbol
 * @param {string} query - Search query
 * @returns {Object[]} Array of matching collections
 */
export function searchCollections(query) {
    if (!query || typeof query !== 'string') {
        return [];
    }
    
    const searchTerm = query.toLowerCase();
    return Object.values(KNOWN_COLLECTIONS).filter(collection => 
        collection.name.toLowerCase().includes(searchTerm) ||
        collection.symbol.toLowerCase().includes(searchTerm) ||
        collection.description?.toLowerCase().includes(searchTerm)
    );
}

/**
 * Get collection statistics
 * @returns {Object} Statistics about known collections
 */
export function getCollectionStats() {
    const collections = Object.values(KNOWN_COLLECTIONS);
    const categories = getCollectionCategories();
    
    const stats = {
        totalCollections: collections.length,
        totalCategories: categories.length,
        verifiedCollections: collections.filter(c => c.verified).length,
        byCategory: {}
    };
    
    categories.forEach(category => {
        stats.byCategory[category] = getCollectionsByCategory(category).length;
    });
    
    return stats;
}

/**
 * Export known collection addresses for integration with existing scanners
 * @returns {string[]} Array of addresses for KNOWN_NFT_CONTRACTS arrays
 */
export function getKnownNFTContractsArray() {
    return getKnownCollectionAddresses();
}

// Default export for convenience
export default {
    KNOWN_COLLECTIONS,
    getKnownCollectionAddresses,
    getCollectionInfo,
    isKnownCollection,
    getCollectionName,
    getCollectionSymbol,
    getCollectionsByCategory,
    getCollectionCategories,
    searchCollections,
    getCollectionStats,
    getKnownNFTContractsArray
};