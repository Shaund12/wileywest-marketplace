import React, { useMemo, useState, useEffect, useRef } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, ExternalLink, Menu, X, Check, ChevronDown, ChevronUp, Activity, Sun, Moon } from 'lucide-react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import { usePremiumWallet } from '../context/PremiumWalletContext';
import { ComplianceWalletButton } from './ComplianceWalletButton';
import ChainSwitcher from './ChainSwitcher';
import { Button } from './ui/button';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { cn } from '../lib/utils';
import { chainHasFeature, activeChain } from '../config/chains.js';
import { useTheme } from '../context/ThemeContext';
import logo from '../assets/blockdust-logo.png';
import {
    fetchTokenPriceInUSDC,
    USDC_POL_ADDRESS,
    WVTRU_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    fetchTokenDetails
} from '../utils/tokenUtils';

// wallet_addEthereumChain params for the ACTIVE chain (Hyve or Vitruveo).
const _navChain = activeChain();
const VITRUVEO = {
    chainIdHex: '0x' + _navChain.id.toString(16),
    chainIdDec: _navChain.id,
    chainName: _navChain.name,
    rpcUrls: [_navChain.rpcUrl],
    blockExplorerUrls: [_navChain.explorer],
    nativeCurrency: { name: _navChain.name, symbol: _navChain.symbol, decimals: 18 },
};

const UNISWAP_V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

const UNISWAP_V3_POOL_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)',
    'function liquidity() external view returns (uint128)',
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

// Minimal ABI to read token balances
const ERC20_BALANCE_ABI = [
    'function balanceOf(address owner) view returns (uint256)'
];

const FEE_TIERS = [500, 3000, 10000];

function shorten(addr) {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Get pool address from factory (try common fee tiers)
async function getUniswapPool(tokenA, tokenB, provider) {
    try {
        const factory = new ethers.Contract(
            UNISWAP_V3_FACTORY_ADDRESS,
            UNISWAP_V3_FACTORY_ABI,
            provider
        );

        for (const fee of FEE_TIERS) {
            try {
                const poolAddress = await factory.getPool(tokenA, tokenB, fee);
                if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                    return { poolAddress, fee };
                }
            } catch {
                // ignore per-tier errors
            }
        }
        return { poolAddress: null, fee: null };
    } catch (error) {
        console.error('Error getting pool address', error);
        return { poolAddress: null, fee: null };
    }
}

