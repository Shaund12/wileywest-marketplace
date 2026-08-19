/**
 * ─────────────────────────────────────────────────────────────
 *  Multichain registry — the single source of truth for which
 *  chains BlockDust supports, their contract addresses, and which
 *  optional features each chain has.
 *
 *  Vitruveo has extra DeFi primitives (Vibe fee processor, RevShare,
 *  WVTRU wrapping, Uniswap-based pricing) that DO NOT exist on Hyve.
 *  Those are declared per-chain in `features` and chain-gated in the
 *  UI — present on Vitruveo, hidden on Hyve.
 *
 *  Per-chain env overrides: VITE_<CHAINKEY>_<FIELD>, e.g.
 *  VITE_HYVE_MARKETPLACE_ADDRESS, VITE_VITRUVEO_MARKETPLACE_ADDRESS.
 *  Falls back to the legacy single VITE_* vars for Vitruveo so an
 *  existing .env keeps working.
 * ─────────────────────────────────────────────────────────────
 */

const env = import.meta.env;
const ZERO = '0x0000000000000000000000000000000000000000';

// helper: per-chain env override → legacy env → default
const pick = (chainKey, field, legacy, dflt = '') =>
  env[`VITE_${chainKey}_${field}`] ?? legacy ?? dflt;

const sameOriginApi = (path) =>
  typeof window === 'undefined' ? path : `${window.location.origin}${path}`;

export const CHAINS = {
  7847: {
    id: 7847,
    key: 'hyve',
    name: 'Hyve',
    symbol: 'HYVE',
    icon: '🐝',
    // The upstream does not allow browser CORS; use our whitelisted proxy.
    rpcUrl: pick('HYVE', 'RPC_URL', null, sameOriginApi('/api/rpc/hyve')),
    explorer: 'https://explorer.hyvechain.com',
    // Our PixelNinjaMarketplace, deployed fresh on Hyve (fill after deploy).
    marketplaceAddress: pick('HYVE', 'MARKETPLACE_ADDRESS', null, '0x89610b27E8f5685681666edf901Ad5c69d89DfB6'),
    // provisional USD rate — HYVE not exchange-listed yet
    usdRate: 0.30,
    usdRateMode: 'estimate', // 'estimate' → labelled "(est. at launch price)"
    // Hyve is core-only: no Vitruveo DeFi primitives here.
    features: {
      vibe: false,
      revShare: false,
      wvtru: false,
      uniswapPricing: false,
      auctions: false,
    },
    // Vitruveo-only addresses are absent on Hyve.
    addresses: {},
  },

  1490: {
    id: 1490,
    key: 'vitruveo',
    name: 'Vitruveo',
    symbol: 'VTRU',
    icon: '💎',
    rpcUrl: pick('VITRUVEO', 'RPC_URL', env.VITE_RPC_URL, 'https://rpc.vitruveo.ai'),
    explorer: 'https://explorer.vitruveo.ai',
    marketplaceAddress: pick('VITRUVEO', 'MARKETPLACE_ADDRESS', env.VITE_MARKETPLACE_ADDRESS, '0x67cfCf4bE8447a083E6A2A1135Bd998FE91d3854'),
    // VTRU has a live BSC price (fetched at runtime); this is the fallback.
    usdRate: 0.0036,
    usdRateMode: 'live', // 'live' → real price, labelled "(live price)"
    // Vitruveo keeps its DeFi feature set where the contracts still exist.
    features: {
      vibe: true,
      revShare: true,
      wvtru: true,
      uniswapPricing: true,
      auctions: false,
    },
    // Vitruveo-specific contract addresses (legacy env vars still honored).
    addresses: {
      wvtru: pick('VITRUVEO', 'WVTRU_ADDRESS', env.VITE_WVTRU_ADDRESS, ZERO),
      usdc: pick('VITRUVEO', 'USDC_ADDRESS', env.VITE_USDC_ADDRESS, ZERO),
      vibeSink: pick('VITRUVEO', 'VIBE_SINK_ADDRESS', env.VITE_VIBE_SINK_ADDRESS, ZERO),
      uniswapRouter: pick('VITRUVEO', 'UNIV3_ROUTER_ADDRESS', env.VITE_UNIV3_ROUTER_ADDRESS, ZERO),
      uniswapFactory: pick('VITRUVEO', 'UNIV3_FACTORY_ADDRESS', env.VITE_UNIV3_FACTORY_ADDRESS, ZERO),
      revShareNft: pick('VITRUVEO', 'REVSHARE_NFT_ADDRESS', env.VITE_REVSHARE_NFT_ADDRESS, ZERO),
      revShareTreasury: pick('VITRUVEO', 'REVSHARE_TREASURY_ADDRESS', env.VITE_REVSHARE_TREASURY_ADDRESS, ZERO),
      revShareNftTreasury: pick('VITRUVEO', 'REVSHARE_NFT_TREASURY_ADDRESS', env.VITE_REVSHARE_NFT_TREASURY_ADDRESS, ZERO),
    },
  },
};

const STORAGE_KEY = 'blockdust_active_chain';
export const DEFAULT_CHAIN_ID = 7847; // Hyve is the primary chain

export function getActiveChainId() {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  return CHAINS[saved] ? saved : DEFAULT_CHAIN_ID;
}
export function setActiveChainId(id) {
  if (CHAINS[id]) localStorage.setItem(STORAGE_KEY, String(id));
}
export function activeChain() {
  return CHAINS[getActiveChainId()];
}
export function isSupportedChain(id) {
  return !!CHAINS[Number(id)];
}

/** Whether a named feature is enabled on the given (or active) chain. */
export function chainHasFeature(feature, chainId = getActiveChainId()) {
  return !!CHAINS[chainId]?.features?.[feature];
}

/** A Vitruveo-specific contract address for the given (or active) chain, or ''. */
export function chainAddress(name, chainId = getActiveChainId()) {
  return CHAINS[chainId]?.addresses?.[name] || '';
}

/** Explorer link builders (per active chain). */
export const explorerTx = (hash, chainId = getActiveChainId()) =>
  `${CHAINS[chainId].explorer}/tx/${hash}`;
export const explorerAddress = (addr, chainId = getActiveChainId()) =>
  `${CHAINS[chainId].explorer}/address/${addr}`;
export const explorerToken = (contract, tokenId, chainId = getActiveChainId()) =>
  `${CHAINS[chainId].explorer}/token/${contract}/instance/${tokenId}`;
