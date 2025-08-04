import './styles.css';
import React, { useState, useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ethers } from 'ethers';
import MarketplaceAbi from './abi/Marketplace.json';
import { createClient } from '@supabase/supabase-js';

// Components
import Navigation from './components/Navigation';
import Footer from './components/Footer';
import ErrorBoundary, { WalletErrorBoundary, MarketplaceErrorBoundary } from './components/ErrorBoundary';

// Lazy loaded pages for code splitting
const HomePage = React.lazy(() => import('./pages/HomePage'));
const ProfilePage = React.lazy(() => import('./pages/ProfilePage'));
const MarketplacePage = React.lazy(() => import('./pages/MarketplacePage'));
const HotListingsPage = React.lazy(() => import('./pages/HotListingsPage'));
const TermsPage = React.lazy(() => import('./pages/TermsPage'));
const PrivacyPage = React.lazy(() => import('./pages/PrivacyPage'));
const SellPage = React.lazy(() => import('./pages/SellPage'));

// Providers
import { WalletProvider } from './context/WalletContext';
import { MarketplaceProvider } from './context/MarketplaceContext';

// Loading component for lazy loaded pages
const PageLoader = () => (
  <div className="page-loader">
    <div className="loader"></div>
    <p>Loading...</p>
  </div>
);

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || '',
  import.meta.env.VITE_SUPABASE_ANON_KEY || ''
);

const rpcUrl = import.meta.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
const marketplaceAddress = import.meta.env.VITE_MARKETPLACE_ADDRESS || '';

function App() {
  return (
    <ErrorBoundary>
      <WalletErrorBoundary>
        <WalletProvider rpcUrl={rpcUrl}>
          <MarketplaceErrorBoundary>
            <MarketplaceProvider marketplaceAddress={marketplaceAddress} abi={MarketplaceAbi}>
              <BrowserRouter>
                <div className="app-container">
                  <Navigation />
                  <div className="main-content">
                    <ErrorBoundary>
                      <Suspense fallback={<PageLoader />}>
                        <Routes>
                          <Route path="/" element={<HomePage />} />
                          <Route path="/profile" element={<ProfilePage />} />
                          <Route path="/marketplace" element={<MarketplacePage />} />
                          <Route path="/hot-listings" element={<HotListingsPage />} />
                          <Route path="/sell" element={<SellPage />} />
                          <Route path="/terms" element={<TermsPage />} />
                          <Route path="/privacy" element={<PrivacyPage />} />
                        </Routes>
                      </Suspense>
                    </ErrorBoundary>
                  </div>
                  <Footer />
                </div>
              </BrowserRouter>
            </MarketplaceProvider>
          </MarketplaceErrorBoundary>
        </WalletProvider>
      </WalletErrorBoundary>
    </ErrorBoundary>
  );
}

export default App;
