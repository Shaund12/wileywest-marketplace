import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {}
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunks - separate large libraries
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-ethers': ['ethers'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-analytics': ['@vercel/analytics'],
          
          // Feature chunks - separate by functionality
          'marketplace-core': [
            './src/context/MarketplaceContext.jsx',
            './src/context/WalletContext.jsx',
            './src/context/SupabaseContext.jsx'
          ],
          'auction-system': [
            './src/pages/CreateAuctionPage.jsx',
            './src/pages/AuctionDetailPage.jsx',
            './src/pages/MyAuctionsPage.jsx'
          ],
          'utils': [
            './src/utils/tokenUtils.js',
            './src/utils/nftUtils.js',
            './src/utils/networkUtils.js'
          ]
        }
      }
    },
    chunkSizeWarningLimit: 600 // Increase slightly but keep reasonable
  }
});
