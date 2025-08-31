import './styles.css';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import MarketplaceAbi from './abi/VTRUNFTMarketplace.json';
import { Analytics } from '@vercel/analytics/react';

// Components
import Navigation from './components/Navigation';
import Footer from './layout/Footer';
import './layout/Footer.css';

// Lazy-loaded pages (code-splitting)
const HomePage = lazy(() => import('./pages/HomePage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const MarketplacePage = lazy(() => import('./pages/MarketplacePage'));
const HotListingsPage = lazy(() => import('./pages/HotListingsPage'));
const TermsPage = lazy(() => import('./pages/TermsPage'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'));
const SellPage = lazy(() => import('./pages/SellPage'));
const CollectionPage = lazy(() => import('./pages/CollectionPage'));

// Auction pages (lazy-loaded)
const CreateAuctionPage = lazy(() => import('./pages/CreateAuctionPage'));
const AuctionDetailPage = lazy(() => import('./pages/AuctionDetailPage'));
const MyAuctionsPage = lazy(() => import('./pages/MyAuctionsPage'));
const AdminPathsPage = lazy(() => import('./pages/AdminPathsPage'));
const VibeDashboardPage = lazy(() => import('./pages/VibeDashboardPage'));

// Providers
import { WalletProvider } from './context/WalletContext';
import { MarketplaceProvider } from './context/MarketplaceContext';
import { SupabaseProvider } from './context/SupabaseContext';

const rpcUrl = import.meta.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
const marketplaceAddress = import.meta.env.VITE_MARKETPLACE_ADDRESS || '';

// Alias so /collection/:address also works
function CollectionAliasRedirect() {
    const { address } = useParams();
    return <Navigate to={`/collections/${address}`} replace />;
}

// Scroll to hash (anchors) or top on route change
function ScrollToTop() {
    const { pathname, hash } = useLocation();
    useEffect(() => {
        if (hash && hash.length > 1) {
            const el = document.getElementById(hash.slice(1));
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
        }
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }, [pathname, hash]);
    return null;
}

// Lightweight route change progress bar (reduced-motion aware)
function RouteProgressBar() {
    const { pathname } = useLocation();
    const [visible, setVisible] = useState(false);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const prefersReduced = typeof window !== 'undefined' &&
            window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let growT = 0, finT = 0, hideT = 0;
        setVisible(true);
        setWidth(prefersReduced ? 100 : 8);

        if (!prefersReduced) {
            growT = window.setInterval(() => {
                setWidth((w) => (w < 85 ? Math.min(85, w + 7) : w));
            }, 60);
            finT = window.setTimeout(() => {
                setWidth(100);
                hideT = window.setTimeout(() => { setVisible(false); setWidth(0); }, 240);
            }, 320);
        } else {
            // No animation: show briefly
            hideT = window.setTimeout(() => { setVisible(false); setWidth(0); }, 160);
        }

        return () => {
            window.clearInterval(growT);
            window.clearTimeout(finT);
            window.clearTimeout(hideT);
        };
    }, [pathname]);

    if (!visible) return null;
    return (
        <div style={{
            position: 'fixed',
            top: 0, left: 0, height: 3,
            width: `${width}%`,
            background: 'linear-gradient(90deg, #5533ff, #ff3366, #33ccff)',
            boxShadow: '0 0 8px rgba(85,51,255,.6)',
            zIndex: 9999,
            transition: 'width .22s ease'
        }} />
    );
}

// Online/offline banner
function OnlineStatusBanner() {
    const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
    useEffect(() => {
        const on = () => setOnline(true);
        const off = () => setOnline(false);
        window.addEventListener('online', on);
        window.addEventListener('offline', off);
        return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
    }, []);
    if (online) return null;
    return (
        <div style={{
            position: 'fixed', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            padding: '8px 14px', borderRadius: 10,
            background: 'rgba(255, 51, 102, .15)', color: '#fff',
            border: '1px solid rgba(255,255,255,.12)', backdropFilter: 'blur(8px)',
            zIndex: 9999, fontSize: 14
        }}>
            You are offline. Some data may be stale.
        </div>
    );
}

// Env warning (missing marketplace address)
function EnvWarningBanner() {
    if (marketplaceAddress && marketplaceAddress !== '0x0000000000000000000000000000000000000000') return null;
    return (
        <div style={{
            position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)',
            padding: '8px 12px', borderRadius: 8, zIndex: 9998,
            background: 'rgba(255,170,51,.15)', color: '#fff',
            border: '1px solid rgba(255,255,255,.14)', backdropFilter: 'blur(6px)', fontSize: 13
        }}>
            Warning: VITE_MARKETPLACE_ADDRESS is not set. Using placeholder address.
        </div>
    );
}

// Simple error boundary for lazy-loaded routes
class RouteErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) { return { hasError: true, error }; }
    componentDidCatch(error, info) { console.error('Route render error:', error, info); }
    render() {
        if (this.state.hasError) {
            return (
                <div className="hp" style={{ maxWidth: 900, margin: '3rem auto', padding: '0 1.25rem' }}>
                    <h2 style={{ marginBottom: '.5rem' }}>Something went wrong</h2>
                    <p style={{ color: 'var(--hp-muted)' }}>
                        The page failed to load. Try refreshing or go back to the homepage.
                    </p>
                    <div style={{ marginTop: '1rem' }}>
                        <a href="/" className="hp-btn hp-btn--primary">Go Home</a>
                        <button className="hp-btn" style={{ marginLeft: 8 }} onClick={() => window.location.reload()}>Refresh</button>
                    </div>
                    {import.meta.env.MODE !== 'production' && this.state.error && (
                        <pre style={{ marginTop: '1rem', whiteSpace: 'pre-wrap', opacity: .8 }}>
                            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
                        </pre>
                    )}
                </div>
            );
        }
        return this.props.children;
    }
}