function formatAmount(num, isUSDC) {
    if (num === null || num === undefined || Number.isNaN(num)) return '0';
    if (isUSDC) return Number(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (num >= 1000) return Number(num).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return Number(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export default function Navigation() {
    const { wallet, chainId, connectionError, provider } = useWallet();
    const { isDark, toggleTheme } = useTheme();
    const { address: premiumAddress, isConnected: premiumConnected, isCorrectNetwork } = usePremiumWallet();
    const [menuOpen, setMenuOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const location = useLocation();
    const [tokenPrice, setTokenPrice] = useState(null);
    const [isLoadingPrice, setIsLoadingPrice] = useState(false);

    const [showLPDetails, setShowLPDetails] = useState(false);
    const [lpDetails, setLpDetails] = useState({
        poolAddress: null,
        fee: null,
        loading: false,
        token0: null,
        token1: null,
        symbol0: null,
        symbol1: null,
        decimals0: 18,
        decimals1: 18,
        reserve0: null,
        reserve1: null,
        tick: null
    });
    const lpDetailsRef = useRef(null);

    const onVitruveo = useMemo(() => Number(chainId || 0) === VITRUVEO.chainIdDec, [chainId]);

    // Use premium wallet state when available, fallback to legacy wallet
    const connectedAddress = premiumConnected ? premiumAddress : wallet;
    const isWalletConnected = premiumConnected || !!wallet;
    const isOnCorrectNetwork = premiumConnected ? isCorrectNetwork : onVitruveo;

    // Close LP details dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event) {
            if (lpDetailsRef.current && !lpDetailsRef.current.contains(event.target)) {
                setShowLPDetails(false);
            }
        }

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    // Active-chain price: HYVE uses the configured launch estimate; VTRU uses
    // the live BSC DexScreener feed implemented by tokenUtils.
    useEffect(() => {
        async function fetchTokenPrice() {
            if (!provider) return;

            setIsLoadingPrice(true);
            try {
                const price = await fetchTokenPriceInUSDC(ethers.ZeroAddress, provider);
                setTokenPrice(price);
            } catch (error) {
                console.error(`Failed to fetch ${_navChain.symbol} price:`, error);
            } finally {
                setIsLoadingPrice(false);
            }
        }

        fetchTokenPrice();
        const interval = setInterval(fetchTokenPrice, 120_000);
        return () => clearInterval(interval);
    }, [provider]);

    // Fetch LP details when dropdown is opened - REAL on-chain balances
    useEffect(() => {
        async function fetchLPDetails() {
            if (!showLPDetails || !provider) return;

            setLpDetails(prev => ({ ...prev, loading: true }));
            try {
                // Resolve pool (WVTRU/USDC)
                const { poolAddress, fee } = await getUniswapPool(WVTRU_ADDRESS, USDC_POL_ADDRESS, provider);
                if (!poolAddress) throw new Error('Pool not found');

                const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
                const [token0, token1, feeData, slot0Data] = await Promise.all([
                    pool.token0(),
                    pool.token1(),
                    pool.fee(),
                    pool.slot0()
                ]);

                // Fetch token metadata
                const [t0, t1] = await Promise.all([
                    fetchTokenDetails(token0, provider),
                    fetchTokenDetails(token1, provider)
                ]);

                // Read actual ERC20 balances held by pool
                const erc0 = new ethers.Contract(token0, ERC20_BALANCE_ABI, provider);
                const erc1 = new ethers.Contract(token1, ERC20_BALANCE_ABI, provider);
                const [bal0, bal1] = await Promise.all([
                    erc0.balanceOf(poolAddress),
                    erc1.balanceOf(poolAddress)
                ]);

                // Format reserves
                const reserve0 = Number(ethers.formatUnits(bal0, t0.decimals));
                const reserve1 = Number(ethers.formatUnits(bal1, t1.decimals));

                setLpDetails({
                    poolAddress,
                    fee: Number(feeData),
                    token0,
                    token1,
                    symbol0: t0.symbol || 'TOKEN0',
                    symbol1: t1.symbol || 'TOKEN1',
                    decimals0: t0.decimals ?? 18,
                    decimals1: t1.decimals ?? 18,
                    reserve0,
                    reserve1,
                    tick: Number(slot0Data.tick),
                    loading: false
                });
            } catch (error) {
                console.error('Failed to fetch LP details:', error);
                setLpDetails(prev => ({ ...prev, loading: false, error: error.message }));
            }
        }

        fetchLPDetails();
    }, [showLPDetails, provider]);

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
        { to: "/explore", label: "Explore NFTs" },
        { to: "/sell", label: "Sell NFT" },
        { to: "/auctions/create", label: "Create Auction" },
        // VIBE is a Vitruveo-only feature — hide it on chains without it (Hyve).
        ...(chainHasFeature('vibe') ? [{ to: "/vibe-dashboard", label: "VIBE" }] : []),
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
                        {/* Chain switcher (Hyve ⇄ Vitruveo) */}
                        <ChainSwitcher />
                        {/* Theme toggle */}
                        <button
                            type="button"
                            onClick={toggleTheme}
                            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
                            aria-pressed={isDark}
                            title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
                            className="inline-flex items-center justify-center h-9 w-9 rounded-full border border-white/10 bg-white/5 text-foreground hover:bg-white/10 transition-colors"
                        >
                            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                        </button>
                        {/* Active-chain price. Retired Vitruveo pool details are
                            intentionally not exposed; VTRU uses the BSC feed. */}
                        <div className="hidden sm:block relative" ref={lpDetailsRef}>
                            <motion.div
                                className={cn(
                                    "flex items-center px-3 py-1.5 rounded-full text-xs font-medium border",
                                    "bg-neon-green/10 text-neon-green border-neon-green/30"
                                )}
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                transition={{ delay: 0.3 }}
                                title={_navChain.key === 'vitruveo'
                                    ? 'Live VTRU/USD market price from the BSC DexScreener feed'
                                    : 'Estimated HYVE launch price'}
                            >
                                <div className="flex items-center">
                                    <span className="mr-1">{_navChain.symbol}:</span>
                                    {isLoadingPrice ? (
                                        <span className="animate-pulse">Loading...</span>
                                    ) : tokenPrice ? (
                                        <span>${Number(tokenPrice).toFixed(6)}</span>
                                    ) : (
                                        <span>$--.--</span>
                                    )}
                                    <span className="ml-1 opacity-70">
                                        {_navChain.key === 'vitruveo' ? 'BSC live' : 'est.'}
                                    </span>
                                </div>
                            </motion.div>

                            {/* Retired WVTRU/USDC pool dropdown intentionally disabled. */}
                            <AnimatePresence>
                                {false && showLPDetails && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        transition={{ duration: 0.2 }}
                                        className="absolute z-50 mt-2 w-80 rounded-md border border-neon-green/30 bg-card/95 backdrop-blur p-3 shadow-lg"
                                    >
                                        <div className="text-sm font-medium mb-2 text-neon-green flex items-center justify-between">
                                            <span>VTRU/USDC Pool Info</span>
                                            <Activity className="h-4 w-4" />
                                        </div>

                                        {lpDetails.loading ? (
                                            <div className="py-2 text-center">
                                                <div className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-solid border-neon-green border-r-transparent"></div>
                                                <p className="text-xs mt-1">Loading pool data...</p>
                                            </div>
                                        ) : lpDetails.error ? (
                                            <div className="py-2 text-center text-destructive text-xs">
                                                Failed to load pool data: {lpDetails.error}
                                            </div>
                                        ) : (
                                            <>
                                                <div className="space-y-2 text-xs">
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-muted-foreground">Current Price:</span>
                                                        <span className="font-mono text-neon-green">
                                                            ${tokenPrice ? Number(tokenPrice).toFixed(6) : '--'}
                                                        </span>
                                                    </div>

                                                    <div className="flex justify-between items-center">
                                                        <span className="text-muted-foreground">Pool Fee:</span>
                                                        <span className="font-mono">
                                                            {lpDetails.fee !== null ? `${lpDetails.fee / 10000}%` : '--'}
                                                        </span>
                                                    </div>

                                                    {/* Real on-chain reserves */}
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-muted-foreground">Reserves:</span>
                                                        <span className="font-mono text-right">
                                                            {lpDetails.reserve0 !== null && lpDetails.symbol0
                                                                ? `${formatAmount(lpDetails.reserve0, /USDC/i.test(lpDetails.symbol0))} ${lpDetails.symbol0}`
                                                                : '--'}
                                                            {'  |  '}
                                                            {lpDetails.reserve1 !== null && lpDetails.symbol1
                                                                ? `${formatAmount(lpDetails.reserve1, /USDC/i.test(lpDetails.symbol1))} ${lpDetails.symbol1}`
                                                                : '--'}
                                                        </span>
                                                    </div>

                                                    <div className="flex justify-between items-center">
                                                        <span className="text-muted-foreground">Current Tick:</span>
                                                        <span className="font-mono">
                                                            {lpDetails.tick ?? '--'}
                                                        </span>
                                                    </div>

                                                    {lpDetails.poolAddress && (
                                                        <div className="pt-1">
                                                            <a
                                                                href={`${VITRUVEO.blockExplorerUrls[0]}/address/${lpDetails.poolAddress}`}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="text-neon-cyan hover:text-neon-cyan/80 flex items-center justify-center w-full text-xs font-medium mt-1 py-1 rounded-md border border-neon-cyan/30 hover:bg-neon-cyan/5"
                                                            >
                                                                View Pool on Explorer
                                                                <ExternalLink className="ml-1 h-3 w-3" />
                                                            </a>
                                                        </div>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

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
                                {!isWalletConnected ? 'No wallet' : isOnCorrectNetwork ? _navChain.name : 'Wrong network'}
                            </span>
                        </motion.div>

                        {/* Compliance-enabled Wallet Button (with sanctions checking) */}
                        <ComplianceWalletButton />

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

                                {/* Active-chain price in mobile menu */}
                                <motion.div
                                    initial={{ x: -50, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    transition={{ delay: navLinks.length * 0.1 }}
                                    className="px-4 py-2 text-sm"
                                >
                                    <div
                                        className="flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium bg-neon-green/10 text-neon-green border border-neon-green/30"
                                        title={_navChain.key === 'vitruveo'
                                            ? 'Live VTRU/USD market price from BSC'
                                            : 'Estimated HYVE launch price'}
                                    >
                                        <div className="flex items-center">
                                            <span className="mr-1">{_navChain.symbol}:</span>
                                            {isLoadingPrice ? (
                                                <span className="animate-pulse">Loading...</span>
                                            ) : tokenPrice ? (
                                                <span>${Number(tokenPrice).toFixed(6)}</span>
                                            ) : (
                                                <span>$--.--</span>
                                            )}
                                        </div>
                                        <span className="opacity-70">
                                            {_navChain.key === 'vitruveo' ? 'BSC live' : 'est.'}
                                        </span>
                                    </div>

                                    {/* Retired pool details intentionally disabled. */}
                                    <AnimatePresence>
                                        {false && showLPDetails && (
                                            <motion.div
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: "auto" }}
                                                exit={{ opacity: 0, height: 0 }}
                                                transition={{ duration: 0.2 }}
                                                className="mt-2 p-3 rounded-md border border-neon-green/20 bg-black/20"
                                            >
                                                {lpDetails.loading ? (
                                                    <div className="py-2 text-center">
                                                        <div className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-neon-green border-r-transparent"></div>
                                                        <p className="text-xs mt-1">Loading pool data...</p>
                                                    </div>
                                                ) : lpDetails.error ? (
                                                    <div className="text-center text-destructive text-xs">
                                                        Failed to load pool data: {lpDetails.error}
                                                    </div>
                                                ) : (
                                                    <div className="space-y-1 text-xs">
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Price:</span>
                                                            <span>${tokenPrice ? Number(tokenPrice).toFixed(6) : '--'}</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Fee:</span>
                                                            <span>{lpDetails.fee !== null ? `${lpDetails.fee / 10000}%` : '--'}</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Reserves:</span>
                                                            <span className="text-right">
                                                                {lpDetails.reserve0 !== null && lpDetails.symbol0
                                                                    ? `${formatAmount(lpDetails.reserve0, /USDC/i.test(lpDetails.symbol0))} ${lpDetails.symbol0}`
                                                                    : '--'}
                                                                {'  |  '}
                                                                {lpDetails.reserve1 !== null && lpDetails.symbol1
                                                                    ? `${formatAmount(lpDetails.reserve1, /USDC/i.test(lpDetails.symbol1))} ${lpDetails.symbol1}`
                                                                    : '--'}
                                                            </span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Tick:</span>
                                                            <span>{lpDetails.tick ?? '--'}</span>
                                                        </div>
                                                    </div>
                                                )}
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </motion.div>

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
                                                onClick={async () => {
                                                    await copyAddress();
                                                }}
                                                className="font-mono text-xs"
                                            >
                                                {copied ? (
                                                    <Check className="mr-1 h-3 w-3 text-neon-green" />
                                                ) : (
                                                    <Copy className="mr-1 h-3 w-3" />
                                                )}
                                                {shorten(connectedAddress)}
                                            </Button>
                                            <Button variant="ghost" size="sm" asChild>
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
