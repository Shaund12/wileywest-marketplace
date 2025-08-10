import React, { useMemo, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import logo from '../assets/blockdust-logo.png';

const VITRUVEO = {
    chainIdHex: '0x5d2', // 1490
    chainIdDec: 1490,
    chainName: 'Vitruveo',
    rpcUrls: ['https://rpc.vitruveo.xyz'],
    blockExplorerUrls: ['https://explorer.vitruveo.xyz'],
    nativeCurrency: { name: 'Vitruveo', symbol: 'VTRU', decimals: 18 },
};

function shorten(addr) {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function Navigation() {
    const { wallet, connect, disconnect, chainId, isConnecting, connectionError } = useWallet();
    const [menuOpen, setMenuOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const location = useLocation();

    const onVitruveo = useMemo(() => Number(chainId || 0) === VITRUVEO.chainIdDec, [chainId]);

    async function switchToVitruveo() {
        if (!window.ethereum) return;
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: VITRUVEO.chainIdHex }],
            });
        } catch (err) {
            // Unrecognized chain: add and switch
            if (err?.code === 4902 || /Unrecognized chain ID/i.test(err?.message)) {
                try {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: VITRUVEO.chainIdHex,
                            chainName: VITRUVEO.chainName,
                            rpcUrls: VITRUVEO.rpcUrls,
                            blockExplorerUrls: VITRUVEO.blockExplorerUrls,
                            nativeCurrency: VITRUVEO.nativeCurrency,
                        }],
                    });
                } catch (addErr) {
                    console.error('Add chain error', addErr);
                }
            } else {
                console.error('Switch chain error', err);
            }
        }
    }

    async function copyAddress() {
        try {
            await navigator.clipboard.writeText(wallet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch (e) {
            console.error('Copy failed', e);
        }
    }

    return (
        <header className="bd-nav">
            <div className="bd-nav__wrap">
                <div className="bd-nav__left">
                    <Link to="/" className="bd-nav__brand" aria-label="BlockDust Home">
                        <img src={logo} alt="" className="bd-nav__logo" />
                        <span className="bd-nav__title">BlockDust</span>
                    </Link>

                    <nav className={`bd-nav__links ${menuOpen ? 'is-open' : ''}`} aria-label="Primary">
                        <NavLink to="/marketplace" className={({ isActive }) => `bd-link ${isActive ? 'is-active' : ''}`}>
                            Marketplace
                        </NavLink>
                        <NavLink to="/hot-listings" className={({ isActive }) => `bd-link ${isActive ? 'is-active' : ''}`}>
                            Hot Listings
                        </NavLink>
                        <NavLink to="/sell" className={({ isActive }) => `bd-link ${isActive ? 'is-active' : ''}`}>
                            Sell NFT
                        </NavLink>
                    </nav>
                </div>

                <div className="bd-nav__right">
                    {/* Network pill */}
                    <div
                        className={`bd-net ${wallet ? (onVitruveo ? 'ok' : 'warn') : ''}`}
                        title={
                            !wallet ? 'Wallet not connected' : onVitruveo ? 'Connected to Vitruveo' : 'Wrong network'
                        }
                    >
                        <span className="bd-dot" />
                        {wallet ? (onVitruveo ? 'Vitruveo' : 'Wrong network') : 'No wallet'}
                    </div>

                    {/* Wallet actions */}
                    {!wallet ? (
                        <button
                            className="bd-btn bd-btn--primary"
                            onClick={connect}
                            disabled={isConnecting}
                            aria-busy={isConnecting}
                        >
                            {isConnecting ? 'Connecting…' : 'Connect Wallet'}
                        </button>
                    ) : (
                        <div className="bd-wallet">
                            {!onVitruveo && (
                                <button className="bd-btn bd-btn--warning" onClick={switchToVitruveo}>
                                    Switch to Vitruveo
                                </button>
                            )}

                            <Link to="/profile" className="bd-btn bd-btn--ghost" aria-current={location.pathname.startsWith('/profile') ? 'page' : undefined}>
                                My Profile
                            </Link>

                            <div className="bd-addr">
                                <button className="bd-addr__btn" onClick={copyAddress} title="Copy address">
                                    {shorten(wallet)}
                                </button>
                                {copied && <span className="bd-addr__copied">Copied</span>}
                                <a
                                    className="bd-addr__explorer"
                                    href={`${VITRUVEO.blockExplorerUrls[0]}/address/${wallet}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    title="View on explorer"
                                >
                                    ↗
                                </a>
                            </div>

                            <button className="bd-btn bd-btn--ghost" onClick={disconnect}>
                                Disconnect
                            </button>
                        </div>
                    )}

                    <button
                        className={`bd-burger ${menuOpen ? 'is-open' : ''}`}
                        onClick={() => setMenuOpen(v => !v)}
                        aria-label="Toggle menu"
                        aria-expanded={menuOpen}
                        aria-controls="primary-navigation"
                    >
                        <span />
                        <span />
                        <span />
                    </button>
                </div>
            </div>

            {connectionError && (
                <div className="bd-nav__notice" role="status">
                    {connectionError}
                </div>
            )}
        </header>
    );
}
