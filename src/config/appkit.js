import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { vitruveo } from './wagmi'

// Get project ID from environment variables  
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'demo-project-id'

// Create the wagmi adapter
const wagmiAdapter = new WagmiAdapter({
  networks: [vitruveo],
  projectId,
})

// AppKit configuration
export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  networks: [vitruveo],
  projectId,
  metadata: {
    name: 'BlockDust NFT Marketplace',
    description: 'Trade in the neon shadows. Own the future.',
    url: 'https://blockdust.app',
    icons: ['https://blockdust.app/favicon.ico']
  },
  features: {
    analytics: true,
    email: false,
    socials: [],
    emailShowWallets: false,
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-color-mix': '#00ffff',
    '--w3m-color-mix-strength': 20,
    '--w3m-accent': '#00ffff',
    '--w3m-background': '#0a0a0a',
    '--w3m-font-family': 'inherit',
    '--w3m-border-radius-master': '8px',
  }
})

export { wagmiAdapter }