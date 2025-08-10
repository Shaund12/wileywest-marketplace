import './styles.css';
import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { ethers } from 'ethers';
import MarketplaceAbi from './abi/Marketplace.json';
import { createClient } from '@supabase/supabase-js';
import { Analytics } from '@vercel/analytics/react';

// Components
import Navigation from './components/Navigation';
import Footer from './layout/Footer';
import './layout/Footer.css';
import HomePage from './pages/HomePage';
import ProfilePage from './pages/ProfilePage';
import MarketplacePage from './pages/MarketplacePage';
import HotListingsPage from './pages/HotListingsPage';
import TermsPage from './pages/TermsPage';
import PrivacyPage from './pages/PrivacyPage';
import SellPage from './pages/SellPage';
import CollectionPage from './pages/CollectionPage'; // ✅ NEW

// Providers
import { WalletProvider } from './context/WalletContext';
import { MarketplaceProvider } from './context/MarketplaceContext';
import { SupabaseProvider } from './context/SupabaseContext';

// Optional Supabase client - only create if URL is provided
let supabase = null;
try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseKey && supabaseUrl !== 'https://dummy.supabase.co') {
        supabase = createClient(supabaseUrl, supabaseKey);
    }
} catch (error) {
    console.warn('Supabase not configured, continuing without it:', error.message);
}

const rpcUrl = import.meta.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
const marketplaceAddress = import.meta.env.VITE_MARKETPLACE_ADDRESS || '';

// Small index component (optional)
function CollectionsIndex() {
    return (
        <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head"><h2>Collections</h2></div>
            <p style={{ color: 'var(--hp-muted)' }}>Pick a collection from the homepage or marketplace.</p>
        </div>
    );
}

// Alias so /collection/:address also works
function CollectionAliasRedirect() {
    const { address } = useParams();
    return <Navigate to={`/collections/${address}`} replace />;
}

function App() {
    return (
        <SupabaseProvider>
            <WalletProvider rpcUrl={rpcUrl}>
                <MarketplaceProvider marketplaceAddress={marketplaceAddress} abi={MarketplaceAbi}>
                    <BrowserRouter>
                        <div className="app-container">
                            <Navigation />
                            <div className="main-content">
                                <Routes>
                                    <Route path="/" element={<HomePage />} />
                                    <Route path="/profile" element={<ProfilePage />} />
                                    <Route path="/marketplace" element={<MarketplacePage />} />
                                    <Route path="/hot-listings" element={<HotListingsPage />} />
                                    <Route path="/sell" element={<SellPage />} />
                                    <Route path="/terms" element={<TermsPage />} />
                                    <Route path="/privacy" element={<PrivacyPage />} />

                                    {/* ✅ NEW: collections routes */}
                                    <Route path="/collections" element={<CollectionsIndex />} />
                                    <Route path="/collections/:address" element={<CollectionPage />} />
                                    <Route path="/collection/:address" element={<CollectionAliasRedirect />} />

                                    {/* Fallback */}
                                    <Route path="*" element={<Navigate to="/" replace />} />
                                </Routes>
                            </div>
                            <Footer />
                        </div>
                        <Analytics />
                    </BrowserRouter>
                </MarketplaceProvider>
            </WalletProvider>
        </SupabaseProvider>
    );
}

export default App;
