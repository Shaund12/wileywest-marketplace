/**
 * Token registry for supported ERC-20 tokens on Vitruveo network
 */

import { ethers } from 'ethers';
import { debugWarn } from './debugUtils';

// Token addresses on Vitruveo mainnet
export const TOKEN_ADDRESSES = {
    VTRU: ethers.ZeroAddress, // Native VTRU
    WVTRU: '0x3ccc3F22462cAe34766820894D04a40381201ef9',
    USDC: '0x0000000000000000000000000000000000000000', // To be filled when deployed
    VUSD: '0x0000000000000000000000000000000000000000', // To be filled when deployed
    SEVO: '0x0000000000000000000000000000000000000000', // To be filled when deployed
    WSEVO: '0x0000000000000000000000000000000000000000', // To be filled when deployed
    VITEX: '0x0000000000000000000000000000000000000000', // To be filled when deployed
    VTRO: '0x0000000000000000000000000000000000000000', // To be filled when deployed
};

// Token metadata
export const TOKEN_REGISTRY = {
    [ethers.ZeroAddress]: {
        symbol: 'VTRU',
        name: 'Vitruveo',
        decimals: 18,
        icon: '/icons/vtru.svg',
        isNative: true,
    },
    [TOKEN_ADDRESSES.WVTRU]: {
        symbol: 'wVTRU',
        name: 'Wrapped Vitruveo',
        decimals: 18,
        icon: '/icons/wvtru.svg',
        isNative: false,
    },
    [TOKEN_ADDRESSES.USDC]: {
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        icon: '/icons/usdc.svg',
        isNative: false,
    },
    [TOKEN_ADDRESSES.VUSD]: {
        symbol: 'VUSD',
        name: 'Vitruveo USD',
        decimals: 18,
        icon: '/icons/vusd.svg',
        isNative: false,
    },
    [TOKEN_ADDRESSES.SEVO]: {
        symbol: 'SEVO',
        name: 'Sevo Token',
        decimals: 18,
        icon: '/icons/sevo.svg',
        isNative: false,
    },
    [TOKEN_ADDRESSES.WSEVO]: {
        symbol: 'wSEVO',
        name: 'Wrapped Sevo',
        decimals: 18,
        icon: '/icons/wsevo.svg',
        isNative: false,
    },
    [TOKEN_ADDRESSES.VITEX]: {
        symbol: 'VITEX',
        name: 'Vitex Token',
        decimals: 18,
        icon: '/icons/vitex.svg',
        isNative: false,
    },
    [TOKEN_ADDRESSES.VTRO]: {
        symbol: 'VTRO',
        name: 'Vitro Token',
        decimals: 18,
        icon: '/icons/vtro.svg',
        isNative: false,
    },
};

// Get token info by address
export function getTokenInfo(address) {
    // Handle null/undefined addresses
    if (!address || address === 'null' || address === 'undefined') {
        address = ethers.ZeroAddress;
    }
    
    const normalizedAddress = address === ethers.ZeroAddress ? ethers.ZeroAddress : address;
    return TOKEN_REGISTRY[normalizedAddress] || {
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        decimals: 18,
        icon: '/icons/unknown.svg',
        isNative: false,
    };
}

// Get supported payment tokens for dropdowns
export function getSupportedTokens() {
    return Object.entries(TOKEN_REGISTRY).map(([address, info]) => ({
        address,
        ...info,
    }));
}

// Check if token has path to wVTRU set (for fee conversion)
export function hasPathToWVTRU(tokenAddress, marketplace) {
    // This will be checked via contract call in components
    return false; // Placeholder
}

// Format token amount with proper decimals
export function formatTokenAmount(amount, tokenAddress) {
    // Handle null/undefined amounts
    if (!amount || amount === 'null' || amount === 'undefined') {
        amount = '0';
    }
    
    const tokenInfo = getTokenInfo(tokenAddress);
    try {
        const value = ethers.formatUnits(amount, tokenInfo.decimals);
        return `${value} ${tokenInfo.symbol}`;
    } catch (error) {
        debugWarn('Error formatting token amount:', { amount, tokenAddress, error });
        return `0 ${tokenInfo.symbol}`;
    }
}

// Parse token amount with proper decimals
export function parseTokenAmount(amount, tokenAddress) {
    // Handle null/undefined amounts
    if (!amount || amount === 'null' || amount === 'undefined') {
        amount = '0';
    }
    
    const tokenInfo = getTokenInfo(tokenAddress);
    try {
        return ethers.parseUnits(amount.toString(), tokenInfo.decimals);
    } catch (error) {
        debugWarn('Error parsing token amount:', { amount, tokenAddress, error });
        return ethers.parseUnits('0', tokenInfo.decimals);
    }
}