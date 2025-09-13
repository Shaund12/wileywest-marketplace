// src/pages/MarketplacePage.jsx
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { useSupabase } from '../context/SupabaseContext';
import ListingCard from '../components/ListingCard';
import EmptyState from '../components/EmptyState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { convertToUSDCValue, formatPriceWithUSDC } from '../utils/tokenUtils';
import { isAuctionsEnabled } from '../utils/featureFlags';
import { loadNFTMetadata as loadMetadata } from '../utils/metadataLoader';
import { isVShareContract, getVShareMetadata, vShareLpSvgDataUrl } from '../utils/vShareUtils';
import { getCollectionName, isKnownCollection } from '../utils/knownCollections.js';
import { ethers } from 'ethers';
import { motion } from 'framer-motion';
import './MarketplacePage.css';
import blockdustLogo from '../assets/blockdust-logo.png';
// IMPORTANT: use on-chain ABI with auction events/functions
// IMPORTANT: use on-chain ABI with auction events/functions
import VtruMarketplaceArtifact from '../abi/VTRUNFTMarketplace.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';

/* =========================
   On-chain collection name resolver
   ========================= */
const ERC721_METADATA_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
];

const ERC721_URI_ABI = [
    'function tokenURI(uint256 tokenId) view returns (string)',
];

const ERC1155_URI_ABI = [
    'function uri(uint256 id) view returns (string)',
];

const shortAddr = (a = '') => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

/** Resolve ERC721 collection names; caches results locally to avoid repeat RPCs */
function useCollectionNames(addresses = [], provider) {
    const [names, setNames] = useState({}); // { [lowerAddr]: 'Cool Cats' | null }

    useEffect(() => {
        let cancelled = false;
        if (!provider) return;

        const uniq = Array.from(new Set(addresses.filter(Boolean).map((a) => a.toLowerCase())));
        const missing = uniq.filter((a) => !(a in names));
        if (missing.length === 0) return;

        (async () => {
            const entries = await Promise.all(
                missing.map(async (addr) => {
                    try {
                        const c = new ethers.Contract(addr, ERC721_METADATA_ABI, provider);
                        let label = '';
                        try { label = await c.name(); } catch {
                            try { label = await c.symbol(); } catch { }
                        }
                        label = (label && String(label).trim()) || null;
                        return [addr, label];
                    } catch {
                        return [addr, null];
                    }
                })
            );

            if (!cancelled) {
                setNames((prev) => {
                    const next = { ...prev };
                    for (const [addr, label] of entries) {
                        if (!(addr in next)) next[addr] = label; // may be null
                    }
                    return next;
                });
            }
        })();

        return () => { cancelled = true; };
    }, [provider, addresses.join('|'), names]);

    return names;
}

/* =========================
   Smart IPFS Image + SVG fallback
   ========================= */
const IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/',              // Official gateway - most reliable
    'https://dweb.link/ipfs/',            // Protocol Labs gateway
    'https://gateway.pinata.cloud/ipfs/', // Pinata gateway - good CORS support
    'https://w3s.link/ipfs/',             // Web3.Storage gateway
    'https://nftstorage.link/ipfs/',      // NFT.Storage gateway
    'https://4everland.io/ipfs/',         // 4everland gateway
];
const IPNS_GATEWAYS = [
    'https://ipfs.io/ipns/',              // Official gateway - most reliable
    'https://dweb.link/ipns/',            // Protocol Labs gateway
    'https://gateway.pinata.cloud/ipns/', // Pinata gateway - good CORS support
    'https://w3s.link/ipns/',             // Web3.Storage gateway
    'https://nftstorage.link/ipns/',      // NFT.Storage gateway
    'https://4everland.io/ipns/',         // 4everland gateway
];

const smartImageCache = new Map(); // key -> working URL
const safeStr = (v, d = '') => (typeof v === 'string' ? v : d);

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
    return Math.abs(h);
}
function svgFallbackDataUrl({ seed = 'nft', width = 300, height = 200, title = '', contractAddress = '', tokenId = '' }) {
    // Special handling for V-Share contracts
    if (contractAddress && isVShareContract(contractAddress)) {
        return vShareLpSvgDataUrl({ 
            contract: contractAddress, 
            tokenId: tokenId.toString(), 
            width, 
            height,
            title: 'V-Share',
            subtitle: 'Vmonsters Rev Share' 
        });
    }

    const h = hashString(seed);
    const hue = h % 360;
    const hue2 = (hue + 180) % 360;
    const gradId = `g${(h % 1e9).toString(36)}`;
    const blobs = (h % 7) + 3;
    const label = title ? title.slice(0, 22) : 'Vitruveo NFT';
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},70%,18%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},70%,16%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#${gradId})"/>
  ${Array.from({ length: blobs }).map((_, i) => {
        const a = (h + i * 97) % 360;
        const r = 14 + ((h >> i) % 40);
        const cx = (width / (blobs + 1)) * (i + 1);
        const cy = (height / (blobs + 1)) * ((i % 3) + 1);
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${a},70%,60%,0.25)"/>`;
    }).join('')}
  <text x="50%" y="${height - 14}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="14" fill="rgba(255,255,255,0.9)" text-anchor="middle">
    ${label}
  </text>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function expandToCandidateUrls(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const url = raw.trim();
    if (!url) return [];
    if (url.startsWith('data:')) return [url];

    if (url.startsWith('ar://')) return [`https://arweave.net/${url.slice(5)}`];
    if (/^https?:\/\/arweave\.net\//i.test(url)) return [url];

    if (url.startsWith('ipfs://')) {
        let rest = url.slice(7).replace(/^ipfs\//i, '');
        return IPFS_GATEWAYS.map((g) => g + rest);
    }
    if (url.startsWith('ipns://')) {
        let rest = url.slice(7).replace(/^ipns\//i, '');
        return IPNS_GATEWAYS.map((g) => g + rest);
    }

    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const ipfsIdx = parts.indexOf('ipfs');
        const ipnsIdx = parts.indexOf('ipns');
        if (ipfsIdx !== -1 && parts[ipfsIdx + 1]) {
            const rest = parts.slice(ipfsIdx + 1).join('/');
            return IPFS_GATEWAYS.map((g) => g + rest);
        }
        if (ipnsIdx !== -1 && parts[ipnsIdx + 1]) {
            const rest = parts.slice(ipnsIdx + 1).join('/');
            return IPNS_GATEWAYS.map((g) => g + rest);
        }
        return [url];
    } catch {
        if (/^[a-z0-9]+$/i.test(url)) {
            return IPFS_GATEWAYS.map((g) => g + url);
        }
        return [url];
    }
}

function uniq(arr) { const s = new Set(); const out = []; for (const x of arr) if (!s.has(x)) { s.add(x); out.push(x); } return out; }
function flatten(arrs) { const out = []; for (const a of arrs) out.push(...a); return out; }

function findFirstWorkingImage(candidates, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        if (!candidates?.length) return reject(new Error('No candidates'));
        if (typeof window === 'undefined') return reject(new Error('SSR window unavailable'));
        let idx = 0, settled = false;

        const tryNext = () => {
            if (settled) return;
            if (idx >= candidates.length) return reject(new Error('No working image'));
            const test = candidates[idx++];
            const img = new Image();
            const timer = setTimeout(() => { img.onload = img.onerror = null; tryNext(); }, timeoutMs);
            img.onload = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(test); };
            img.onerror = () => { clearTimeout(timer); tryNext(); };
            img.src = test + (test.includes('?') ? '&' : '?') + 'cb=' + Date.now();
        };
        tryNext();
    });
}

function SmartImage({
    src,
    srcList = [],
    alt = '',
    className,
    width = 300,
    height = 200,
    seed = 'nft',
    title = '',
    contractAddress = '',
    tokenId = ''
}) {
    const [url, setUrl] = useState(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const raws = [];
        if (src) raws.push(src);
        if (Array.isArray(srcList)) raws.push(...srcList);

        const key = raws.join('|');
        if (smartImageCache.has(key)) { setUrl(smartImageCache.get(key)); setFailed(false); return; }

        const candidates = uniq(flatten(raws.map(expandToCandidateUrls)));
        if (!candidates.length) { setUrl(null); setFailed(true); return; }

        findFirstWorkingImage(candidates)
            .then((u) => { if (cancelled) return; smartImageCache.set(key, u); setUrl(u); setFailed(false); })
            .catch(() => { if (cancelled) return; setUrl(null); setFailed(true); });

        return () => { cancelled = true; };
    }, [src, JSON.stringify(srcList)]);

    const finalSrc = failed || !url ? svgFallbackDataUrl({ seed, width, height, title, contractAddress, tokenId }) : url;

    return (
        <img
            src={finalSrc}
            alt={alt}
            className={className}
            width={width}
            height={height}
            loading="lazy"
            crossOrigin="anonymous"
            onError={() => { if (!failed) setFailed(true); }}
            style={{ objectFit: 'cover', display: 'block', borderRadius: 8 }}
        />
    );
}

/* =========================
   Icons
   ========================= */
const RefreshIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="m3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
    </svg>
);
const DeepIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2l3 5h-6l3-5zm0 20l-3-5h6l-3 5zM2 12l5-3v6l-5-3zm20 0l-5 3V9l5 3z" />
    </svg>
);
const SearchIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
);
const FilterIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
    </svg>
);
const GridIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7"></rect>
        <rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect>
        <rect x="3" y="14" width="7" height="7"></rect>
    </svg>
);
const ListIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"></line>
        <line x1="8" y1="12" x2="21" y2="12"></line>
        <line x1="8" y1="18" x2="21" y2="18"></line>
        <line x1="3" y1="6" x2="3.01" y2="6"></line>
        <line x1="3" y1="12" x2="3.01" y2="12"></line>
        <line x1="3" y1="18" x2="3.01" y2="18"></line>
    </svg>
);