// Dynamic document title per route
function TitleSetter() {
    const { pathname } = useLocation();
    useEffect(() => {
        const siteName = 'BlockDust';
        const map = [
            { test: /^\/$/, title: `${siteName} ✦ Neon NFT Marketplace` },
            { test: /^\/marketplace/, title: `Marketplace • ${siteName} ✦` },
            { test: /^\/hot-listings/, title: `🔥 Hot Listings • ${siteName}` },
            { test: /^\/sell/, title: `List & Sell • ${siteName}` },
            { test: /^\/profile/, title: `Your Profile • ${siteName}` },
            { test: /^\/collections\/[0-9a-zA-Z]+/, title: `Collection • ${siteName}` },
            { test: /^\/my-auctions/, title: `My Auctions • ${siteName}` },
            { test: /^\/auctions\/create/, title: `Create Auction • ${siteName}` },
            { test: /^\/auctions\/[0-9]+/, title: `Auction • ${siteName}` },
            { test: /^\/vibe-dashboard/, title: `VIBE Dashboard • ${siteName}` },
            { test: /^\/admin\/paths/, title: `Admin Paths • ${siteName}` },
            { test: /^\/terms/, title: `Terms • ${siteName}` },
            { test: /^\/privacy/, title: `Privacy • ${siteName}` },
        ];
        const found = map.find(m => m.test.test(pathname));
        document.title = found ? found.title : siteName;
    }, [pathname]);
    return null;
}

// Idle route prefetch (speeds up subsequent navigations)
function useIdleRoutePrefetch() {
    useEffect(() => {
        const preloaders = [
            () => import('./pages/MarketplacePage'),
            () => import('./pages/HotListingsPage'),
            () => import('./pages/SellPage'),
            () => import('./pages/ProfilePage'),
            () => import('./pages/CreateAuctionPage'),
            () => import('./pages/MyAuctionsPage'),
            () => import('./pages/AuctionDetailPage'),
            () => import('./pages/VibeDashboardPage'),
            () => import('./pages/CollectionPage'),
            () => import('./pages/TermsPage'),
            () => import('./pages/PrivacyPage'),
        ];
        const run = () => preloaders.forEach((fn, i) => setTimeout(() => { try { fn(); } catch { /* ignore */ } }, 50 + i * 60));
        const ri = (window.requestIdleCallback || ((cb) => setTimeout(cb, 250)));
        const id = ri(run, { timeout: 1500 });
        return () => clearTimeout(id);
    }, []);
}

function App() {
    useIdleRoutePrefetch();

    return (
        <SupabaseProvider>
            <WalletProvider rpcUrl={rpcUrl}>
                {/* Pass ABI array, not the whole artifact */}
                <MarketplaceProvider marketplaceAddress={marketplaceAddress} abi={MarketplaceAbi.abi}>
                    <BrowserRouter>
                        <RouteProgressBar />
                        <ScrollToTop />
                        <TitleSetter />
                        <OnlineStatusBanner />
                        <EnvWarningBanner />
                        <div className="app-container">
                            <Navigation />
                            <div className="main-content">
                                <RouteErrorBoundary>
                                    <Suspense fallback={
                                        <div className="hp" style={{ maxWidth: 900, margin: '3rem auto', padding: '0 1.25rem' }}>
                                            <div className="hp-section__head"><h2>Loading…</h2></div>
                                            <div className="hp-mini">
                                                <div className="hp-mini__card"><div className="hp-mini__label">Preparing</div><div className="hp-mini__value">…</div></div>
                                                <div className="hp-mini__card"><div className="hp-mini__label">Routes</div><div className="hp-mini__value">…</div></div>
                                                <div className="hp-mini__card"><div className="hp-mini__label">Assets</div><div className="hp-mini__value">…</div></div>
                                            </div>
                                        </div>
                                    }>
                                        <Routes>
                                            <Route path="/" element={<HomePage />} />
                                            <Route path="/profile" element={<ProfilePage />} />
                                            <Route path="/marketplace" element={<MarketplacePage />} />
                                            <Route path="/hot-listings" element={<HotListingsPage />} />
                                            <Route path="/sell" element={<SellPage />} />
                                            <Route path="/terms" element={<TermsPage />} />
                                            <Route path="/privacy" element={<PrivacyPage />} />

                                            {/* collections routes */}
                                            <Route path="/collections" element={<div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
                                                <div className="hp-section__head"><h2>Collections</h2></div>
                                                <p style={{ color: 'var(--hp-muted)' }}>Pick a collection from the homepage or marketplace.</p>
                                            </div>} />
                                            <Route path="/collections/:address" element={<CollectionPage />} />
                                            <Route path="/collection/:address" element={<CollectionAliasRedirect />} />

                                            {/* Auction routes - always enabled */}
                                            <Route path="/auctions/create" element={<CreateAuctionPage />} />
                                            <Route path="/auctions/:id" element={<AuctionDetailPage />} />
                                            <Route path="/my-auctions" element={<MyAuctionsPage />} />
                                            <Route path="/admin/paths" element={<AdminPathsPage />} />
                                            <Route path="/vibe-dashboard" element={<VibeDashboardPage />} />

                                            {/* Fallback */}
                                            <Route path="*" element={<Navigate to="/" replace />} />
                                        </Routes>
                                    </Suspense>
                                </RouteErrorBoundary>
                            </div>
                            <Footer />
                        </div>
                        {import.meta.env.PROD && <Analytics />}
                    </BrowserRouter>
                </MarketplaceProvider>
            </WalletProvider>
        </SupabaseProvider>
    );
}

export default App;