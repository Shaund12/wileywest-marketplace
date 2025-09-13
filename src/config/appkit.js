import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { vitruveo } from './wagmi'

// Get project ID from environment variables  
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '70da63e7d5d6a44cb43d1bc518c1f43a'

// Create the wagmi adapter with explicit wallet configuration
const wagmiAdapter = new WagmiAdapter({
  networks: [vitruveo],
  projectId,
})

// AppKit configuration with enhanced wallet discovery
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
    emailShowWallets: true, // Enable wallet discovery
    allWallets: 'SHOW', // Show all available wallets
    onramp: false,
    swaps: false,
  },
  includeWalletIds: [
    // Popular wallets that should always be available
    'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // MetaMask
    '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0', // Trust Wallet
    '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369', // Rainbow
    'c03dfee351b6fcc421b4494cf8a5a72c82fbfb9e2a53a0a0f4b5a3c2a3c8b5e3', // Coinbase Wallet
    '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1', // Rabby Wallet
  ],
  excludeWalletIds: [], // Don't exclude any wallets
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