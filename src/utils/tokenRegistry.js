/**
 * Token registry — NATIVE TOKEN ONLY.
 *
 * The old Vitruveo ERC-20s (WVTRU, USDC.pol, VUSD, SEVO, wSEVO, VITEX, VTRO)
 * all died when the chain was redone, so the marketplace now trades purely in
 * the active chain's native token (VTRU on Vitruveo, HYVE on Hyve). The
 * export surface is unchanged so existing imports keep working.
 */

import { ethers } from 'ethers';
import { debugWarn } from './debugUtils';
import { activeChain } from '../config/chains.js';

const _chain = activeChain();

// Native only. Legacy keys intentionally removed — do not re-add dead tokens.
export const TOKEN_ADDRESSES = {
    [_chain.symbol]: ethers.ZeroAddress, // native (VTRU or HYVE)
};

// Token metadata — a single native entry for the active chain.
export const TOKEN_REGISTRY = {
    [ethers.ZeroAddress]: {
        symbol: _chain.symbol,
        name: _chain.name,
        decimals: 18,
        icon: '/icons/vtru.svg',
        isNative: true,
    },
};

// Get token info by address
export function getTokenInfo(address) {
    // Handle null/undefined addresses
    if (!address || address === 'null' || address === 'undefined') {
        address = ethers.ZeroAddress;
    }

    return TOKEN_REGISTRY[address] || {
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        decimals: 18,
        icon: '/icons/unknown.svg',
        isNative: false,
    };
}

// Get supported payment tokens for dropdowns (native only)
export function getSupportedTokens() {
    return Object.entries(TOKEN_REGISTRY).map(([address, info]) => ({
        address,
        ...info,
    }));
}

// Check if token has path to wVTRU set (legacy fee-conversion hook — dead)
export function hasPathToWVTRU(_tokenAddress, _marketplace) {
    return false;
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
