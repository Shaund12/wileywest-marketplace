import React, { useMemo, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, ExternalLink, Menu, X, Wallet, Check } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { usePremiumWallet } from '../context/PremiumWalletContext';
import { PremiumWalletButton } from './PremiumWalletButton';
import { Button } from './ui/button';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { cn } from '../lib/utils';
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
    const { address: premiumAddress, isConnected: premiumConnected, isCorrectNetwork } = usePremiumWallet();
    const [menuOpen, setMenuOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const location = useLocation();

    const onVitruveo = useMemo(() => Number(chainId || 0) === VITRUVEO.chainIdDec, [chainId]);
    
    // Use premium wallet state when available, fallback to old wallet
    const connectedAddress = premiumConnected ? premiumAddress : wallet;
    const isWalletConnected = premiumConnected || !!wallet;
    const isOnCorrectNetwork = premiumConnected ? isCorrectNetwork : onVitruveo;

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
            await navigator.clipboard.writeText(connectedAddress);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch (e) {
            console.error('Copy failed', e);
        }
    }

    const navLinks = [
        { to: "/marketplace", label: "Marketplace" },
        { to: "/hot-listings", label: "Hot Listings" },
        { to: "/sell", label: "Sell NFT" },
        { to: "/auctions/create", label: "Create Auction" },
        { to: "/vibe-dashboard", label: "VIBE" },
    ];

    return (
        <TooltipProvider>
            <motion.header 
                className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
                initial={{ y: -100 }}
                animate={{ y: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
                <div className="container flex h-16 max-w-screen-2xl items-center justify-between px-4">
                    {/* Logo */}
                    <motion.div 
                        className="flex items-center space-x-4"
                        whileHover={{ scale: 1.05 }}
                        transition={{ type: "spring", stiffness: 400, damping: 10 }}
                    >
                        <Link 
                            to="/" 
                            className="flex items-center space-x-2 text-lg font-bold"
                            aria-label="BlockDust Home"
                        >
                            <motion.img 
                                src={logo} 
                                alt="" 
                                className="h-8 w-8 rounded-lg"
                                whileHover={{ rotate: 360 }}
                                transition={{ duration: 0.6 }}
                            />
                            <span className="neon-text-cyan font-extrabold tracking-tight">
                                BlockDust
                            </span>
                        </Link>
                    </motion.div>

                    {/* Desktop Navigation */}
                    <nav className="hidden md:flex items-center space-x-1" aria-label="Primary">
                        {navLinks.map((link) => (
                            <NavLink
                                key={link.to}
                                to={link.to}
                                className={({ isActive }) =>
                                    cn(
                                        "px-3 py-2 text-sm font-medium transition-all duration-200 rounded-md relative group",
                                        isActive
                                            ? "text-neon-cyan neon-text-cyan bg-primary/10"
                                            : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                                    )
                                }
                            >
                                {({ isActive }) => (
                                    <>
                                        {link.label}
                                        {isActive && (
                                            <motion.div
                                                className="absolute inset-0 bg-primary/20 rounded-md neon-border-cyan"
                                                layoutId="activeTab"
                                                initial={false}
                                                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                            />
                                        )}
                                    </>
                                )}
                            </NavLink>
                        ))}
                    </nav>

                    {/* Right side actions */}
                    <div className="flex items-center space-x-3">
                        {/* Network indicator */}
                        <motion.div
                            className={cn(
                                "hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-medium border",
                                isWalletConnected
                                    ? isOnCorrectNetwork
                                        ? "bg-neon-green/10 text-neon-green border-neon-green/30"
                                        : "bg-neon-pink/10 text-neon-pink border-neon-pink/30"
                                    : "bg-muted/50 text-muted-foreground border-muted"
                            )}
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ delay: 0.2 }}
                        >
                            <div
                                className={cn(
                                    "w-2 h-2 rounded-full",
                                    isWalletConnected
                                        ? isOnCorrectNetwork
                                            ? "bg-neon-green animate-pulse"
                                            : "bg-neon-pink animate-pulse"
                                        : "bg-muted-foreground"
                                )}
                            />
                            <span>
                                {!isWalletConnected ? 'No wallet' : isOnCorrectNetwork ? 'Vitruveo' : 'Wrong network'}
                            </span>
                        </motion.div>

                        {/* Premium Wallet Button */}
                        <PremiumWalletButton />

                        {/* Mobile menu button */}
                        <Button
                            variant="ghost"
                            size="sm"
                            className="md:hidden"
                            onClick={() => setMenuOpen(!menuOpen)}
                            aria-label="Toggle menu"
                            aria-expanded={menuOpen}
                        >
                            <motion.div
                                animate={{ rotate: menuOpen ? 180 : 0 }}
                                transition={{ duration: 0.2 }}
                            >
                                {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                            </motion.div>
                        </Button>
                    </div>
                </div>

                {/* Mobile Navigation */}
                <AnimatePresence>
                    {menuOpen && (
                        <motion.div
                            className="md:hidden border-t border-border bg-card/95 backdrop-blur"
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2 }}
                        >
                            <nav className="container py-4 space-y-2">
                                {navLinks.map((link, index) => (
                                    <motion.div
                                        key={link.to}
                                        initial={{ x: -50, opacity: 0 }}
                                        animate={{ x: 0, opacity: 1 }}
                                        transition={{ delay: index * 0.1 }}
                                    >
                                        <NavLink
                                            to={link.to}
                                            className={({ isActive }) =>
                                                cn(
                                                    "block px-4 py-2 text-sm font-medium rounded-md transition-colors",
                                                    isActive
                                                        ? "text-neon-cyan bg-primary/10 neon-border-cyan"
                                                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                                                )
                                            }
                                            onClick={() => setMenuOpen(false)}
                                        >
                                            {link.label}
                                        </NavLink>
                                    </motion.div>
                                ))}

                                {/* Mobile wallet info */}
                                {isWalletConnected && (
                                    <motion.div
                                        className="pt-4 border-t border-border mt-4"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ delay: 0.3 }}
                                    >
                                        <div className="flex items-center justify-between px-4 py-2">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={copyAddress}
                                                className="font-mono text-xs"
                                            >
                                                {copied ? (
                                                    <Check className="mr-1 h-3 w-3 text-neon-green" />
                                                ) : (
                                                    <Copy className="mr-1 h-3 w-3" />
                                                )}
                                                {shorten(connectedAddress)}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                asChild
                                            >
                                                <a
                                                    href={`${VITRUVEO.blockExplorerUrls[0]}/address/${connectedAddress}`}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    <ExternalLink className="h-4 w-4" />
                                                </a>
                                            </Button>
                                        </div>
                                    </motion.div>
                                )}
                            </nav>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Connection Error Banner */}
                <AnimatePresence>
                    {connectionError && (
                        <motion.div
                            className="bg-destructive/10 border-t border-destructive/20 px-4 py-2 text-center text-sm text-destructive"
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                        >
                            {connectionError}
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.header>
        </TooltipProvider>
    );
}