/* =========================
   Timestamp helpers (24h recency)
   ========================= */
const nowMs = () => Date.now();
function coerceMs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') {
        return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
    if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
        const d = Date.parse(v);
        return Number.isNaN(d) ? NaN : d;
    }
    if (v && typeof v === 'object') {
        if (typeof v.seconds === 'number') return Math.round(v.seconds * 1000);
        if (typeof v.toString === 'function') {
            const n = Number(v.toString());
            if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
        }
    }
    return NaN;
}
const timeLeft = (endMs) => {
    const d = Math.max(0, endMs - Date.now());
    const s = Math.floor(d / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
};

/* =========================
   UI Prefs persistence
   ========================= */
const PREFS_KEY = 'marketplace_ui_prefs_v1';

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return {};

        const prefs = JSON.parse(raw);

        // Clear potentially problematic filter states that might hide all listings
        // These will be reset to empty/default values to ensure listings are visible
        const cleanPrefs = {
            ...prefs,
            // Reset search and filters to prevent hiding all listings
            searchTerm: '',
            selectedCategories: [],
            selectedCollections: [],
            priceRange: { min: '', max: '' },
            // Keep safe UI preferences
            viewMode: prefs.viewMode || 'grid',
            sortMethod: prefs.sortMethod || 'newest',
            itemsPerPage: prefs.itemsPerPage || 12,
            trendMode: prefs.trendMode || 'volume',
            autoRefreshEnabled: Boolean(prefs.autoRefreshEnabled),
            autoRefreshMs: prefs.autoRefreshMs || 60000,
            autoLoadNext: Boolean(prefs.autoLoadNext)
        };

        return cleanPrefs;
    } catch {
        return {};
    }
}
function savePrefs(next) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

