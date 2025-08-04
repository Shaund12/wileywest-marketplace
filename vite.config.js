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
          // Vendor chunks
          'vendor-react': ['react', 'react-dom'],
          'vendor-router': ['react-router-dom'],
          'vendor-ethers': ['ethers'],
          'vendor-supabase': ['@supabase/supabase-js'],
          
          // App chunks
          'app-contexts': [
            './src/context/WalletContext.jsx',
            './src/context/MarketplaceContext.jsx'
          ],
          'app-services': [
            './src/services/priceService.js',
            './src/utils/errorUtils.js'
          ],
          'app-components': [
            './src/components/ErrorBoundary.jsx',
            './src/components/Navigation.jsx',
            './src/components/Footer.jsx',
            './src/components/ListingCard.jsx'
          ]
        }
      }
    },
    chunkSizeWarningLimit: 1000,
    sourcemap: false, // Disable sourcemaps in production for smaller build
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true, // Remove console.log in production
        drop_debugger: true
      }
    }
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'ethers', '@supabase/supabase-js']
  }
});
