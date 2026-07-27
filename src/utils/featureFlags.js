/**
 * Feature flags and safety utilities.
 *
 * Config is now multichain: it resolves from the active chain in the
 * chain registry (src/config/chains.js) instead of single VITE_* vars.
 * Legacy VITE_* env vars are still honored as fallbacks inside the
 * registry, so an existing .env keeps working for Vitruveo.
 */
import {
    activeChain,
    getActiveChainId,
    chainHasFeature,
    chainAddress,
} from '../config/chains.js';

// Auctions are enabled per-chain (declared in the chain registry).
export function isAuctionsEnabled() {
    return chainHasFeature('auctions');
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

// Get configuration for the ACTIVE chain (from the chain registry).
// Return shape is kept identical to the previous single-chain version so
// existing callers (config.marketplaceAddress, config.wvtruAddress, …)
// keep working — the values just come from the active chain now.
export function getConfig() {
    const c = activeChain();
    return {
        chainId: c.id,
        chainKey: c.key,
        chainName: c.name,
        nativeSymbol: c.symbol,
        rpcUrl: c.rpcUrl,
        explorer: c.explorer,
        marketplaceAddress: c.marketplaceAddress,
        // Vitruveo-only addresses ('' on chains that don't have them).
        wvtruAddress: chainAddress('wvtru'),
        usdcAddress: chainAddress('usdc'),
        vibeSinkAddress: chainAddress('vibeSink'),
        uniswapRouterAddress: chainAddress('uniswapRouter'),
        uniswapFactoryAddress: chainAddress('uniswapFactory'),
        revShareNftAddress: chainAddress('revShareNft'),
        revShareTreasuryAddress: chainAddress('revShareTreasury'),
        // Per-chain feature switches for the UI to gate on.
        features: c.features,
        featureFlags: getFeatureFlags(),
    };
}

// Convenience re-exports so components can gate on features/chain directly.
export { getActiveChainId, chainHasFeature, chainAddress, activeChain };