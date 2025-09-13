import React, { useMemo, useState, useEffect, useRef } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, ExternalLink, Menu, X, Wallet, Check, ChevronDown, ChevronUp, Activity } from 'lucide-react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import { usePremiumWallet } from '../context/PremiumWalletContext';
import { PremiumWalletButton } from './PremiumWalletButton';
import { Button } from './ui/button';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { cn } from '../lib/utils';
import logo from '../assets/blockdust-logo.png';
import {
    fetchTokenPriceInUSDC,
    USDC_POL_ADDRESS,
    WVTRU_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS
} from '../utils/tokenUtils';

const VITRUVEO = {
    chainIdHex: '0x5d2', // 1490
    chainIdDec: 1490,
    chainName: 'Vitruveo',
    rpcUrls: ['https://rpc.vitruveo.xyz'],
    blockExplorerUrls: ['https://explorer.vitruveo.xyz'],
    nativeCurrency: { name: 'Vitruveo', symbol: 'VTRU', decimals: 18 },
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

const FEE_TIERS = [500, 3000, 10000];

function shorten(addr) {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Get pool address from factory
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

// Format large numbers to readable format
function formatLargeNumber(num) {
    if (!num) return '0';

    if (num >= 1e9) {
        return (num / 1e9).toFixed(2) + 'B';
    } else if (num >= 1e6) {
        return (num / 1e6).toFixed(2) + 'M';
    } else if (num >= 1e3) {
        return (num / 1e3).toFixed(2) + 'K';
    } else {
        return num.toString();
    }
}

export default function Navigation() {
    const { wallet, connect, disconnect, chainId, isConnecting, connectionError, provider } = useWallet();
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
        liquidity: null,
        tvl: null,
        lastUpdate: null
    });
    const lpDetailsRef = useRef(null);

    const onVitruveo = useMemo(() => Number(chainId || 0) === VITRUVEO.chainIdDec, [chainId]);

    // Use premium wallet state when available, fallback to old wallet
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

    // Fetch VTRU price using tokenUtils
    useEffect(() => {
        async function fetchTokenPrice() {
            if (!provider) return;

            setIsLoadingPrice(true);
            try {
                // Use fetchTokenPriceInUSDC from tokenUtils for native VTRU
                const price = await fetchTokenPriceInUSDC(ethers.ZeroAddress, provider);
                setTokenPrice(price);
            } catch (error) {
                console.error('Failed to fetch VTRU price:', error);
            } finally {
                setIsLoadingPrice(false);
            }
        }

        fetchTokenPrice();

        // Refresh price every 2 minutes
        const interval = setInterval(fetchTokenPrice, 2 * 60 * 1000);
        return () => clearInterval(interval);
    }, [provider]);

    // Fetch LP details when dropdown is opened - using real blockchain data
    useEffect(() => {
        async function fetchLPDetails() {
            if (!showLPDetails || !provider) return;

            setLpDetails(prev => ({ ...prev, loading: true }));
            try {
                // Get pool info from Uniswap Factory
                const { poolAddress, fee } = await getUniswapPool(
                    WVTRU_ADDRESS,
                    USDC_POL_ADDRESS,
                    provider
                );

                if (!poolAddress) {
                    throw new Error('Pool not found');
                }

                // Get real pool data from pool contract
                const poolContract = new ethers.Contract(
                    poolAddress,
                    UNISWAP_V3_POOL_ABI,
                    provider
                );

                // Get token0, token1, fee, and liquidity data - REAL ON-CHAIN DATA
                const [token0, token1, feeData, liquidityData, slot0Data] = await Promise.all([
                    poolContract.token0(),
                    poolContract.token1(),
                    poolContract.fee(),
                    poolContract.liquidity(),
                    poolContract.slot0()
                ]);

                // Do not attempt to estimate TVL with simplified math
                // Instead show the raw liquidity value which is actual blockchain data
                setLpDetails({
                    poolAddress,
                    fee: Number(feeData),
                    liquidity: liquidityData.toString(),
                    tick: Number(slot0Data.tick),
                    sqrtPriceX96: slot0Data.sqrtPriceX96.toString(),
                    loading: false,
                    lastUpdate: new Date().toISOString()
                });

            } catch (error) {
                console.error('Failed to fetch LP details:', error);
                setLpDetails(prev => ({
                    ...prev,
                    loading: false,
                    error: error.message
                }));
            }
        }

        fetchLPDetails();
    }, [showLPDetails, provider, tokenPrice]);

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
                        {/* Token Price Display with Dropdown */}
                        <div className="hidden sm:block relative" ref={lpDetailsRef}>
                            <motion.div
                                className={cn(
                                    "flex items-center px-3 py-1.5 rounded-full text-xs font-medium border cursor-pointer",
                                    showLPDetails
                                        ? "bg-neon-green/20 text-neon-green border-neon-green/50"
                                        : "bg-neon-green/10 text-neon-green border-neon-green/30"
                                )}
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                transition={{ delay: 0.3 }}
                                onClick={() => setShowLPDetails(!showLPDetails)}
                            >
                                <div className="flex items-center">
                                    <span className="mr-1">VTRU:</span>
                                    {isLoadingPrice ? (
                                        <span className="animate-pulse">Loading...</span>
                                    ) : tokenPrice ? (
                                        <span>${Number(tokenPrice).toFixed(4)}</span>
                                    ) : (
                                        <span>$--.--</span>
                                    )}
                                    <span className="ml-1">
                                        {showLPDetails ? (
                                            <ChevronUp className="h-3 w-3" />
                                        ) : (
                                            <ChevronDown className="h-3 w-3" />
                                        )}
                                    </span>
                                </div>
                            </motion.div>

                            {/* LP Details Dropdown */}
                            <AnimatePresence>
                                {showLPDetails && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        transition={{ duration: 0.2 }}
                                        className="absolute z-50 mt-2 w-72 rounded-md border border-neon-green/30 bg-card/95 backdrop-blur p-3 shadow-lg"
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
                                                            {lpDetails.fee ? `${lpDetails.fee / 10000}%` : '--'}
                                                        </span>
                                                    </div>
                                                    
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-muted-foreground">Raw Liquidity:</span>
                                                        <span className="font-mono text-xs" title={lpDetails.liquidity}>
                                                            {lpDetails.liquidity ? ethers.formatUnits(lpDetails.liquidity, 0) : '--'}
                                                        </span>
                                                    </div>
                                                    
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-muted-foreground">Current Tick:</span>
                                                        <span className="font-mono">
                                                            {lpDetails.tick !== undefined ? lpDetails.tick : '--'}
                                                        </span>
                                                    </div>
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

                                {/* Token Price in mobile menu with toggle for details */}
                                <motion.div
                                    initial={{ x: -50, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    transition={{ delay: navLinks.length * 0.1 }}
                                    className="px-4 py-2 text-sm"
                                >
                                    <div
                                        className="flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium bg-neon-green/10 text-neon-green border border-neon-green/30"
                                        onClick={() => setShowLPDetails(!showLPDetails)}
                                    >
                                        <div className="flex items-center">
                                            <span className="mr-1">VTRU:</span>
                                            {isLoadingPrice ? (
                                                <span className="animate-pulse">Loading...</span>
                                            ) : tokenPrice ? (
                                                <span>${Number(tokenPrice).toFixed(4)}</span>
                                            ) : (
                                                <span>$--.--</span>
                                            )}
                                        </div>
                                        <span>
                                            {showLPDetails ? (
                                                <ChevronUp className="h-3 w-3" />
                                            ) : (
                                                <ChevronDown className="h-3 w-3" />
                                            )}
                                        </span>
                                    </div>

                                    {/* Mobile LP Details */}
                                    <AnimatePresence>
                                        {showLPDetails && (
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
                                                ) : (
                                                    <div className="space-y-1 text-xs">
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Price:</span>
                                                            <span>${tokenPrice ? Number(tokenPrice).toFixed(6) : '--'}</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Fee:</span>
                                                            <span>{lpDetails.fee ? `${lpDetails.fee / 10000}%` : '--'}</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Liquidity:</span>
                                                            <span>{lpDetails.liquidity ? formatLargeNumber(lpDetails.liquidity) : '--'}</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Est. TVL:</span>
                                                            <span>{lpDetails.tvl ? `$${formatLargeNumber(lpDetails.tvl)}` : '--'}</span>
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