import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { hyve, vitruveo } from './wagmi'

// Get project ID from environment variables
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '70da63e7d5d6a44cb43d1bc518c1f43a'

// Create the wagmi adapter with explicit wallet configuration
const wagmiAdapter = new WagmiAdapter({
  networks: [hyve, vitruveo],
  projectId,
})

// AppKit configuration with enhanced wallet discovery
export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  networks: [hyve, vitruveo],
  projectId,
  metadata: {
    name: 'BlockDust NFT Marketplace',
    description: 'Trade in the neon shadows. Own the future.',
    url: 'https://blockdust.pyvendr.com',
    icons: ['https://blockdust.pyvendr.com/favicon.ico']
  },
  features: {
    analytics: false,
    email: false,
    socials: [],
    emailShowWallets: false,
    allWallets: 'HIDE',
    onramp: false,
    swaps: false,
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-color-mix': '#00ffff',
    '--w3m-color-mix-strength': 20,
    '--w3m-accent': '#00ffff',
    '--w3m-font-family': 'inherit',
    '--w3m-border-radius-master': '8px',
  }
})

export { wagmiAdapter }