function MarketplacePage() {
    const {
        listings,
        hotListings,
        fetchListings,
        triggerManualSync,
        status,
        setStatus,
        isInitialized,
        marketplaceStats,
        canceledListings,
        marketplaceAddress, // + address for contracts
    } = useMarketplace();

    const { wallet, connect, provider } = useWallet();
    const { cacheListings, isConnected: supabaseConnected, supabase } = useSupabase();

    const prefs = useRef(loadPrefs());

    const [searchTerm, setSearchTerm] = useState(prefs.current.searchTerm || '');
    const [filteredListings, setFilteredListings] = useState([]);
    const [viewMode, setViewMode] = useState(prefs.current.viewMode || 'grid');
    const [sortMethod, setSortMethod] = useState(prefs.current.sortMethod || 'newest');
    const [isLoading, setIsLoading] = useState(true);
    const [isFiltersOpen, setIsFiltersOpen] = useState(false);
    const [selectedCategories, setSelectedCategories] = useState(prefs.current.selectedCategories || []);
    const [selectedCollections, setSelectedCollections] = useState(prefs.current.selectedCollections || []);
    const [priceRange, setPriceRange] = useState(prefs.current.priceRange || { min: '', max: '' });
    const [featuredNFT, setFeaturedNFT] = useState(null);
    const [featuredNFTPriceDisplay, setFeaturedNFTPriceDisplay] = useState({
        tokenAmount: '...',
        tokenSymbol: 'TOKEN',
        usdcValue: '0.00',
        formatted: '...',
        hasUSDCRate: true,
    });
    const [collections, setCollections] = useState([]);
    const [stats, setStats] = useState({
        totalVolume: 0,
        totalListings: 0,
        avgPrice: 0,
        floorPrice: 0,
        currentListingVolume: 0,
        actualSoldVolume: 0,
        hasUSDCRates: true,
    });
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage, setItemsPerPage] = useState(prefs.current.itemsPerPage || 12);
    const [trendMode, setTrendMode] = useState(prefs.current.trendMode || 'volume'); // 'volume' | 'hot' | 'new'
    const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(Boolean(prefs.current.autoRefreshEnabled));
    const [autoRefreshMs, setAutoRefreshMs] = useState(prefs.current.autoRefreshMs || 60000);
    const [autoLoadNext, setAutoLoadNext] = useState(Boolean(prefs.current.autoLoadNext));
    const [nextRefreshAt, setNextRefreshAt] = useState(null);

    // NEW: Auctions state
    const [auctions, setAuctions] = useState([]);
    const [isAuctionsLoading, setIsAuctionsLoading] = useState(false);
    const auctionsEnabled = isAuctionsEnabled();

    const topRef = useRef(null);
    const hasLoadedRef = useRef(false);
    const cacheSigRef = useRef('');
    const searchInputRef = useRef(null);
    const sentinelRef = useRef(null);

    // 24h cutoff for "hot"
    const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

    // Categories for filtering
    const categories = [
        { id: 'art', name: 'Art' },
        { id: 'collectibles', name: 'Collectibles' },
        { id: 'photography', name: 'Photography' },
        { id: 'sports', name: 'Sports' },
        { id: 'utility', name: 'Utility' },
        { id: 'music', name: 'Music' },
        { id: 'gaming', name: 'Gaming' },
    ];

    // Persist UI prefs
    useEffect(() => {
        savePrefs({
            searchTerm,
            viewMode,
            sortMethod,
            selectedCategories,
            selectedCollections,
            priceRange,
            itemsPerPage,
            trendMode,
            autoRefreshEnabled,
            autoRefreshMs,
            autoLoadNext,
        });
    }, [
        searchTerm,
        viewMode,
        sortMethod,
        selectedCategories,
        selectedCollections,
        priceRange,
        itemsPerPage,
        trendMode,
        autoRefreshEnabled,
        autoRefreshMs,
        autoLoadNext,
    ]);

    /* ----------------------------
       Resolve collection names (addresses on screen + featured/filters)
       ---------------------------- */
    const addressesNeedingNames = useMemo(() => {
        const s = new Set();
        for (const c of collections || []) if (c?.address) s.add(c.address.toLowerCase());
        if (featuredNFT?.nftContract) s.add(featuredNFT.nftContract.toLowerCase());
        for (const addr of selectedCollections || []) s.add(addr.toLowerCase());
        // include auctions collections
        for (const a of auctions || []) if (a.nftContract) s.add(a.nftContract.toLowerCase());
        return Array.from(s);
    }, [collections, featuredNFT, selectedCollections, auctions]);

    const nameMap = useCollectionNames(addressesNeedingNames, provider);

    const labelForAddress = useCallback(
        (addr, fallbackName = '') => {
            const key = (addr || '').toLowerCase();
            const resolved = nameMap[key];
            const base = (fallbackName || '').trim();
            const baseLooksLikeAddr = /^collection\s+0x/i.test(base) || base.toLowerCase() === 'collection' || base === '';
            
            // Try known collections first, then resolved name, then fallback
            const knownName = getCollectionName(addr, null);
            if (knownName) {
                return knownName;
            }
            
            return resolved || (!baseLooksLikeAddr && base) || shortAddr(addr);
        },
        [nameMap]
    );

    const labelForCollection = useCallback(
        (collection) => labelForAddress(collection?.address, collection?.name),
        [labelForAddress]
    );

    /* ----------------------------
       Deep rescan support (clear caches + scan from genesis)
       ---------------------------- */
    const clearLocalCaches = useCallback(() => {
        try {
            const keysToClear = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                if (
                    key.startsWith('nft_cache_') ||
                    key === 'nft_contract_cache' ||
                    key === 'nft_metadata_cache' ||
                    key === 'known_erc20_tokens' ||
                    key.toLowerCase().includes('listing') ||
                    key.toLowerCase().includes('marketplace')
                ) {
                    keysToClear.push(key);
                }
            }
            keysToClear.forEach(k => localStorage.removeItem(k));
            localStorage.setItem('NFT_SCAN_MODE', 'comprehensive');
            localStorage.setItem('MARKETPLACE_FULL_RESCAN_AT', String(Date.now()));
        } catch {
            // ignore
        }
    }, []);

    const deepRescan = useCallback(async () => {
        try {
            setIsLoading(true);
            setStatus && setStatus('Triggering fresh data sync...');
            clearLocalCaches();
            
            // Use the new API-based sync instead of blockchain scanning
            if (triggerManualSync) {
                await triggerManualSync();
            } else {
                // Fallback to cache refresh
                await fetchListings(true);
            }
        } catch (error) {
            criticalError('[Marketplace] Deep rescan error:', error);
            setStatus && setStatus('Error refreshing listings');
        } finally {
            setIsLoading(false);
        }
    }, [triggerManualSync, fetchListings, clearLocalCaches, setStatus]);

    /* ----------------------------
       Auto-refresh + keyboard shortcuts
       ---------------------------- */
    useEffect(() => {
        if (!autoRefreshEnabled) return;
        let active = true;
        const tick = async () => {
            if (!active) return;
            setNextRefreshAt(Date.now() + autoRefreshMs);
            try {
                await fetchListings(true);
                if (auctionsEnabled) await fetchAuctions(false);
            } catch (e) {
                debugWarn('[Marketplace] Auto-refresh failed:', e);
            } finally {
                if (active) {
                    setTimeout(tick, autoRefreshMs);
                }
            }
        };
        const id = setTimeout(tick, autoRefreshMs);
        return () => { active = false; clearTimeout(id); };
    }, [autoRefreshEnabled, autoRefreshMs, fetchListings, auctionsEnabled]);

    useEffect(() => {
        const onKey = (e) => {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
            if (e.key === '/') { e.preventDefault(); searchInputRef.current?.focus(); }
            if (e.key.toLowerCase() === 'r') { fetchListings(true); if (auctionsEnabled) fetchAuctions(false); }
            if (e.key.toLowerCase() === 'd') { deepRescan(); }
            if (e.key.toLowerCase() === 'g') { setViewMode('grid'); }
            if (e.key.toLowerCase() === 'l') { setViewMode('list'); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [fetchListings, deepRescan, auctionsEnabled]);

    /* ----------------------------
       Load listings
       ---------------------------- */
    useEffect(() => {
        async function loadData() {
            if (!hasLoadedRef.current && isInitialized && fetchListings) {
                try {
                    setIsLoading(true);
                    await fetchListings();
                    if (auctionsEnabled) await fetchAuctions(false);
                    hasLoadedRef.current = true;
                } catch (error) {
                    criticalError('[Marketplace] Error fetching listings:', error);
                    setStatus('Error loading marketplace data');
                } finally {
                    setIsLoading(false);
                }
            }
        }
        loadData();

        // optional manual refresh shortcuts for debugging
        // @ts-ignore
        window.refreshMarketplace = async (mode = 'soft') => {
            try {
                setIsLoading(true);
                if (mode === 'deep') {
                    await deepRescan();
                } else {
                    await fetchListings(true);
                    if (auctionsEnabled) await fetchAuctions(false);
                }
            } catch (error) {
                criticalError('[Marketplace] Refresh error:', error);
            } finally {
                setIsLoading(false);
            }
        };
        return () => { delete window.refreshMarketplace; };
    }, [isInitialized, fetchListings, setStatus, deepRescan, auctionsEnabled]);

    /* ----------------------------
       Persist listings to Supabase cache (deduped)
       ---------------------------- */
    useEffect(() => {
        if (!supabaseConnected) return;
        if (!Array.isArray(listings) || listings.length === 0) return;

        const active = listings.filter((l) => l.active && !(canceledListings?.has?.(String(l.id))));
        if (active.length === 0) return;

        const sig = JSON.stringify(
            active.map((l) => [
                String(l.id),
                String(l.pricePerUnit ?? ''),
                String(l.paymentToken ?? ''),
                String(l.quantity ?? ''),
                String(l.active ?? ''),
            ])
        );
        if (sig === cacheSigRef.current) return;
        cacheSigRef.current = sig;

        const t = setTimeout(() => {
            try { cacheListings(active, canceledListings || new Set()); } catch (e) { debugWarn('Cache listings error:', e); }
        }, 300);

        return () => clearTimeout(t);
    }, [supabaseConnected, listings, canceledListings, cacheListings]);

    /* ----------------------------
       Auctions: load from Supabase (if present) + conservative on-chain scan (events)
       ---------------------------- */
    // Enhanced metadata fetching using the robust metadata loading system
    const fetchAuctionMetadata = async (nftContract, tokenId, is1155) => {
        try {
            if (!provider || !nftContract || (!tokenId && tokenId !== 0 && tokenId !== '0')) {
                debugWarn('Invalid parameters for auction metadata fetch');
                return { name: `NFT #${tokenId || 'Unknown'}`, image: null };
            }

            debugLog(`🔍 Fetching auction metadata for ${nftContract}:${tokenId}`);

            // Special handling for V-Share contracts
            if (isVShareContract(nftContract)) {
                debugLog(`🎯 Using V-Share metadata for ${nftContract}:${tokenId}`);
                const vShareMetadata = getVShareMetadata(nftContract, tokenId);
                return {
                    name: vShareMetadata.name,
                    image: vShareMetadata.image,
                    description: vShareMetadata.description,
                    attributes: vShareMetadata.attributes || [],
                    raw: vShareMetadata
                };
            }

            // Use the enhanced metadata loader from metadataLoader.js
            const metadata = await loadMetadata(nftContract, tokenId, provider);

            if (metadata && metadata.image) {
                debugLog(`✅ Auction metadata loaded successfully for ${nftContract}:${tokenId}`);
                return {
                    name: metadata.name || `NFT #${tokenId}`,
                    image: metadata.image,
                    description: metadata.description,
                    attributes: metadata.attributes || [],
                    raw: metadata
                };
            } else {
                debugWarn(`⚠️ Auction metadata incomplete for ${nftContract}:${tokenId}`);
                return {
                    name: metadata?.name || `NFT #${tokenId}`,
                    image: null,
                    description: metadata?.description || '',
                    attributes: metadata?.attributes || [],
                    raw: metadata
                };
            }
        } catch (error) {
            // If error and it's V-Share, still use V-Share metadata
            if (isVShareContract(nftContract)) {
                debugLog(`🎯 Using V-Share metadata for ${nftContract}:${tokenId} (after error)`);
                const vShareMetadata = getVShareMetadata(nftContract, tokenId);
                return {
                    name: vShareMetadata.name,
                    image: vShareMetadata.image,
                    description: vShareMetadata.description,
                    attributes: vShareMetadata.attributes || [],
                    raw: vShareMetadata
                };
            }
            
            criticalError(`Failed to fetch auction metadata for ${nftContract}:${tokenId}:`, error);
            return {
                name: `NFT #${tokenId || 'Unknown'}`,
                image: null,
                description: '',
                attributes: [],
                error: error.message
            };
        }
    };

    const fetchAuctions = useCallback(async (showStatus = true) => {
        if (!auctionsEnabled) { setAuctions([]); return; }
        if (!provider || !marketplaceAddress) {
            // Provide test auction data when network is unavailable
            if (showStatus) {
                debugWarn('No provider or marketplace address, using test auction data');
                const testAuctions = [
                    {
                        source: 'test',
                        id: '1',
                        nftContract: '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906',
                        tokenId: '1',
                        seller: '0x0327Fab0F5A79C884b9E3fc611d490a19147D235',
                        paymentToken: ethers.ZeroAddress,
                        reservePrice: '1000000000000000000',
                        startPrice: '500000000000000000',
                        startTime: Date.now() - 60000,
                        endTime: Date.now() + 3600000,
                        highestBid: '750000000000000000',
                        highestBidder: '0x123...',
                        isERC1155: false,
                        quantity: '1',
                        image: 'ipfs://QmSHzd8MmLcsG8x4yYb4k3dRP6BawJmShmKgxDcvNRtB4i',
                        imageUrl: 'ipfs://QmSHzd8MmLcsG8x4yYb4k3dRP6BawJmShmKgxDcvNRtB4i',
                        name: 'Test Pixel Ninja Cat #1',
                        description: 'A test auction item to demonstrate image loading',
                        attributes: [],
                        metadata: {
                            name: 'Test Pixel Ninja Cat #1',
                            image: 'ipfs://QmSHzd8MmLcsG8x4yYb4k3dRP6BawJmShmKgxDcvNRtB4i',
                            description: 'A test auction item to demonstrate image loading'
                        },
                        active: true,
                    }
                ];
                setAuctions(testAuctions);
            }
            return;
        }

        setIsAuctionsLoading(true);
        try {
            // 1) Try Supabase tables if present (lightweight)
            let rows = [];
            if (supabaseConnected && supabase) {
                const candidates = ['auctions', 'marketplace_auctions', 'auction_listings'];
                for (const table of candidates) {
                    try {
                        const { data, error } = await supabase
                            .from(table)
                            .select('*')
                            .order('created_at', { ascending: false })
                            .limit(100);
                        if (!error && Array.isArray(data) && data.length) {
                            rows = data;
                            break;
                        }
                    } catch { /* ignore */ }
                }
            }

            const normalizedFromDb = rows.map(r => ({
                source: 'db',
                id: String(r.id ?? r.auction_id ?? ''),
                nftContract: (r.nft_contract || r.contract || '').toLowerCase(),
                tokenId: String(r.token_id ?? r.tokenId ?? ''),
                seller: (r.seller || '').toLowerCase(),
                paymentToken: r.payment_token || ethers.ZeroAddress,
                reservePrice: String(r.reserve_price ?? r.reservePrice ?? '0'),
                startPrice: String(r.start_price ?? r.startPrice ?? '0'),
                startTime: Number(coerceMs(r.start_time || r.startTime)) || 0,
                endTime: Number(coerceMs(r.end_time || r.ends_at || r.endTime)) || 0,
                highestBid: String(r.highest_bid ?? r.highestBid ?? '0'),
                highestBidder: (r.highest_bidder || r.highestBidder || '').toLowerCase(),
                isERC1155: !!r.is_erc1155,
                quantity: String(r.quantity ?? '1'),
                image: r.image_url || null,
                name: r.name || null,
                status: (r.status || '').toLowerCase(),
                settled: !!r.settled, // Add settled property from database
            }));

            // 2) Conservative on-chain scan for AuctionCreated events (recent 50k blocks)
            const contract = new ethers.Contract(marketplaceAddress, VtruMarketplaceArtifact.abi, provider);
            let chainAuctions = [];
            try {
                const current = await provider.getBlockNumber();
                const fromBlock = Math.max(0, current - 50000);
                if (showStatus) setStatus?.(`Scanning recent auctions ${fromBlock}-${current}...`);
                const created = await contract.queryFilter(contract.filters.AuctionCreated(), fromBlock, current);

                // Limit processing to avoid heavy scanning
                const toProcess = created.slice(-100); // last 100
                // For each event, read current auction state from storage
                chainAuctions = await Promise.all(toProcess.map(async (ev) => {
                    try {
                        const auctionId = String(ev.args?.auctionId?.toString?.() || ev.args?.[0]?.toString?.() || '');
                        if (!auctionId) return null;
                        const a = await contract.auctions(auctionId);
                        // Active = started && !settled && now < endTime
                        const endSec = Number(a.endTime || 0);
                        const endMs = endSec ? endSec * 1000 : 0;
                        const active = Boolean(a.started) && !Boolean(a.settled) && (endMs ? (Date.now() < endMs) : true);

                        // Enhanced metadata fetch with robust error handling
                        let meta = { name: `NFT #${a.tokenId}`, image: null };
                        try {
                            meta = await fetchAuctionMetadata(a.nftContract, a.tokenId?.toString?.() || '0', Boolean(a.isERC1155));
                            debugLog(`✅ Auction metadata fetched for ${a.nftContract}:${a.tokenId}`, meta);
                        } catch (metaError) {
                            debugWarn(`⚠️ Auction metadata fetch failed for ${a.nftContract}:${a.tokenId}:`, metaError);
                            // Continue with fallback metadata
                        }

                        return {
                            source: 'chain',
                            id: auctionId,
                            nftContract: (a.nftContract || '').toLowerCase(),
                            tokenId: String(a.tokenId?.toString?.() || '0'),
                            seller: (a.seller || '').toLowerCase(),
                            paymentToken: a.paymentToken || ethers.ZeroAddress,
                            reservePrice: String(a.reservePrice || '0'),
                            startPrice: String(a.startPrice || '0'),
                            startTime: Number(a.startTime || 0) * 1000,
                            endTime: endMs,
                            highestBid: String(a.highestBid || '0'),
                            highestBidder: (a.highestBidder || '').toLowerCase(),
                            isERC1155: Boolean(a.isERC1155),
                            quantity: String(a.quantity || '1'),
                            image: meta.image || null,
                            imageUrl: meta.image || null, // Additional fallback field
                            name: meta.name || `NFT #${a.tokenId?.toString?.() || '0'}`,
                            description: meta.description || '',
                            attributes: meta.attributes || [],
                            metadata: meta.raw || null, // Store raw metadata for additional fallback
                            active,
                            settled: Boolean(a.settled), // Add settled property from contract
                        };
                    } catch {
                        return null;
                    }
                }));
                chainAuctions = chainAuctions.filter(Boolean);
            } catch (e) {
                debugWarn('[Auctions] Chain scan failed:', e?.message || e);
            }

            // Merge DB + chain, prefer chain state for activeness and latest bids
            const byId = new Map();
            for (const a of normalizedFromDb) byId.set(a.id, a);
            for (const a of chainAuctions) byId.set(a.id, { ...(byId.get(a.id) || {}), ...a });

            // Only keep active auctions - exclude settled auctions from marketplace display
            const recentCutoff = Date.now() - 6 * 60 * 60 * 1000;
            const merged = Array.from(byId.values())
                .filter(a => {
                    // First priority: exclude settled auctions completely
                    if (a.settled === true) {
                        return false;
                    }
                    
                    // Second priority: use the calculated 'active' property if available (from chain data)
                    if (a.hasOwnProperty('active')) {
                        return a.active === true;
                    }
                    
                    // Fallback: time-based filtering for auctions without explicit active status
                    const endMs = a.endTime;
                    if (!endMs) return true; // Keep auctions without end time (might be test data)
                    if (Date.now() < endMs) return true; // Keep ongoing auctions
                    return endMs >= recentCutoff; // Keep recently ended unsettled auctions
                })
                .sort((a, b) => (a.endTime || 0) - (b.endTime || 0)); // ending soonest first

            setAuctions(merged);
            if (showStatus) setTimeout(() => setStatus?.(''), 2000);
        } finally {
            setIsAuctionsLoading(false);
        }
    }, [auctionsEnabled, provider, marketplaceAddress, supabaseConnected, supabase, setStatus]);

    /* ----------------------------
       Process listings & compute enhanced stats (incl. HOT/NEW signals)
       ---------------------------- */
    useEffect(() => {
        async function processListingsWithEnhancedStats() {
            if (listings.length > 0 && provider) {
                try {
                    const collectionMap = {};
                    let currentListingVolumeUSDC = 0;
                    let lowestPriceUSDC = Infinity;
                    const pricePromises = [];
                    let hasAnyUSDCRates = false;

                    const activeListings = listings.filter(
                        (listing) => listing.active && !canceledListings.has(listing.id?.toString())
                    );

                    const cutoff = nowMs() - RECENT_WINDOW_MS;

                    for (const listing of activeListings) {
                        const collectionAddress = listing.nftContract;
                        if (!collectionMap[collectionAddress]) {
                            let collectionName = `Collection ${collectionAddress.slice(0, 8)}...${collectionAddress.slice(-6)}`;
                            let collectionDescription = '';
                            let collectionImage =
                                listing.image || listing.imageUrl || listing.metadata?.image || listing.metadata?.image_url;
                            let collectionWebsite = '';

                            if (
                                listing.collectionName &&
                                listing.collectionName.trim() !== '' &&
                                !listing.collectionName.includes('Collection 0x')
                            ) {
                                collectionName = listing.collectionName.trim();
                            } else if (listing.metadata?.collection?.name && listing.metadata.collection.name.trim() !== '') {
                                collectionName = listing.metadata.collection.name.trim();
                            } else if (
                                listing.metadata?.name &&
                                listing.metadata.name.trim() !== '' &&
                                !listing.metadata.name.includes('#') &&
                                !listing.metadata.name.toLowerCase().includes('token') &&
                                !listing.metadata.name.toLowerCase().includes('nft')
                            ) {
                                collectionName = listing.metadata.name.trim();
                            }

                            if (listing.metadata?.collection) {
                                collectionDescription = listing.metadata.collection.description || '';
                                collectionImage = listing.metadata.collection.image || collectionImage;
                                collectionWebsite =
                                    listing.metadata.collection.external_link || listing.metadata.collection.external_url || '';
                            }

                            collectionMap[collectionAddress] = {
                                address: collectionAddress,
                                name: collectionName,
                                description: collectionDescription,
                                image: collectionImage,
                                website: collectionWebsite,
                                items: [],
                                // pricing metrics
                                floorPrice: Infinity,
                                totalVolume: 0,
                                avgPrice: 0,
                                highestPrice: 0,
                                lowestPrice: Infinity,
                                // recency metrics
                                firstTs: Number.POSITIVE_INFINITY,
                                lastTs: 0,
                                recentListings: 0,
                                recentVolume: 0,
                            };
                        }

                        // Record item
                        collectionMap[collectionAddress].items.push(listing);

                        // Coerce a timestamp for HOT/NEW
                        const tsCandidate =
                            coerceMs(listing.createdAt) ??
                            coerceMs(listing.created_at) ??
                            coerceMs(listing.timestamp) ??
                            coerceMs(listing.time) ??
                            coerceMs(listing.blockTimestamp) ??
                            coerceMs(listing.listedAt);
                        const ts = Number.isFinite(tsCandidate) ? tsCandidate : 0;

                        if (ts > 0) {
                            if (ts < collectionMap[collectionAddress].firstTs) collectionMap[collectionAddress].firstTs = ts;
                            if (ts > collectionMap[collectionAddress].lastTs) collectionMap[collectionAddress].lastTs = ts;
                        }

                        const isRecent = ts >= cutoff && ts > 0;

                        // Pre-bind recency flags into the price promise
                        pricePromises.push(
                            convertToUSDCValue(listing.pricePerUnit, listing.paymentToken, provider)
                                .then((usdcPrice) => {
                                    hasAnyUSDCRates = true;
                                    return { listing, usdcPrice, hasRate: true, isRecent, ts };
                                })
                                .catch(() => ({ listing, usdcPrice: 0, hasRate: false, isRecent, ts }))
                        );
                    }

                    const priceResults = await Promise.all(pricePromises);

                    priceResults.forEach(({ listing, usdcPrice, hasRate, isRecent, ts }) => {
                        const collectionAddress = listing.nftContract;
                        const col = collectionMap[collectionAddress];

                        if (hasRate) {
                            col.totalVolume += usdcPrice;
                            if (usdcPrice < col.floorPrice) { col.floorPrice = usdcPrice; col.lowestPrice = usdcPrice; }
                            if (usdcPrice > col.highestPrice) col.highestPrice = usdcPrice;
                            if (isRecent) col.recentVolume += usdcPrice;
                            currentListingVolumeUSDC += usdcPrice;
                            if (usdcPrice < lowestPriceUSDC) lowestPriceUSDC = usdcPrice;
                        }

                        if (isRecent) col.recentListings += 1;
                        if (ts > 0 && ts > col.lastTs) col.lastTs = ts;
                    });

                    Object.values(collectionMap).forEach((collection) => {
                        if (collection.items.length > 0) {
                            collection.avgPrice = collection.totalVolume / collection.items.length;
                            if (!Number.isFinite(collection.floorPrice)) {
                                collection.floorPrice = 0;
                                collection.lowestPrice = 0;
                            }
                            if (!Number.isFinite(collection.firstTs)) collection.firstTs = 0;
                        }
                    });

                    const collectionsList = Object.values(collectionMap).sort((a, b) => b.items.length - a.items.length);
                    setCollections(collectionsList);

                    const actualSoldVolume = marketplaceStats.actualSoldVolume || 0;

                    setStats({
                        currentListingVolume: currentListingVolumeUSDC.toFixed(2),
                        actualSoldVolume: actualSoldVolume.toFixed(2),
                        totalListings: activeListings.length,
                        totalVolume: (currentListingVolumeUSDC + actualSoldVolume).toFixed(2),
                        avgPrice:
                            activeListings.length > 0 ? (currentListingVolumeUSDC / activeListings.length).toFixed(2) : '0.00',
                        floorPrice: lowestPriceUSDC === Infinity ? '0.00' : lowestPriceUSDC.toFixed(2),
                        hasUSDCRates: hasAnyUSDCRates,
                    });

                    if (hotListings && hotListings.length > 0) {
                        setFeaturedNFT(hotListings[0]);
                    } else if (activeListings.length > 0) {
                        const highest = priceResults.reduce(
                            (max, cur) => (cur.usdcPrice > max.usdcPrice ? cur : max),
                            { usdcPrice: 0, listing: activeListings[0] }
                        );
                        setFeaturedNFT(highest.listing);
                    }
                } catch (error) {
                    criticalError('Error processing listings with enhanced stats:', error);
                    // Fallback (no USDC conversion)
                    const activeListings = listings.filter(
                        (listing) => listing.active && !canceledListings.has(listing.id?.toString())
                    );
                    const collectionMap = {};
                    let totalVolume = 0;
                    let lowestPrice = Infinity;

                    activeListings.forEach((listing) => {
                        const collectionAddress = listing.nftContract;
                        if (!collectionMap[collectionAddress]) {
                            let collectionName = `Collection ${collectionAddress.slice(0, 8)}...${collectionAddress.slice(-6)}`;
                            if (
                                listing.collectionName &&
                                listing.collectionName.trim() !== '' &&
                                !listing.collectionName.includes('Collection 0x')
                            ) {
                                collectionName = listing.collectionName.trim();
                            } else if (listing.metadata?.collection?.name && listing.metadata.collection.name.trim() !== '') {
                                collectionName = listing.metadata.collection.name.trim();
                            } else if (
                                listing.metadata?.name &&
                                listing.metadata.name.trim() !== '' &&
                                !listing.metadata.name.includes('#') &&
                                !listing.metadata.name.toLowerCase().includes('token') &&
                                !listing.metadata.name.toLowerCase().includes('nft')
                            ) {
                                collectionName = listing.metadata.name.trim();
                            }

                            collectionMap[collectionAddress] = {
                                address: collectionAddress,
                                name: collectionName,
                                description: listing.metadata?.collection?.description || '',
                                image: listing.metadata?.collection?.image || listing.image || listing.imageUrl,
                                website: listing.metadata?.collection?.external_link || '',
                                items: [],
                                floorPrice: Infinity,
                                totalVolume: 0,
                                avgPrice: 0,
                                highestPrice: 0,
                                lowestPrice: Infinity,
                                firstTs: Number.POSITIVE_INFINITY,
                                lastTs: 0,
                                recentListings: 0,
                                recentVolume: 0,
                            };
                        }

                        const priceInEth = Number.parseFloat(ethers.formatEther(listing.pricePerUnit));
                        const tsCandidate =
                            coerceMs(listing.createdAt) ??
                            coerceMs(listing.created_at) ??
                            coerceMs(listing.timestamp) ??
                            coerceMs(listing.time) ??
                            coerceMs(listing.blockTimestamp) ??
                            coerceMs(listing.listedAt);
                        const ts = Number.isFinite(tsCandidate) ? tsCandidate : 0;
                        const isRecent = ts >= nowMs() - RECENT_WINDOW_MS && ts > 0;

                        collectionMap[collectionAddress].items.push(listing);
                        collectionMap[collectionAddress].totalVolume += priceInEth;
                        if (priceInEth < collectionMap[collectionAddress].floorPrice) {
                            collectionMap[collectionAddress].floorPrice = priceInEth;
                        }
                        if (isRecent) {
                            collectionMap[collectionAddress].recentListings += 1;
                            collectionMap[collectionAddress].recentVolume += priceInEth;
                        }

                        if (ts > 0) {
                            if (ts < collectionMap[collectionAddress].firstTs) collectionMap[collectionAddress].firstTs = ts;
                            if (ts > collectionMap[collectionAddress].lastTs) collectionMap[collectionAddress].lastTs = ts;
                        }

                        totalVolume += priceInEth;
                        if (priceInEth < lowestPrice) lowestPrice = priceInEth;
                    });

                    const collectionsList = Object.values(collectionMap).sort((a, b) => b.items.length - a.items.length);
                    setCollections(collectionsList);

                    setStats({
                        currentListingVolume: `${totalVolume.toFixed(2)} (no USDC rate available)`,
                        actualSoldVolume: '0.00 (no USDC rate available)',
                        totalListings: activeListings.length,
                        totalVolume: `${totalVolume.toFixed(2)} (no USDC rate available)`,
                        avgPrice: activeListings.length > 0 ? `${(totalVolume / activeListings.length).toFixed(3)} (est.)` : '0.00',
                        floorPrice: lowestPrice === Infinity ? '0.00' : `${lowestPrice.toFixed(3)} (est.)`,
                        hasUSDCRates: false,
                    });
                }
            } else {
                setStats({
                    currentListingVolume: '0.00',
                    actualSoldVolume: marketplaceStats.actualSoldVolume?.toFixed(2) || '0.00',
                    totalListings: 0,
                    totalVolume: '0.00',
                    avgPrice: '0.00',
                    floorPrice: '0.00',
                    hasUSDCRates: true,
                });
            }
        }
        processListingsWithEnhancedStats();
    }, [listings, hotListings, provider, canceledListings, marketplaceStats]);

    /* ----------------------------
       Featured NFT price display
       ---------------------------- */
    useEffect(() => {
        async function updateFeaturedNFTPriceDisplay() {
            if (!featuredNFT || !featuredNFT.pricePerUnit || !provider) {
                setFeaturedNFTPriceDisplay({
                    tokenAmount: '...',
                    tokenSymbol: 'TOKEN',
                    usdcValue: '0.00',
                    formatted: '...',
                    hasUSDCRate: true,
                });
                return;
            }
            try {
                const priceInfo = await formatPriceWithUSDC(
                    featuredNFT.pricePerUnit,
                    featuredNFT.paymentToken,
                    provider,
                    true
                );
                setFeaturedNFTPriceDisplay(priceInfo);
            } catch {
                const tokenSymbol = featuredNFT.paymentToken
                    ? (featuredNFT.paymentToken === ethers.ZeroAddress ? 'VTRU' : 'TOKEN')
                    : 'VTRU';
                const tokenAmount = formatPrice(featuredNFT.pricePerUnit);
                setFeaturedNFTPriceDisplay({
                    tokenAmount,
                    tokenSymbol,
                    usdcValue: '0.00',
                    formatted: `${tokenAmount} ${tokenSymbol}`,
                    hasUSDCRate: false,
                });
            }
        }
        updateFeaturedNFTPriceDisplay();
    }, [featuredNFT, provider]);

    /* ----------------------------
       Search, filters, sorting (for main listings)
       ---------------------------- */
    useEffect(() => {
        let result = [...listings];

        // Debug logging to help identify filtering issues
        debugLog(`🔍 Filtering ${listings.length} listings with filters:`, {
            searchTerm,
            selectedCategories: selectedCategories.length,
            selectedCollections: selectedCollections.length,
            priceRange
        });

        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            result = result.filter(
                (item) =>
                    item.name?.toLowerCase().includes(term) ||
                    item.metadata?.name?.toLowerCase().includes(term) ||
                    item.metadata?.description?.toLowerCase().includes(term) ||
                    item.tokenId.toString().includes(term)
            );
            debugLog(`🔍 After search filter: ${result.length} listings remaining`);
        }

        if (selectedCategories.length > 0) {
            result = result.filter((item) => {
                const category =
                    item.metadata?.properties?.category ||
                    item.metadata?.attributes?.find((attr) => attr.trait_type === 'Category')?.value;
                return category && selectedCategories.includes(String(category).toLowerCase());
            });
            debugLog(`🔍 After category filter: ${result.length} listings remaining`);
        }

        if (selectedCollections.length > 0) {
            result = result.filter((item) => selectedCollections.includes(item.nftContract.toLowerCase()));
            debugLog(`🔍 After collection filter: ${result.length} listings remaining`);
        }

        if (priceRange.min !== '') {
            const minWei = ethers.parseEther(priceRange.min.toString());
            result = result.filter((item) => ethers.getBigInt(item.pricePerUnit) >= minWei);
            debugLog(`🔍 After min price filter: ${result.length} listings remaining`);
        }
        if (priceRange.max !== '') {
            const maxWei = ethers.parseEther(priceRange.max.toString());
            result = result.filter((item) => ethers.getBigInt(item.pricePerUnit) <= maxWei);
            debugLog(`🔍 After max price filter: ${result.length} listings remaining`);
        }

        switch (sortMethod) {
            case 'price_low_to_high':
                result.sort((a, b) => Number(ethers.getBigInt(a.pricePerUnit) - ethers.getBigInt(b.pricePerUnit)));
                break;
            case 'price_high_to_low':
                result.sort((a, b) => Number(ethers.getBigInt(b.pricePerUnit) - ethers.getBigInt(a.pricePerUnit)));
                break;
            case 'newest':
                result.sort((a, b) => b.id - a.id);
                break;
            case 'oldest':
                result.sort((a, b) => a.id - b.id);
                break;
            default:
                break;
        }

        debugLog(`🔍 Final filtered result: ${result.length} listings for display`);
        setFilteredListings(result);
        setCurrentPage(1); // reset paging on filter/sort change
    }, [listings, searchTerm, sortMethod, selectedCategories, selectedCollections, priceRange]);

    // Infinite paging sentinel
    useEffect(() => {
        if (!autoLoadNext) return;
        const el = sentinelRef.current;
        if (!el) return;
        const io = new IntersectionObserver((entries) => {
            const entry = entries[0];
            if (entry.isIntersecting) {
                setCurrentPage((p) => p + 1);
            }
        }, { root: null, rootMargin: '0px', threshold: 1.0 });
        io.observe(el);
        return () => io.disconnect();
    }, [autoLoadNext]);

    const totalPages = Math.ceil(filteredListings.length / itemsPerPage);
    const indexOfLastItem = Math.min(currentPage, totalPages || 1) * itemsPerPage;
    const indexOfFirstItem = indexOfLastItem - itemsPerPage;
    // Fixed: use indexOfFirstItem for non-autoLoad paging; accumulate for autoLoadNext
    const currentItems = autoLoadNext
        ? filteredListings.slice(0, indexOfLastItem)
        : filteredListings.slice(indexOfFirstItem, indexOfLastItem);

    const paginate = (pageNumber) => {
        setCurrentPage(Math.max(1, Math.min(pageNumber, totalPages || 1)));
        topRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const toggleCategory = (categoryId) => {
        if (selectedCategories.includes(categoryId)) {
            setSelectedCategories(selectedCategories.filter((cat) => cat !== categoryId));
        } else {
            setSelectedCategories([...selectedCategories, categoryId]);
        }
    };
    const toggleCollection = (collectionAddress) => {
        if (selectedCollections.includes(collectionAddress)) {
            setSelectedCollections(selectedCollections.filter((col) => col !== collectionAddress));
        } else {
            setSelectedCollections([...selectedCollections, collectionAddress]);
        }
    };
    const clearAllFilters = () => {
        setSearchTerm('');
        setSelectedCategories([]);
        setSelectedCollections([]);
        setPriceRange({ min: '', max: '' });
    };
    const formatPrice = (priceInWei) => {
        try { return parseFloat(ethers.formatEther(priceInWei)).toFixed(4); } catch { return '0'; }
    };

    // Featured NFT collection label using resolver
    const featuredCollectionLabel = useMemo(() => {
        if (!featuredNFT) return '';
        const addr = featuredNFT.nftContract || '';
        const resolved = labelForAddress(addr, '');
        if (resolved && !resolved.startsWith('0x') && !resolved.toLowerCase().startsWith('collection')) return resolved;

        const metaName =
            (featuredNFT.collectionName && featuredNFT.collectionName.trim() !== '' && !featuredNFT.collectionName.includes('Collection 0x'))
                ? featuredNFT.collectionName.trim()
                : (featuredNFT.metadata?.collection?.name && featuredNFT.metadata.collection.name.trim() !== '')
                    ? featuredNFT.metadata.collection.name.trim()
                    : (featuredNFT.metadata?.name &&
                        featuredNFT.metadata.name.trim() !== '' &&
                        !featuredNFT.metadata.name.includes('#') &&
                        !featuredNFT.metadata.name.toLowerCase().includes('token') &&
                        !featuredNFT.metadata.name.toLowerCase().includes('nft'))
                        ? featuredNFT.metadata.name.trim()
                        : '';
        return metaName || shortAddr(addr);
    }, [featuredNFT, labelForAddress]);

    /* ----------------------------
       TRENDING / HOT / NEW derived lists
       ---------------------------- */
    const trendingSorted = useMemo(() => {
        const arr = [...collections];
        if (trendMode === 'hot') {
            arr.sort((a, b) => {
                const rv = (b.recentVolume || 0) - (a.recentVolume || 0);
                if (rv !== 0) return rv;
                const rc = (b.recentListings || 0) - (a.recentListings || 0);
                if (rc !== 0) return rc;
                return (b.totalVolume || 0) - (a.totalVolume || 0);
            });
        } else if (trendMode === 'new') {
            arr.sort((a, b) => {
                const lt = (b.lastTs || 0) - (a.lastTs || 0);
                if (lt !== 0) return lt;
                const items = (b.items?.length || 0) - (a.items?.length || 0);
                if (items !== 0) return items;
                return (b.totalVolume || 0) - (a.totalVolume || 0);
            });
        } else {
            arr.sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0));
        }
        return arr;
    }, [collections, trendMode]);

    const onClickTrendMode = (mode) => setTrendMode(mode);

    const anyActiveFilter =
        !!searchTerm ||
        selectedCategories.length > 0 ||
        selectedCollections.length > 0 ||
        priceRange.min !== '' ||
        priceRange.max !== '';

    const formatCountdown = () => {
        if (!autoRefreshEnabled || !nextRefreshAt) return '';
        const ms = Math.max(0, nextRefreshAt - Date.now());
        const s = Math.ceil(ms / 1000);
        return `Auto in ${s}s`;
    };

    return (
        <div className="marketplace-container" ref={topRef}>
            {/* Hero Section */}
            <motion.div 
                className="marketplace-hero"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8 }}
            >
                <motion.div 
                    className="hero-content"
                    initial={{ opacity: 0, x: -50 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.8, delay: 0.2 }}
                >
                    <motion.h1
                        initial={{ opacity: 0, y: 30 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, delay: 0.4 }}
                    >
                        Discover, Collect & Sell
                        <br />
                        <span className="gradient-text">Extraordinary NFTs</span>
                    </motion.h1>
                    <motion.p
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, delay: 0.6 }}
                    >
                        Explore the most sought-after digital assets in the Vitruveo ecosystem
                    </motion.p>
                    <motion.div 
                        className="hero-cta"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, delay: 0.8 }}
                    >
                        {wallet ? (
                            <motion.a 
                                href="/sell" 
                                className="primary-button"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                            >
                                Create Listing
                            </motion.a>
                        ) : (
                            <motion.button 
                                className="primary-button" 
                                onClick={connect}
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                            >
                                Connect Wallet
                            </motion.button>
                        )}
                        <motion.button
                            className="secondary-button"
                            onClick={() => {
                                const el = document.querySelector('.marketplace-stats');
                                if (el) window.scrollTo({ top: el.offsetTop, behavior: 'smooth' });
                            }}
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                        >
                            Browse Marketplace
                        </motion.button>
                    </motion.div>
                </motion.div>
                <motion.div 
                    className="hero-featured-nft"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.8, delay: 0.4 }}
                >
                    {featuredNFT && (
                        <div className="featured-nft-card">
                            <div className="featured-badge">Featured</div>
                            <div className="featured-image">
                                <SmartImage
                                    srcList={[
                                        featuredNFT.image,
                                        featuredNFT.imageUrl,
                                        featuredNFT.metadata?.image,
                                        featuredNFT.metadata?.image_url,
                                        featuredNFT.metadata?.animation_url,
                                    ]}
                                    alt={featuredNFT.name || featuredNFT.metadata?.name || `NFT #${featuredNFT.tokenId}`}
                                    width={480}
                                    height={320}
                                    seed={`${safeStr(featuredNFT.nftContract)}-${safeStr(featuredNFT.tokenId)}`}
                                    title={featuredNFT.name || featuredNFT.metadata?.name}
                                    className="featured-image-img"
                                    contractAddress={featuredNFT.nftContract}
                                    tokenId={featuredNFT.tokenId}
                                />
                            </div>
                            <div className="featured-details">
                                <h3>{featuredNFT.name || featuredNFT.metadata?.name || `NFT #${featuredNFT.tokenId}`}</h3>
                                <p className="featured-collection">{featuredCollectionLabel}</p>
                                {featuredNFT.metadata?.collection?.description && (
                                    <p className="featured-description">
                                        {featuredNFT.metadata.collection.description.slice(0, 80)}
                                        {featuredNFT.metadata.collection.description.length > 80 ? '...' : ''}
                                    </p>
                                )}
                                <div className="featured-price">
                                    <span className="price-label">Price:</span>
                                    <span className="price-value">
                                        {featuredNFTPriceDisplay.hasUSDCRate
                                            ? featuredNFTPriceDisplay.formatted
                                            : `${featuredNFTPriceDisplay.tokenAmount} ${featuredNFTPriceDisplay.tokenSymbol}`}
                                    </span>
                                </div>
                                <div style={{ marginTop: '.4rem' }}>
                                    <Link
                                        to={`/collections/${(featuredNFT.nftContract || '').toLowerCase()}`}
                                        className="see-all-button"
                                        aria-label="View collection"
                                    >
                                        View collection →
                                    </Link>
                                </div>
                            </div>
                        </div>
                    )}
                </motion.div>
            </motion.div>

            {/* Live Auctions */}
            {auctionsEnabled && (
                <section className="live-auctions">
                    <div className="section-header">
                        <h2>Live Auctions</h2>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button
                                className="refresh-button"
                                onClick={() => fetchAuctions(true)}
                                disabled={isAuctionsLoading}
                                title="Refresh auctions"
                            >
                                <RefreshIcon /> {isAuctionsLoading ? 'Loading...' : 'Refresh Auctions'}
                            </button>
                            <Link to="/auctions/create" className="see-all-button">Create Auction →</Link>
                        </div>
                    </div>

                    {auctions.length > 0 ? (
                        <div className="auctions-grid">
                            {auctions.slice(0, 8).map((a) => {
                                const endMs = a.endTime || 0;
                                const endsIn = endMs ? timeLeft(endMs) : '—';
                                const hasBid = ethers.getBigInt(a.highestBid || 0) > 0n;
                                const price = hasBid ? a.highestBid : a.startPrice;
                                const title = a.name || `#${a.tokenId}`;
                                const collectionLabel = labelForAddress(a.nftContract, '');
                                return (
                                    <Link
                                        key={a.id}
                                        to={`/auctions/${a.id}`}
                                        className="auction-card"
                                        aria-label={`Open auction ${title}`}
                                    >
                                        <div className="auction-image">
                                            <SmartImage
                                                srcList={[
                                                    a.image,
                                                    a.imageUrl,
                                                    a.image_url,
                                                    // Add fallback sources from raw metadata if available
                                                    ...(a.metadata?.image ? [a.metadata.image] : []),
                                                    ...(a.metadata?.image_url ? [a.metadata.image_url] : []),
                                                    ...(a.metadata?.imageUrl ? [a.metadata.imageUrl] : [])
                                                ].filter(Boolean)}
                                                alt={title}
                                                width={320}
                                                height={200}
                                                seed={`${a.nftContract}-${a.tokenId}`}
                                                title={title}
                                                contractAddress={a.nftContract}
                                                tokenId={a.tokenId}
                                            />
                                            <div className="auction-badge">AUCTION</div>
                                        </div>
                                        <div className="auction-details">
                                            <h3 title={title}>{title}</h3>
                                            <p className="auction-collection" title={collectionLabel}>{collectionLabel}</p>
                                            <div className="auction-meta">
                                                <div className="meta">
                                                    <span className="label">{hasBid ? 'Highest Bid' : 'Start Price'}</span>
                                                    <span className="value">{formatPrice(price)} VTRU</span>
                                                </div>
                                                <div className="meta">
                                                    <span className="label">Ends In</span>
                                                    <span className="value">{endsIn}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="empty-state card" style={{ marginTop: 8 }}>
                            <div className="empty-icon">🏷️</div>
                            <h3>No live auctions</h3>
                            <p>Auctions you create or bid on will appear here.</p>
                        </div>
                    )}
                </section>
            )}

            {/* Popular Collections Carousel */}
            <section className="hot-collections">
                <div className="section-header">
                    <h2>Popular Collections</h2>
                    <Link to="/collections" className="see-all-button">See All</Link>
                </div>

                <div className="collections-carousel">
                    {collections.slice(0, 5).map((collection, index) => {
                        const humanName = labelForCollection(collection);
                        const addr = (collection.address || '').toLowerCase();
                        return (
                            <Link
                                to={`/collections/${addr}`}
                                className="collection-card enhanced"
                                key={addr || index}
                                aria-label={`Open collection ${humanName}`}
                            >
                                <div className="collection-header">
                                    <div className="collection-avatar">
                                        <SmartImage
                                            srcList={[
                                                collection.image,
                                                collection.items[0]?.image,
                                                collection.items[0]?.imageUrl,
                                                collection.items[0]?.metadata?.image,
                                                collection.items[0]?.metadata?.image_url,
                                            ]}
                                            alt={humanName}
                                            width={64}
                                            height={64}
                                            seed={collection.address}
                                            title={humanName}
                                        />
                                    </div>
                                    <div className="collection-rank">#{index + 1}</div>
                                </div>
                                <div className="collection-preview">
                                    {collection.items.slice(0, 4).map((item, i) => (
                                        <div className="preview-item" key={i}>
                                            <SmartImage
                                                srcList={[
                                                    item.image,
                                                    item.imageUrl,
                                                    item.metadata?.image,
                                                    item.metadata?.image_url,
                                                    item.metadata?.animation_url,
                                                ]}
                                                alt={`Preview ${i}`}
                                                width={96}
                                                height={96}
                                                seed={`${item.nftContract}-${item.tokenId}-${i}`}
                                                title={item.metadata?.name || item.name}
                                            />
                                        </div>
                                    ))}
                                    {collection.items.length > 4 && (
                                        <div className="preview-item more-items"><span>+{collection.items.length - 4}</span></div>
                                    )}
                                </div>
                                <div className="collection-info">
                                    <h3 title={humanName}>{humanName}</h3>
                                    {collection.description && (
                                        <p className="collection-description" title={collection.description}>
                                            {collection.description.slice(0, 60)}{collection.description.length > 60 ? '...' : ''}
                                        </p>
                                    )}
                                    <div className="collection-stats">
                                        <div className="stat"><span className="value">{collection.items.length}</span><span className="label">items</span></div>
                                        <div className="stat"><span className="value">${collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}</span><span className="label">floor</span></div>
                                        <div className="stat"><span className="value">${collection.totalVolume.toFixed(2)}</span><span className="label">volume</span></div>
                                        <div className="stat"><span className="value">${collection.avgPrice > 0 ? collection.avgPrice.toFixed(2) : '0.00'}</span><span className="label">avg price</span></div>
                                    </div>
                                    {collection.website && (
                                        <div className="collection-links">
                                            <a href={collection.website} target="_blank" rel="noopener noreferrer" className="website-link" onClick={(e) => e.stopPropagation()}>🌐 Website</a>
                                        </div>
                                    )}
                                </div>
                            </Link>
                        );
                    })}
                </div>
            </section>

            {/* Trending Collections */}
            {collections.length > 0 && (
                <section className="trending-collections">
                    <div className="section-header">
                        <h2>Trending Collections</h2>
                        <div className="trend-filters" role="tablist" aria-label="Trending filter">
                            <button
                                className={`trend-filter ${trendMode === 'volume' ? 'active' : ''}`}
                                onClick={() => onClickTrendMode('volume')}
                                role="tab"
                                aria-selected={trendMode === 'volume'}
                            >
                                📈 Volume
                            </button>
                            <button
                                className={`trend-filter ${trendMode === 'hot' ? 'active' : ''}`}
                                onClick={() => onClickTrendMode('hot')}
                                role="tab"
                                aria-selected={trendMode === 'hot'}
                                title="Sorted by 24h volume & activity"
                            >
                                🔥 Hot
                            </button>
                            <button
                                className={`trend-filter ${trendMode === 'new' ? 'active' : ''}`}
                                onClick={() => onClickTrendMode('new')}
                                role="tab"
                                aria-selected={trendMode === 'new'}
                                title="Newest active collections"
                            >
                                ⭐ New
                            </button>
                        </div>
                    </div>

                    <div className="trending-collections-grid">
                        {trendingSorted.slice(0, 6).map((collection, index) => {
                            const humanName = labelForCollection(collection);
                            const addr = (collection.address || '').toLowerCase();
                            const pct24 =
                                collection.totalVolume > 0
                                    ? Math.min(999, Math.max(0, (collection.recentVolume / collection.totalVolume) * 100))
                                    : 0;
                            const pctLabel = Number.isFinite(pct24) ? `${pct24.toFixed(1)}%` : '—';
                            return (
                                <Link
                                    to={`/collections/${addr}`}
                                    className="trending-collection-card"
                                    key={addr || `${humanName}-${index}`}
                                    aria-label={`Open collection ${humanName}`}
                                >
                                    <div className="trending-rank">#{index + 1}</div>
                                    <div className="trending-collection-header">
                                        <div className="trending-avatar">
                                            <SmartImage
                                                srcList={[
                                                    collection.image,
                                                    collection.items[0]?.image,
                                                    collection.items[0]?.imageUrl,
                                                    collection.items[0]?.metadata?.image,
                                                    collection.items[0]?.metadata?.image_url,
                                                ]}
                                                alt={humanName}
                                                width={56}
                                                height={56}
                                                seed={`trend-${collection.address}`}
                                                title={humanName}
                                            />
                                        </div>
                                        <div className="trending-info">
                                            <h4>{humanName}</h4>
                                            <p>{collection.items.length} items</p>
                                        </div>
                                        <div className="trending-change" title="24h volume vs total">
                                            <span className="change-percentage">{pctLabel}</span>
                                            <span className="change-label">24h</span>
                                        </div>
                                    </div>

                                    <div className="trending-metrics">
                                        <div className="metric">
                                            <span className="metric-label">Floor Price</span>
                                            <span className="metric-value">
                                                ${collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}
                                            </span>
                                        </div>
                                        <div className="metric">
                                            <span className="metric-label">{trendMode === 'hot' ? '24h Volume' : 'Volume'}</span>
                                            <span className="metric-value">
                                                ${(trendMode === 'hot' ? collection.recentVolume : collection.totalVolume).toFixed(2)}
                                            </span>
                                        </div>
                                        <div className="metric">
                                            <span className="metric-label">{trendMode === 'hot' ? '24h Listings' : 'Avg Price'}</span>
                                            <span className="metric-value">
                                                {trendMode === 'hot'
                                                    ? (collection.recentListings || 0)
                                                    : `$${collection.avgPrice > 0 ? collection.avgPrice.toFixed(2) : '0.00'}`}
                                            </span>
                                        </div>
                                        <div className="metric">
                                            <span className="metric-label">Items</span>
                                            <span className="metric-value">{collection.items.length}</span>
                                        </div>
                                    </div>

                                    <div className="trending-preview-small">
                                        {collection.items.slice(0, 3).map((item, i) => (
                                            <SmartImage
                                                key={i}
                                                srcList={[
                                                    item.image,
                                                    item.imageUrl,
                                                    item.metadata?.image,
                                                    item.metadata?.image_url,
                                                    item.metadata?.animation_url,
                                                ]}
                                                alt={`${humanName} item ${i + 1}`}
                                                width={120}
                                                height={90}
                                                seed={`trend-prev-${collection.address}-${i}`}
                                                title={item.metadata?.name || item.name}
                                                className="trending-preview-img"
                                            />
                                        ))}
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* Main Marketplace Section */}
            <div className="main-marketplace">
                <div className="marketplace-header">
                    <div className="header-content">
                        <h2>Browse NFTs</h2>
                        {status && (
                            <div className="cache-status">
                                <span className="status-indicator">{status}</span>
                            </div>
                        )}
                    </div>
                    <div className="marketplace-actions">
                        <button
                            className="refresh-button"
                            onClick={() => { fetchListings(true); if (auctionsEnabled) fetchAuctions(true); }}
                            disabled={isLoading}
                            title="Refresh listings from blockchain (R)"
                        >
                            <RefreshIcon />
                            {isLoading ? 'Loading...' : 'Refresh'}
                        </button>
                        <button
                            className="refresh-button deep"
                            onClick={deepRescan}
                            disabled={isLoading}
                            title="Trigger fresh data sync from blockchain (S)"
                        >
                            <DeepIcon />
                            {isLoading ? 'Syncing...' : 'Sync Data'}
                        </button>
                        <label className="filter-button" title="Auto refresh every interval">
                            <input
                                type="checkbox"
                                checked={autoRefreshEnabled}
                                onChange={(e) => setAutoRefreshEnabled(e.target.checked)}
                                style={{ marginRight: 8 }}
                            />
                            Auto
                        </label>
                        <select
                            className="sort-select"
                            value={autoRefreshMs}
                            onChange={(e) => setAutoRefreshMs(Number(e.target.value))}
                            title="Auto-refresh interval"
                            disabled={!autoRefreshEnabled}
                        >
                            <option value={30000}>30s</option>
                            <option value={60000}>1m</option>
                            <option value={120000}>2m</option>
                            <option value={300000}>5m</option>
                        </select>
                        <span className="status-indicator" aria-live="polite" style={{ marginLeft: 8 }}>{formatCountdown()}</span>
                        <button
                            className={`filter-button ${isFiltersOpen ? 'active' : ''}`}
                            onClick={() => setIsFiltersOpen(!isFiltersOpen)}
                            title="Open filters"
                        >
                            <FilterIcon /> Filters
                        </button>
                        <div className="search-bar">
                            <SearchIcon />
                            <input
                                ref={searchInputRef}
                                type="text"
                                placeholder="Search by name or token ID (/)"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        <select className="sort-select" value={sortMethod} onChange={(e) => setSortMethod(e.target.value)}>
                            <option value="newest">Newest</option>
                            <option value="oldest">Oldest</option>
                            <option value="price_low_to_high">Price: Low to High</option>
                            <option value="price_high_to_low">Price: High to Low</option>
                        </select>
                        <select
                            className="sort-select"
                            value={itemsPerPage}
                            onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }}
                            title="Items per page"
                        >
                            <option value={12}>12</option>
                            <option value={24}>24</option>
                            <option value={48}>48</option>
                        </select>
                        <label className="filter-button" title="Auto-load next page on scroll">
                            <input
                                type="checkbox"
                                checked={autoLoadNext}
                                onChange={(e) => setAutoLoadNext(e.target.checked)}
                                style={{ marginRight: 8 }}
                            />
                            Auto-Load
                        </label>
                        <div className="view-options">
                            <button
                                className={`view-option ${viewMode === 'grid' ? 'active' : ''}`}
                                onClick={() => setViewMode('grid')}
                                title="Grid View (G)"
                            >
                                <GridIcon />
                            </button>
                            <button
                                className={`view-option ${viewMode === 'list' ? 'active' : ''}`}
                                onClick={() => setViewMode('list')}
                                title="List View (L)"
                            >
                                <ListIcon />
                            </button>
                        </div>
                    </div>

                    {anyActiveFilter && (
                        <div className="active-filters">
                            {searchTerm && (
                                <span className="chip" title="Clear search" onClick={() => setSearchTerm('')}>
                                    🔎 {searchTerm} ✕
                                </span>
                            )}
                            {selectedCategories.map((id) => {
                                const label = categories.find(c => c.id === id)?.name || id;
                                return (
                                    <span key={id} className="chip" title="Remove category" onClick={() => toggleCategory(id)}>
                                        {label} ✕
                                    </span>
                                );
                            })}
                            {selectedCollections.map((addr) => (
                                <span key={addr} className="chip" title="Remove collection" onClick={() => toggleCollection(addr)}>
                                    {shortAddr(addr)} ✕
                                </span>
                            ))}
                            {(priceRange.min !== '' || priceRange.max !== '') && (
                                <span className="chip" title="Clear price range" onClick={() => setPriceRange({ min: '', max: '' })}>
                                    ${priceRange.min || '0'} - ${priceRange.max || '∞'} ✕
                                </span>
                            )}
                            <button className="secondary-button" style={{ marginLeft: 8 }} onClick={clearAllFilters}>
                                Clear all
                            </button>
                        </div>
                    )}
                </div>

                <div className="marketplace-content">
                    {/* Filters Sidebar */}
                    {isFiltersOpen && (
                        <div className="filters-sidebar">
                            <div className="filter-group">
                                <h3>Categories</h3>
                                <div className="filter-options">
                                    {categories.map((category) => (
                                        <label key={category.id} className="filter-option">
                                            <input
                                                type="checkbox"
                                                checked={selectedCategories.includes(category.id)}
                                                onChange={() => toggleCategory(category.id)}
                                            />
                                            <span>{category.name}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className="filter-group">
                                <h3>Collections</h3>
                                <div className="filter-options scrollable">
                                    {collections.slice(0, 10).map((collection) => {
                                        const humanName = labelForCollection(collection);
                                        const addrLower = (collection.address || '').toLowerCase();
                                        return (
                                            <label key={collection.address} className="filter-option collection-filter">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedCollections.includes(addrLower)}
                                                    onChange={() => toggleCollection(addrLower)}
                                                />
                                                <div className="collection-filter-info">
                                                    <div className="collection-filter-avatar">
                                                        <SmartImage
                                                            srcList={[collection.image, collection.items[0]?.image, collection.items[0]?.imageUrl]}
                                                            alt={humanName}
                                                            width={40}
                                                            height={40}
                                                            seed={`filter-${collection.address}`}
                                                            title={humanName}
                                                        />
                                                    </div>
                                                    <div className="collection-filter-details">
                                                        <span className="collection-name">{humanName}</span>
                                                        <span className="collection-stats">
                                                            {collection.items.length} items • Floor: $
                                                            {collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}
                                                        </span>
                                                    </div>
                                                </div>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="filter-group">
                                <h3>Price Range (VTRU)</h3>
                                <div className="price-inputs">
                                    <input
                                        type="number"
                                        placeholder="Min"
                                        value={priceRange.min}
                                        onChange={(e) => setPriceRange({ ...priceRange, min: e.target.value })}
                                        min="0"
                                        step="0.001"
                                    />
                                    <span className="price-range-separator">to</span>
                                    <input
                                        type="number"
                                        placeholder="Max"
                                        value={priceRange.max}
                                        onChange={(e) => setPriceRange({ ...priceRange, max: e.target.value })}
                                        min="0"
                                        step="0.001"
                                    />
                                </div>
                            </div>

                            <button
                                className="clear-filters-button"
                                onClick={clearAllFilters}
                            >
                                Clear All Filters
                            </button>
                        </div>
                    )}

                    {/* NFT Listings */}
                    <div className={`listings-container ${viewMode}`}>
                        {!isInitialized ? (
                            <EmptyState
                                icon="⚙️"
                                title="Initializing Marketplace"
                                description="Setting up the marketplace and connecting to the blockchain..."
                                className="loading"
                            />
                        ) : isLoading ? (
                            <LoadingSkeleton type="card" count={6} className="grid" />
                        ) : currentItems.length > 0 ? (
                            <>
                                <div className={`listings-${viewMode}`}>
                                    {currentItems.map((listing) => (
                                        <ListingCard key={listing.id} listing={listing} viewMode={viewMode} />
                                    ))}
                                </div>

                                {/* Pagination */}
                                {!autoLoadNext && totalPages > 1 && (
                                    <div className="pagination">
                                        <button onClick={() => paginate(1)} disabled={currentPage === 1} className="pagination-button">First</button>
                                        <button onClick={() => paginate(currentPage - 1)} disabled={currentPage === 1} className="pagination-button">Previous</button>
                                        <div className="pagination-info">Page {Math.min(currentPage, totalPages)} of {totalPages}</div>
                                        <button onClick={() => paginate(currentPage + 1)} disabled={currentPage >= totalPages} className="pagination-button">Next</button>
                                        <button onClick={() => paginate(totalPages)} disabled={currentPage >= totalPages} className="pagination-button">Last</button>
                                    </div>
                                )}

                                {/* Infinite loader sentinel */}
                                {autoLoadNext && currentPage < totalPages && (
                                    <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />
                                )}
                            </>
                        ) : (
                            <EmptyState
                                icon={
                                    anyActiveFilter ? '🔍' : '🛍️'
                                }
                                title={
                                    anyActiveFilter ? 'No Results Found' : 'No NFTs Available'
                                }
                                description={
                                    anyActiveFilter
                                        ? "Try adjusting your filters or search criteria to find what you're looking for."
                                        : 'There are currently no active listings in the marketplace. Try syncing fresh data if you expect items to appear.'
                                }
                                actionText={anyActiveFilter ? 'Clear Filters' : 'Sync Data'}
                                onAction={() => {
                                    if (anyActiveFilter) {
                                        clearAllFilters();
                                    } else {
                                        deepRescan();
                                    }
                                }}
                                secondaryActionText={anyActiveFilter ? 'Sync Data' : 'Create Auction'}
                                onSecondaryAction={() => {
                                    if (anyActiveFilter) {
                                        deepRescan();
                                    } else {
                                        window.location.href = '/auctions/create';
                                    }
                                }}
                                className="marketplace"
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* Status message */}
            {status && <div className="status-message">{status}</div>}

            {/* Call-to-action Section */}
            <section className="marketplace-cta">
                <div className="cta-content">
                    <h2>Ready to list your NFTs?</h2>
                    <p>Join creators and collectors in the vibrant Vitruveo marketplace</p>
                    <div className="cta-buttons">
                        {wallet ? (
                            <>
                                <a href="/sell" className="primary-button">Create a Listing</a>
                                <a href="/auctions/create" className="primary-button">Create Auction</a>
                            </>
                        ) : (
                            <button className="primary-button" onClick={connect}>Connect Wallet</button>
                        )}
                        <a href="/profile" className="secondary-button">View Your Profile</a>
                        <a href="/vibe-dashboard" className="secondary-button">VIBE Analytics</a>
                    </div>
                </div>
                <div className="cta-image">
                    <img src={blockdustLogo} alt="BlockDust NFT Marketplace" />
                </div>
            </section>
        </div>
    );
}

export default MarketplacePage;