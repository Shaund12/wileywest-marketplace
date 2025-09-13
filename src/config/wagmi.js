import { http, createConfig } from 'wagmi'
import { mainnet, sepolia } from 'wagmi/chains'
import { walletConnect, injected, coinbaseWallet } from 'wagmi/connectors'

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
      http: ['https://rpc.vitruveo.xyz'],
    },
    public: {
      http: ['https://rpc.vitruveo.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Vitruveo Explorer',
      url: 'https://explorer.vitruveo.xyz',
    },
  },
}

// Get project ID from environment variables with provided fallback
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '70da63e7d5d6a44cb43d1bc518c1f43a'

// Configure wagmi with enhanced connectors
export const config = createConfig({
  chains: [vitruveo, mainnet, sepolia],
  connectors: [
    injected({ 
      shimDisconnect: true,
      unstable_shimAsyncInject: true, // Better wallet detection
    }),
    walletConnect({
      projectId,
      metadata: {
        name: 'BlockDust NFT Marketplace',
        description: 'Trade in the neon shadows. Own the future.',
        url: 'https://blockdust.app',
        icons: ['https://blockdust.app/favicon.ico']
      },
      showQrModal: false, // We'll use AppKit's modal
      qrModalOptions: {
        themeMode: 'dark',
        themeVariables: {
          '--w3m-accent': '#00ffff',
        }
      }
    }),
    coinbaseWallet({
      appName: 'BlockDust NFT Marketplace',
      appLogoUrl: 'https://blockdust.app/favicon.ico',
      enableMobileWalletLink: true, // Better mobile support
      headlessMode: false
    })
  ],
  transports: {
    [vitruveo.id]: http(),
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
})