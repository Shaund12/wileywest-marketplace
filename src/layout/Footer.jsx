import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import CacheStats from '../components/CacheStats';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
import logo from '../assets/blockdust-logo.png';

/* ====== config (env-friendly, with sane fallbacks) ====== */
const EXPLORER_URL = import.meta.env.VITE_BLOCK_EXPLORER_URL || 'https://explorer.vitruveo.xyz';
const CHAIN_NAME = import.meta.env.VITE_CHAIN_NAME || 'Vitruveo';
const RAW_CHAIN_ID = (import.meta.env.VITE_CHAIN_ID || '0x5d2').toLowerCase(); // 1490
const NEWSLETTER_ENDPOINT = import.meta.env.VITE_NEWSLETTER_ENDPOINT || '';     // optional

/* ====== tiny helpers ====== */
const toDec = (id) => {
    try { return typeof id === 'string' && id.startsWith('0x') ? parseInt(id, 16) : Number(id); }
    catch { return NaN; }
};
const formatUSD = (n) => (typeof n === 'number' && isFinite(n)) ? `$${n < 0.01 ? n.toFixed(6) : n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—';

function ExternalIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z" /><path fill="currentColor" d="M5 5h6V3H3v8h2V5z" />
        </svg>
    );
}

function SocialLink({ href, label, children }) {
    return (
        <a className="bd-social" href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
            {children}
        </a>
    );
}

/* ====== Footer ====== */
export default function Footer() {
    const year = new Date().getFullYear();

    const { wallet, isConnected, connect, chainId: liveChainId } = useWallet();
    const { listings, marketplaceStats } = useMarketplace();
    const { isConnected: supaUp, cacheStats } = useSupabase();

    const [theme, setTheme] = useState(
        (localStorage.getItem('theme') || document.documentElement.dataset.theme || 'dark')
    );
    const [email, setEmail] = useState('');
    const [nlState, setNlState] = useState({ status: 'idle', message: '' });

    const totalListings = listings?.length || 0;
    const vol24h = marketplaceStats?.volume24h ?? null;

    const isCorrectNetwork = useMemo(() => {
        const want = toDec(RAW_CHAIN_ID);
        const got = toDec(liveChainId);
        return want && got && want === got;
    }, [liveChainId]);

    /* theme toggle */
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('theme', theme);
    }, [theme]);

    const toggleTheme = useCallback(() => {
        setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
    }, []);

    /* newsletter submit */
    const onNewsletterSubmit = async (e) => {
        e.preventDefault();
        if (!email || !/.+@.+\..+/.test(email)) {
            setNlState({ status: 'error', message: 'Enter a valid email.' });
            return;
        }
        try {
            setNlState({ status: 'loading', message: 'Subscribing…' });
            if (NEWSLETTER_ENDPOINT) {
                const res = await fetch(NEWSLETTER_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email }),
                });
                if (!res.ok) throw new Error('Subscription failed');
                setNlState({ status: 'done', message: 'Subscribed! Check your inbox.' });
                setEmail('');
            } else {
                // no backend → graceful fallback
                window.location.href = `mailto:support@blockdust.xyz?subject=Subscribe%20me&body=${encodeURIComponent(email)}`;
                setNlState({ status: 'done', message: 'Opening your mail app…' });
            }
        } catch (err) {
            setNlState({ status: 'error', message: 'Could not subscribe. Try again.' });
        }
    };

    const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

    return (
        <footer className="bd-footer" role="contentinfo">
            <div className="bd-footer__grid">
                {/* Brand + tagline + socials */}
                <section className="bd-brand">
                    <div className="bd-brand__row">
                        <img src={logo} width="44" height="44" alt="" className="bd-logo" />
                        <div className="bd-brand__text">
                            <h3 className="bd-brand__title">BlockDust</h3>
                            <p className="bd-brand__tag">Trade in the neon shadows. Own the future.</p>
                        </div>
                    </div>

                    <div className="bd-socials">
                        <SocialLink href="https://x.com/" label="X / Twitter">
                            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M22 5.8 13.9 16.4 21.4 24H18L12.9 18.8 8.1 24H2l8.7-10.2L3 0h4l5.1 5.6L16.7 0H22l-7.7 9z" /></svg>
                        </SocialLink>
                        <SocialLink href="https://discord.gg/dRGmv5PgQE" label="Discord">
                            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M20 0c1.1 0 2 .9 2 2v22l-2.6-2.2-1.4-1.3-1.5-1.4.6 2.4H4c-1.1 0-2-.9-2-2V2C2 .9 2.9 0 4 0h16zm-5.2 6.8c-.7-.3-1.5-.6-2.3-.7l-.3.6c-.8-.1-1.6-.1-2.4 0l-.3-.6c-.8.2-1.6.5-2.3.7C6 9 5.6 11.1 5.7 13.3c1 .8 2 1.4 3.1 1.9.2-.3.5-.6.8-.9-1.7-.5-2.4-1.5-2.4-1.5s.1.1.3.2c0 0 0 0 0 0 .1.1.1.1.2.1.6.3 1.1.5 1.6.7.7.3 1.5.5 2.3.5.8 0 1.6-.2 2.3-.5.5-.2 1.1-.4 1.7-.7 0 0-.7 1-2.4 1.5.3.3.5.6.8.9 1.1-.4 2.1-1.1 3.1-1.9.2-2.3-.2-4.3-1.4-6.5zM9.3 12.8c-.6 0-1.1-.5-1.1-1.1 0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1zm5.4 0c-.6 0-1.1-.5-1.1-1.1 0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1z" /></svg>
                        </SocialLink>
                        <SocialLink href="https://github.com/" label="GitHub">
                            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6V21c-3.3.7-4-1.6-4-1.6-.5-1.3-1.2-1.7-1.2-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.1 1.7 1.1 1 .1.8-.7 1.7-1 0 0 .8-.5 1.9-.3.1-.8.4-1.4.8-1.7-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.5 1.2-3.4-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.5 1.3a12 12 0 0 1 6.4 0c2.5-1.6 3.5-1.3 3.5-1.3.6 1.6.2 2.9.1 3.2.8.9 1.2 2.1 1.2 3.4 0 4.5-2.7 5.4-5.3 5.8.4.3.8 1 .8 2v3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" /></svg>
                        </SocialLink>
                        <SocialLink href="https://t.me/" label="Telegram">
                            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M9.9 15.4 9.6 20c.5 0 .8-.2 1.1-.5l2.6-2.5 5.3 3.9c1 .6 1.7.3 2-.9l3.6-16.7C24.4 1.1 23.7.6 22.8 1L1.1 9.4c-1 .4-1 1 0 1.3l5.5 1.7L20.6 4.9c.6-.4 1.2-.2.7.2L9.9 15.4z" /></svg>
                        </SocialLink>
                    </div>

                    {/* live mini-stats */}
                    <div className="bd-stats">
                        <div className="bd-stat">
                            <span className="bd-stat__label">Network</span>
                            <span className={`bd-stat__value ${isCorrectNetwork ? 'ok' : 'warn'}`}>
                                {CHAIN_NAME}{' '}
                                <small>{isCorrectNetwork ? '✓' : 'switch needed'}</small>
                            </span>
                        </div>
                        <div className="bd-stat">
                            <span className="bd-stat__label">Listings</span>
                            <span className="bd-stat__value">{totalListings}</span>
                        </div>
                        <div className="bd-stat">
                            <span className="bd-stat__label">24h Volume</span>
                            <span className="bd-stat__value">{formatUSD(vol24h)}</span>
                        </div>
                        <div className="bd-stat">
                            <span className="bd-stat__label">Cache</span>
                            <span className={`bd-stat__value ${supaUp ? 'ok' : 'warn'}`} title="Supabase cache status">
                                {supaUp ? 'online' : 'offline'}
                            </span>
                        </div>
                    </div>

                    <div className="bd-actions">
                        {!isConnected ? (
                            <button className="bd-btn bd-btn--primary" onClick={connect} aria-label="Connect wallet">
                                Connect Wallet
                            </button>
                        ) : (
                            <a className="bd-btn" href={`${EXPLORER_URL}/address/${wallet}`} target="_blank" rel="noopener noreferrer">
                                View on Explorer <ExternalIcon />
                            </a>
                        )}
                        <button className="bd-btn bd-btn--ghost" onClick={toggleTheme} aria-pressed={theme === 'dark'}>
                            {theme === 'dark' ? '🌙 Dark' : '☀️ Light'}
                        </button>
                    </div>

                    {/* cache widget you already had */}
                    <div className="bd-cache">
                        <CacheStats />
                    </div>
                </section>

                {/* link columns (accessible accordions on mobile via <details>) */}
                <nav className="bd-links" aria-label="Footer">
                    <details className="bd-col" open>
                        <summary><h4>Marketplace</h4></summary>
                        <Link to="/marketplace">All NFTs</Link>
                        <Link to="/hot-listings">Hot Listings</Link>
                        <Link to="/sell">Sell NFT</Link>
                    </details>

                    <details className="bd-col" open>
                        <summary><h4>Account</h4></summary>
                        <Link to="/profile">Profile</Link>
                        <Link to="/profile?tab=collection">My Collection</Link>
                        <Link to="/profile?tab=activity">Activity</Link>
                    </details>

                    <details className="bd-col" open>
                        <summary><h4>Resources</h4></summary>
                        <a href={EXPLORER_URL} target="_blank" rel="noopener noreferrer">Vitruveo Explorer <ExternalIcon /></a>
                        <a href="https://status.supabase.com" target="_blank" rel="noopener noreferrer">Supabase Status <ExternalIcon /></a>
                    </details>

                    <details className="bd-col" open>
                        <summary><h4>Legal</h4></summary>
                        <Link to="/terms">Terms of Service</Link>
                        <Link to="/privacy">Privacy Policy</Link>
                    </details>
                </nav>
            </div>

            {/* bottom bar */}
            <div className="bd-bottom">
                <p>© {year} BlockDust NFT Marketplace — All rights reserved.</p>
                <div className="bd-bottom__right">
                    <button className="bd-top" onClick={scrollTop} aria-label="Back to top">↑ Top</button>
                </div>
            </div>
        </footer>
    );
}
