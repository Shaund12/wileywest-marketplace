import './styles.css';
import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ethers } from 'ethers';
import MarketplaceAbi from './abi/Marketplace.json';
import { createClient } from '@supabase/supabase-js';

// Components
import Navigation from './components/Navigation';
import Footer from './components/Footer';
import ErrorBoundary, { WalletErrorBoundary, MarketplaceErrorBoundary } from './components/ErrorBoundary';
import HomePage from './pages/HomePage';
import ProfilePage from './pages/ProfilePage';
import MarketplacePage from './pages/MarketplacePage';
import HotListingsPage from './pages/HotListingsPage';
import TermsPage from './pages/TermsPage';
import PrivacyPage from './pages/PrivacyPage';
import SellPage from './pages/SellPage';

// Providers
import { WalletProvider } from './context/WalletContext';
import { MarketplaceProvider } from './context/MarketplaceContext';

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
                      <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/profile" element={<ProfilePage />} />
                        <Route path="/marketplace" element={<MarketplacePage />} />
                        <Route path="/hot-listings" element={<HotListingsPage />} />
                        <Route path="/sell" element={<SellPage />} />
                        <Route path="/terms" element={<TermsPage />} />
                        <Route path="/privacy" element={<PrivacyPage />} />
                      </Routes>
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
