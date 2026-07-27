// Vitruveo chain configuration
export const vitruveo = {
  id: 1490,
  name: 'Vitruveo',
  nativeCurrency: {
    decimals: 18,
    name: 'Vitruveo',
    symbol: 'VTRU',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.vitruveo.ai'],
    },
    public: {
      http: ['https://rpc.vitruveo.ai'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Vitruveo Explorer',
      url: 'https://explorer.vitruveo.ai',
    },
  },
}

// Hyve chain configuration (EVM-on-Cosmos, chain id 7847).
// Browser traffic uses our same-origin backend because the upstream RPC does
// not return CORS headers.
const hyveRpcUrl = typeof window === 'undefined'
  ? 'https://rpc.hyvechain.com'
  : `${window.location.origin}/api/rpc/hyve`

export const hyve = {
  id: 7847,
  name: 'Hyve',
  nativeCurrency: {
    decimals: 18,
    name: 'Hyve',
    symbol: 'HYVE',
  },
  rpcUrls: {
    default: {
      http: [hyveRpcUrl],
    },
    public: {
      http: [hyveRpcUrl],
    },
  },
  blockExplorers: {
    default: {
      name: 'Hyve Explorer',
      url: 'https://explorer.hyvechain.com',
    },
  },
}
