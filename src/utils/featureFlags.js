/**
 * Feature flags and safety utilities for auction functionality
 */

// Auctions are permanently enabled
export function isAuctionsEnabled() {
    return true;
}

// Get wallet allowlist for auction creation/settlement
export function getAuctionWalletAllowlist() {
    const allowlist = import.meta.env.VITE_AUCTIONS_WALLET_ALLOWLIST;
    if (!allowlist) return [];
    
    return allowlist
        .split(',')
        .map(addr => addr.trim().toLowerCase())
        .filter(addr => addr.length > 0);
}

// Check if wallet is allowed to create/settle auctions
export function isWalletAllowedForAuctions(walletAddress) {
    if (!walletAddress) return false;
    
    const allowlist = getAuctionWalletAllowlist();
    if (allowlist.length === 0) return true; // No allowlist = all allowed
    
    return allowlist.includes(walletAddress.toLowerCase());
}

// Get feature flag configuration
export function getFeatureFlags() {
    return {
        auctionsEnabled: isAuctionsEnabled(),
        auctionWalletAllowlist: getAuctionWalletAllowlist(),
    };
}

// Check if user can perform auction actions
export function canPerformAuctionAction(walletAddress, action = 'create') {
    // Auctions are always enabled
    
    // For bid actions, anyone can bid
    if (action === 'bid') return true;
    
    // For create/settle, check allowlist
    if (action === 'create' || action === 'settle') {
        return isWalletAllowedForAuctions(walletAddress);
    }
    
    return false;
}

// Get configuration from environment
export function getConfig() {
    return {
        chainId: parseInt(import.meta.env.VITE_CHAIN_ID || '1490'),
        rpcUrl: import.meta.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz',
        marketplaceAddress: import.meta.env.VITE_MARKETPLACE_ADDRESS,
        wvtruAddress: import.meta.env.VITE_WVTRU_ADDRESS,
        vibeSinkAddress: import.meta.env.VITE_VIBE_SINK_ADDRESS,
        uniswapRouterAddress: import.meta.env.VITE_UNIV3_ROUTER_ADDRESS,
        uniswapFactoryAddress: import.meta.env.VITE_UNIV3_FACTORY_ADDRESS,
        featureFlags: getFeatureFlags(),
    };
}