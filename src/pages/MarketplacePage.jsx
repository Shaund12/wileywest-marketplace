import React, { useState, useEffect, useRef } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import ListingCard from '../components/ListingCard';
import MarketplaceStats from '../components/MarketplaceStats';
import EmptyState from '../components/EmptyState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { convertToUSDCValue, formatPriceWithUSDC } from '../utils/tokenUtils';
import { ethers } from 'ethers';
import './MarketplacePage.css';
import '../components/MarketplaceStats.css';

/* =========================
   Smart IPFS Image + SVG fallback
   ========================= */
const IPFS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipfs/',
    'https://cf-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://infura-ipfs.io/ipfs/',
    'https://w3s.link/ipfs/',
    'https://nftstorage.link/ipfs/',
    'https://ipfs.io/ipfs/'
];
const IPNS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipns/',
    'https://cf-ipfs.com/ipns/',
    'https://dweb.link/ipns/',
    'https://gateway.pinata.cloud/ipns/',
    'https://infura-ipfs.io/ipns/',
    'https://w3s.link/ipns/',
    'https://nftstorage.link/ipns/',
    'https://ipfs.io/ipns/'
];

const smartImageCache = new Map(); // key -> working URL

const safeStr = (v, d = '') => (typeof v === 'string' ? v : d);

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}
function svgFallbackDataUrl({ seed = 'nft', width = 300, height = 200, title = '' }) {
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

    // Arweave
    if (url.startsWith('ar://')) return [`https://arweave.net/${url.slice(5)}`];
    if (/^https?:\/\/arweave\.net\//i.test(url)) return [url];

    // ipfs:// and ipns://
    if (url.startsWith('ipfs://')) {
        let rest = url.slice(7).replace(/^ipfs\//i, '');
        return IPFS_GATEWAYS.map(g => g + rest);
    }
    if (url.startsWith('ipns://')) {
        let rest = url.slice(7).replace(/^ipns\//i, '');
        return IPNS_GATEWAYS.map(g => g + rest);
    }

    // http(s) with /ipfs/ or /ipns/
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const ipfsIdx = parts.indexOf('ipfs');
        const ipnsIdx = parts.indexOf('ipns');
        if (ipfsIdx !== -1 && parts[ipfsIdx + 1]) {
            const rest = parts.slice(ipfsIdx + 1).join('/');
            return IPFS_GATEWAYS.map(g => g + rest);
        }
        if (ipnsIdx !== -1 && parts[ipnsIdx + 1]) {
            const rest = parts.slice(ipnsIdx + 1).join('/');
            return IPNS_GATEWAYS.map(g => g + rest);
        }
        return [url];
    } catch {
        // If it looks like a bare CID, spray gateways
        if (/^[a-z0-9]+$/i.test(url)) {
            return IPFS_GATEWAYS.map(g => g + url);
        }
        return [url];
    }
}

function uniq(arr) {
    const s = new Set(); const out = [];
    for (const x of arr) if (!s.has(x)) { s.add(x); out.push(x); }
    return out;
}
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
    title = ''
}) {
    const [url, setUrl] = useState(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const raws = [];
        if (src) raws.push(src);
        if (Array.isArray(srcList)) raws.push(...srcList);

        const key = raws.join('|');
        if (smartImageCache.has(key)) {
            setUrl(smartImageCache.get(key));
            setFailed(false);
            return;
        }

        const candidates = uniq(flatten(raws.map(expandToCandidateUrls)));
        if (!candidates.length) {
            setUrl(null); setFailed(true);
            return;
        }

        findFirstWorkingImage(candidates).then(u => {
            if (cancelled) return;
            smartImageCache.set(key, u);
            setUrl(u);
            setFailed(false);
        }).catch(() => {
            if (cancelled) return;
            setUrl(null);
            setFailed(true);
        });

        return () => { cancelled = true; };
    }, [src, JSON.stringify(srcList)]); // srcList can be dynamic

    const finalSrc = failed || !url
        ? svgFallbackDataUrl({ seed, width, height, title })
        : url;

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

function MarketplacePage() {
    const {
        listings,
        hotListings,
        fetchListings,
        status,
        setStatus,
        isInitialized,
        marketplaceStats,
        canceledListings
    } = useMarketplace();
    const { wallet, connect, provider } = useWallet();
    const [searchTerm, setSearchTerm] = useState('');
    const [filteredListings, setFilteredListings] = useState([]);
    const [viewMode, setViewMode] = useState('grid');
    const [sortMethod, setSortMethod] = useState('newest');
    const [isLoading, setIsLoading] = useState(true);
    const [isFiltersOpen, setIsFiltersOpen] = useState(false);
    const [selectedCategories, setSelectedCategories] = useState([]);
    const [selectedCollections, setSelectedCollections] = useState([]);
    const [priceRange, setPriceRange] = useState({ min: '', max: '' });
    const [featuredNFT, setFeaturedNFT] = useState(null);
    const [featuredNFTPriceDisplay, setFeaturedNFTPriceDisplay] = useState({
        tokenAmount: '...',
        tokenSymbol: 'TOKEN',
        usdcValue: '0.00',
        formatted: '...',
        hasUSDCRate: true
    });
    const [collections, setCollections] = useState([]);
    const [stats, setStats] = useState({
        totalVolume: 0,
        totalListings: 0,
        avgPrice: 0,
        floorPrice: 0,
        currentListingVolume: 0,
        actualSoldVolume: 0,
        hasUSDCRates: true
    });
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage] = useState(12);
    const topRef = useRef(null);
    const hasLoadedRef = useRef(false);

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

    // Load listings and process data
    useEffect(() => {
        async function loadData() {
            if (!hasLoadedRef.current && isInitialized && fetchListings) {
                try {
                    setIsLoading(true);
                    await fetchListings();
                    hasLoadedRef.current = true;
                } catch (error) {
                    console.error("[Marketplace] Error fetching listings:", error);
                    setStatus("Error loading marketplace data");
                } finally {
                    setIsLoading(false);
                }
            }
        }
        loadData();

        window.refreshMarketplace = async () => {
            try {
                setIsLoading(true);
                await fetchListings();
            } catch (error) {
                console.error("[Marketplace] Refresh error:", error);
            } finally {
                setIsLoading(false);
            }
        };
        return () => { delete window.refreshMarketplace; };
    }, [isInitialized, fetchListings, setStatus]);

    // Process listings and extract metadata with enhanced volume tracking
    useEffect(() => {
        async function processListingsWithEnhancedStats() {
            if (listings.length > 0 && provider) {
                try {
                    const collectionMap = {};
                    let currentListingVolumeUSDC = 0;
                    let lowestPriceUSDC = Infinity;
                    const pricePromises = [];
                    let hasAnyUSDCRates = false;

                    const activeListings = listings.filter(listing =>
                        listing.active && !canceledListings.has(listing.id?.toString())
                    );

                    for (const listing of activeListings) {
                        const collectionAddress = listing.nftContract;
                        if (!collectionMap[collectionAddress]) {
                            let collectionName = `Collection ${collectionAddress.slice(0, 8)}...${collectionAddress.slice(-6)}`;
                            let collectionDescription = '';
                            let collectionImage = listing.image || listing.imageUrl || listing.metadata?.image || listing.metadata?.image_url;
                            let collectionWebsite = '';

                            if (listing.collectionName && listing.collectionName.trim() !== '' &&
                                !listing.collectionName.includes('Collection 0x')) {
                                collectionName = listing.collectionName.trim();
                            } else if (listing.metadata?.collection?.name && listing.metadata.collection.name.trim() !== '') {
                                collectionName = listing.metadata.collection.name.trim();
                            } else if (listing.metadata?.name && listing.metadata.name.trim() !== '' &&
                                !listing.metadata.name.includes('#') &&
                                !listing.metadata.name.toLowerCase().includes('token') &&
                                !listing.metadata.name.toLowerCase().includes('nft')) {
                                collectionName = listing.metadata.name.trim();
                            }

                            if (listing.metadata?.collection) {
                                collectionDescription = listing.metadata.collection.description || '';
                                collectionImage = listing.metadata.collection.image || collectionImage;
                                collectionWebsite = listing.metadata.collection.external_link || listing.metadata.collection.external_url || '';
                            }

                            collectionMap[collectionAddress] = {
                                address: collectionAddress,
                                name: collectionName,
                                description: collectionDescription,
                                image: collectionImage,
                                website: collectionWebsite,
                                items: [],
                                floorPrice: Infinity,
                                totalVolume: 0,
                                avgPrice: 0,
                                highestPrice: 0,
                                lowestPrice: Infinity,
                                createdAt: Date.now()
                            };
                        }

                        collectionMap[collectionAddress].items.push(listing);

                        pricePromises.push(
                            convertToUSDCValue(listing.pricePerUnit, listing.paymentToken, provider)
                                .then(usdcPrice => {
                                    hasAnyUSDCRates = true;
                                    return { listing, usdcPrice, hasRate: true };
                                })
                                .catch(() => ({ listing, usdcPrice: 0, hasRate: false }))
                        );
                    }

                    const priceResults = await Promise.all(pricePromises);

                    priceResults.forEach(({ listing, usdcPrice, hasRate }) => {
                        const collectionAddress = listing.nftContract;
                        if (hasRate) {
                            collectionMap[collectionAddress].totalVolume += usdcPrice;
                            if (usdcPrice < collectionMap[collectionAddress].floorPrice) {
                                collectionMap[collectionAddress].floorPrice = usdcPrice;
                                collectionMap[collectionAddress].lowestPrice = usdcPrice;
                            }
                            if (usdcPrice > collectionMap[collectionAddress].highestPrice) {
                                collectionMap[collectionAddress].highestPrice = usdcPrice;
                            }
                            currentListingVolumeUSDC += usdcPrice;
                            if (usdcPrice < lowestPriceUSDC) lowestPriceUSDC = usdcPrice;
                        }
                    });

                    Object.values(collectionMap).forEach(collection => {
                        if (collection.items.length > 0) {
                            collection.avgPrice = collection.totalVolume / collection.items.length;
                            if (collection.floorPrice === Infinity) {
                                collection.floorPrice = 0;
                                collection.lowestPrice = 0;
                            }
                        }
                    });

                    const collectionsList = Object.values(collectionMap).sort(
                        (a, b) => b.items.length - a.items.length
                    );

                    setCollections(collectionsList);

                    const actualSoldVolume = marketplaceStats.actualSoldVolume || 0;

                    setStats({
                        currentListingVolume: currentListingVolumeUSDC.toFixed(2),
                        actualSoldVolume: actualSoldVolume.toFixed(2),
                        totalListings: activeListings.length,
                        totalVolume: (currentListingVolumeUSDC + actualSoldVolume).toFixed(2),
                        avgPrice: activeListings.length > 0 ? (currentListingVolumeUSDC / activeListings.length).toFixed(2) : '0.00',
                        floorPrice: lowestPriceUSDC === Infinity ? '0.00' : lowestPriceUSDC.toFixed(2),
                        hasUSDCRates: hasAnyUSDCRates
                    });

                    if (hotListings && hotListings.length > 0) {
                        setFeaturedNFT(hotListings[0]);
                    } else if (activeListings.length > 0) {
                        const highest = priceResults.reduce((max, cur) => cur.usdcPrice > max.usdcPrice ? cur : max, { usdcPrice: 0, listing: activeListings[0] });
                        setFeaturedNFT(highest.listing);
                    }
                } catch (error) {
                    console.error('Error processing listings with enhanced stats:', error);
                    const activeListings = listings.filter(listing =>
                        listing.active && !canceledListings.has(listing.id?.toString())
                    );
                    const collectionMap = {};
                    let totalVolume = 0;
                    let lowestPrice = Infinity;

                    activeListings.forEach(listing => {
                        const collectionAddress = listing.nftContract;
                        if (!collectionMap[collectionAddress]) {
                            let collectionName = `Collection ${collectionAddress.slice(0, 8)}...${collectionAddress.slice(-6)}`;
                            if (listing.collectionName && listing.collectionName.trim() !== '' &&
                                !listing.collectionName.includes('Collection 0x')) {
                                collectionName = listing.collectionName.trim();
                            } else if (listing.metadata?.collection?.name && listing.metadata.collection.name.trim() !== '') {
                                collectionName = listing.metadata.collection.name.trim();
                            } else if (listing.metadata?.name && listing.metadata.name.trim() !== '' &&
                                !listing.metadata.name.includes('#') &&
                                !listing.metadata.name.toLowerCase().includes('token') &&
                                !listing.metadata.name.toLowerCase().includes('nft')) {
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
                                lowestPrice: Infinity
                            };
                        }

                        const priceInEth = parseFloat(ethers.formatEther(listing.pricePerUnit));
                        collectionMap[collectionAddress].items.push(listing);
                        collectionMap[collectionAddress].totalVolume += priceInEth;

                        if (priceInEth < collectionMap[collectionAddress].floorPrice) {
                            collectionMap[collectionAddress].floorPrice = priceInEth;
                        }

                        totalVolume += priceInEth;
                        if (priceInEth < lowestPrice) lowestPrice = priceInEth;
                    });

                    const collectionsList = Object.values(collectionMap).sort(
                        (a, b) => b.items.length - a.items.length
                    );
                    setCollections(collectionsList);

                    setStats({
                        currentListingVolume: `${totalVolume.toFixed(2)} (no USDC rate available)`,
                        actualSoldVolume: '0.00 (no USDC rate available)',
                        totalListings: activeListings.length,
                        totalVolume: `${totalVolume.toFixed(2)} (no USDC rate available)`,
                        avgPrice: activeListings.length > 0 ? `${(totalVolume / activeListings.length).toFixed(3)} (est.)` : '0.00',
                        floorPrice: lowestPrice === Infinity ? '0.00' : `${lowestPrice.toFixed(3)} (est.)`,
                        hasUSDCRates: false
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
                    hasUSDCRates: true
                });
            }
        }
        processListingsWithEnhancedStats();
    }, [listings, hotListings, provider, canceledListings, marketplaceStats]);

    // Update featured NFT price display
    useEffect(() => {
        async function updateFeaturedNFTPriceDisplay() {
            if (!featuredNFT || !featuredNFT.pricePerUnit || !provider) {
                setFeaturedNFTPriceDisplay({
                    tokenAmount: '...',
                    tokenSymbol: 'TOKEN',
                    usdcValue: '0.00',
                    formatted: '...',
                    hasUSDCRate: true
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
            } catch (error) {
                const tokenSymbol = featuredNFT.paymentToken ?
                    (featuredNFT.paymentToken === ethers.ZeroAddress ? 'VTRU' : 'TOKEN') :
                    'VTRU';
                const tokenAmount = formatPrice(featuredNFT.pricePerUnit);
                setFeaturedNFTPriceDisplay({
                    tokenAmount,
                    tokenSymbol,
                    usdcValue: '0.00',
                    formatted: `${tokenAmount} ${tokenSymbol}`,
                    hasUSDCRate: false
                });
            }
        }
        updateFeaturedNFTPriceDisplay();
    }, [featuredNFT, provider]);

    // Filter + sort
    useEffect(() => {
        let result = [...listings];

        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            result = result.filter(
                item =>
                    (item.name?.toLowerCase().includes(term)) ||
                    (item.metadata?.name?.toLowerCase().includes(term)) ||
                    (item.metadata?.description?.toLowerCase().includes(term)) ||
                    item.tokenId.toString().includes(term)
            );
        }

        if (selectedCategories.length > 0) {
            result = result.filter(item => {
                const category = item.metadata?.properties?.category ||
                    item.metadata?.attributes?.find(attr => attr.trait_type === 'Category')?.value;
                return category && selectedCategories.includes(String(category).toLowerCase());
            });
        }

        if (selectedCollections.length > 0) {
            result = result.filter(item =>
                selectedCollections.includes(item.nftContract.toLowerCase())
            );
        }

        if (priceRange.min !== '') {
            const minWei = ethers.parseEther(priceRange.min.toString());
            result = result.filter(item => ethers.getBigInt(item.pricePerUnit) >= minWei);
        }
        if (priceRange.max !== '') {
            const maxWei = ethers.parseEther(priceRange.max.toString());
            result = result.filter(item => ethers.getBigInt(item.pricePerUnit) <= maxWei);
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
        }

        setFilteredListings(result);
    }, [listings, searchTerm, sortMethod, selectedCategories, selectedCollections, priceRange]);

    const indexOfLastItem = currentPage * itemsPerPage;
    const indexOfFirstItem = indexOfLastItem - itemsPerPage;
    const currentItems = filteredListings.slice(indexOfFirstItem, indexOfLastItem);
    const totalPages = Math.ceil(filteredListings.length / itemsPerPage);

    const paginate = (pageNumber) => {
        setCurrentPage(pageNumber);
        topRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const toggleCategory = (categoryId) => {
        if (selectedCategories.includes(categoryId)) {
            setSelectedCategories(selectedCategories.filter(cat => cat !== categoryId));
        } else {
            setSelectedCategories([...selectedCategories, categoryId]);
        }
    };
    const toggleCollection = (collectionAddress) => {
        if (selectedCollections.includes(collectionAddress)) {
            setSelectedCollections(selectedCollections.filter(col => col !== collectionAddress));
        } else {
            setSelectedCollections([...selectedCollections, collectionAddress]);
        }
    };
    const formatPrice = (priceInWei) => {
        try { return parseFloat(ethers.formatEther(priceInWei)).toFixed(4); }
        catch { return '0'; }
    };

    return (
        <div className="marketplace-container" ref={topRef}>
            {/* Hero Section */}
            <div className="marketplace-hero">
                <div className="hero-content">
                    <h1>Discover, Collect & Sell<br /><span className="gradient-text">Extraordinary NFTs</span></h1>
                    <p>Explore the most sought-after digital assets in the Vitruveo ecosystem</p>
                    <div className="hero-cta">
                        {wallet ? (
                            <a href="/sell" className="primary-button">Create Listing</a>
                        ) : (
                            <button className="primary-button" onClick={connect}>Connect Wallet</button>
                        )}
                        <button
                            className="secondary-button"
                            onClick={() => {
                                const el = document.querySelector('.marketplace-stats');
                                if (el) window.scrollTo({ top: el.offsetTop, behavior: 'smooth' });
                            }}
                        >
                            Browse Marketplace
                        </button>
                    </div>
                </div>
                <div className="hero-featured-nft">
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
                                        featuredNFT.metadata?.animation_url
                                    ]}
                                    alt={featuredNFT.name || featuredNFT.metadata?.name || `NFT #${featuredNFT.tokenId}`}
                                    width={480}
                                    height={320}
                                    seed={`${safeStr(featuredNFT.nftContract)}-${safeStr(featuredNFT.tokenId)}`}
                                    title={featuredNFT.name || featuredNFT.metadata?.name}
                                    className="featured-image-img"
                                />
                            </div>
                            <div className="featured-details">
                                <h3>{featuredNFT.name || featuredNFT.metadata?.name || `NFT #${featuredNFT.tokenId}`}</h3>
                                <p className="featured-collection">
                                    {(featuredNFT.collectionName && featuredNFT.collectionName.trim() !== '' && !featuredNFT.collectionName.includes('Collection 0x')) ?
                                        featuredNFT.collectionName.trim() :
                                        (featuredNFT.metadata?.collection?.name && featuredNFT.metadata.collection.name.trim() !== '') ?
                                            featuredNFT.metadata.collection.name.trim() :
                                            (featuredNFT.metadata?.name && featuredNFT.metadata.name.trim() !== '' &&
                                                !featuredNFT.metadata.name.includes('#') &&
                                                !featuredNFT.metadata.name.toLowerCase().includes('token') &&
                                                !featuredNFT.metadata.name.toLowerCase().includes('nft')) ?
                                                featuredNFT.metadata.name.trim() :
                                                `${featuredNFT.nftContract.slice(0, 8)}...${featuredNFT.nftContract.slice(-6)}`
                                    }
                                </p>
                                {featuredNFT.metadata?.collection?.description && (
                                    <p className="featured-description">
                                        {featuredNFT.metadata.collection.description.slice(0, 80)}
                                        {featuredNFT.metadata.collection.description.length > 80 ? '...' : ''}
                                    </p>
                                )}
                                <div className="featured-price">
                                    <span className="price-label">Price:</span>
                                    <span className="price-value">
                                        {featuredNFTPriceDisplay.hasUSDCRate ? (
                                            featuredNFTPriceDisplay.formatted
                                        ) : (
                                            `${featuredNFTPriceDisplay.tokenAmount} ${featuredNFTPriceDisplay.tokenSymbol}`
                                        )}
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Marketplace Stats */}
            <div className="marketplace-stats">
                <div className="stat-card">
                    <h3>{stats.totalListings}</h3>
                    <p>Active Listings</p>
                    <small>(Excluding canceled)</small>
                </div>
                <div className="stat-card">
                    <h3>{stats.hasUSDCRates ? `$${stats.currentListingVolume}` : stats.currentListingVolume}</h3>
                    <p>Current Listing Volume</p>
                    <small>{stats.hasUSDCRates ? 'USDC' : 'Native tokens'}</small>
                </div>
                <div className="stat-card">
                    <h3>{stats.hasUSDCRates ? `$${stats.actualSoldVolume}` : stats.actualSoldVolume}</h3>
                    <p>Actual Sold Volume</p>
                    <small>{stats.hasUSDCRates ? 'USDC' : 'Native tokens'}</small>
                </div>
                <div className="stat-card">
                    <h3>{stats.hasUSDCRates ? `$${stats.floorPrice}` : stats.floorPrice}</h3>
                    <p>Floor Price</p>
                    <small>{stats.hasUSDCRates ? 'USDC' : 'Estimated'}</small>
                </div>
            </div>

            {/* Hot Collections Carousel */}
            <section className="hot-collections">
                <div className="section-header">
                    <h2>Popular Collections</h2>
                    <button className="see-all-button">See All</button>
                </div>

                <div className="collections-carousel">
                    {collections.slice(0, 5).map((collection, index) => (
                        <div className="collection-card enhanced" key={index}>
                            <div className="collection-header">
                                <div className="collection-avatar">
                                    <SmartImage
                                        srcList={[
                                            collection.image,
                                            collection.items[0]?.image,
                                            collection.items[0]?.imageUrl,
                                            collection.items[0]?.metadata?.image,
                                            collection.items[0]?.metadata?.image_url
                                        ]}
                                        alt={collection.name}
                                        width={64}
                                        height={64}
                                        seed={collection.address}
                                        title={collection.name}
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
                                                item.metadata?.animation_url
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
                                    <div className="preview-item more-items">
                                        <span>+{collection.items.length - 4}</span>
                                    </div>
                                )}
                            </div>
                            <div className="collection-info">
                                <h3 title={collection.name}>{collection.name}</h3>
                                {collection.description && (
                                    <p className="collection-description" title={collection.description}>
                                        {collection.description.slice(0, 60)}{collection.description.length > 60 ? '...' : ''}
                                    </p>
                                )}
                                <div className="collection-stats">
                                    <div className="stat">
                                        <span className="value">{collection.items.length}</span>
                                        <span className="label">items</span>
                                    </div>
                                    <div className="stat">
                                        <span className="value">${collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}</span>
                                        <span className="label">floor</span>
                                    </div>
                                    <div className="stat">
                                        <span className="value">${collection.totalVolume.toFixed(2)}</span>
                                        <span className="label">volume</span>
                                    </div>
                                    <div className="stat">
                                        <span className="value">${collection.avgPrice > 0 ? collection.avgPrice.toFixed(2) : '0.00'}</span>
                                        <span className="label">avg price</span>
                                    </div>
                                </div>
                                {collection.website && (
                                    <div className="collection-links">
                                        <a href={collection.website} target="_blank" rel="noopener noreferrer" className="website-link">
                                            🌐 Website
                                        </a>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Detailed Marketplace Statistics */}
            <MarketplaceStats />

            {/* Trending Collections */}
            {collections.length > 0 && (
                <section className="trending-collections">
                    <div className="section-header">
                        <h2>Trending Collections</h2>
                        <div className="trend-filters">
                            <button className="trend-filter active">📈 Volume</button>
                            <button className="trend-filter">🔥 Hot</button>
                            <button className="trend-filter">⭐ New</button>
                        </div>
                    </div>

                    <div className="trending-collections-grid">
                        {collections.slice(0, 6).map((collection, index) => (
                            <div className="trending-collection-card" key={collection.address}>
                                <div className="trending-rank">#{index + 1}</div>
                                <div className="trending-collection-header">
                                    <div className="trending-avatar">
                                        <SmartImage
                                            srcList={[
                                                collection.image,
                                                collection.items[0]?.image,
                                                collection.items[0]?.imageUrl,
                                                collection.items[0]?.metadata?.image,
                                                collection.items[0]?.metadata?.image_url
                                            ]}
                                            alt={collection.name}
                                            width={56}
                                            height={56}
                                            seed={`trend-${collection.address}`}
                                            title={collection.name}
                                        />
                                    </div>
                                    <div className="trending-info">
                                        <h4>{collection.name}</h4>
                                        <p>{collection.items.length} items</p>
                                    </div>
                                    <div className="trending-change">
                                        <span className="change-percentage">+12.5%</span>
                                        <span className="change-label">24h</span>
                                    </div>
                                </div>

                                <div className="trending-metrics">
                                    <div className="metric">
                                        <span className="metric-label">Floor Price</span>
                                        <span className="metric-value">${collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}</span>
                                    </div>
                                    <div className="metric">
                                        <span className="metric-label">Volume</span>
                                        <span className="metric-value">${collection.totalVolume.toFixed(2)}</span>
                                    </div>
                                    <div className="metric">
                                        <span className="metric-label">Avg Price</span>
                                        <span className="metric-value">${collection.avgPrice > 0 ? collection.avgPrice.toFixed(2) : '0.00'}</span>
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
                                                item.metadata?.animation_url
                                            ]}
                                            alt={`${collection.name} item ${i + 1}`}
                                            width={120}
                                            height={90}
                                            seed={`trend-prev-${collection.address}-${i}`}
                                            title={item.metadata?.name || item.name}
                                            className="trending-preview-img"
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}
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
                            onClick={() => fetchListings(true)}
                            disabled={isLoading}
                            title="Refresh listings from blockchain"
                        >
                            <RefreshIcon />
                            {isLoading ? 'Loading...' : 'Refresh'}
                        </button>
                        <button
                            className={`filter-button ${isFiltersOpen ? 'active' : ''}`}
                            onClick={() => setIsFiltersOpen(!isFiltersOpen)}
                        >
                            <FilterIcon /> Filters
                        </button>
                        <div className="search-bar">
                            <SearchIcon />
                            <input
                                type="text"
                                placeholder="Search by name or token ID"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        <select
                            className="sort-select"
                            value={sortMethod}
                            onChange={(e) => setSortMethod(e.target.value)}
                        >
                            <option value="newest">Newest</option>
                            <option value="oldest">Oldest</option>
                            <option value="price_low_to_high">Price: Low to High</option>
                            <option value="price_high_to_low">Price: High to Low</option>
                        </select>
                        <div className="view-options">
                            <button
                                className={`view-option ${viewMode === 'grid' ? 'active' : ''}`}
                                onClick={() => setViewMode('grid')}
                                title="Grid View"
                            >
                                <GridIcon />
                            </button>
                            <button
                                className={`view-option ${viewMode === 'list' ? 'active' : ''}`}
                                onClick={() => setViewMode('list')}
                                title="List View"
                            >
                                <ListIcon />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="marketplace-content">
                    {/* Filters Sidebar */}
                    {isFiltersOpen && (
                        <div className="filters-sidebar">
                            <div className="filter-group">
                                <h3>Categories</h3>
                                <div className="filter-options">
                                    {categories.map(category => (
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
                                    {collections.slice(0, 10).map(collection => (
                                        <label key={collection.address} className="filter-option collection-filter">
                                            <input
                                                type="checkbox"
                                                checked={selectedCollections.includes(collection.address.toLowerCase())}
                                                onChange={() => toggleCollection(collection.address.toLowerCase())}
                                            />
                                            <div className="collection-filter-info">
                                                <div className="collection-filter-avatar">
                                                    <SmartImage
                                                        srcList={[
                                                            collection.image,
                                                            collection.items[0]?.image,
                                                            collection.items[0]?.imageUrl
                                                        ]}
                                                        alt={collection.name}
                                                        width={40}
                                                        height={40}
                                                        seed={`filter-${collection.address}`}
                                                        title={collection.name}
                                                    />
                                                </div>
                                                <div className="collection-filter-details">
                                                    <span className="collection-name">{collection.name}</span>
                                                    <span className="collection-stats">
                                                        {collection.items.length} items • Floor: ${collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}
                                                    </span>
                                                </div>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className="filter-group">
                                <h3>Price Range (VTRU)</h3>
                                <div className="price-inputs">
                                    <input
                                        type="number"
                                        placeholder="Min"
                                        value={priceRange.min}
                                        onChange={e => setPriceRange({ ...priceRange, min: e.target.value })}
                                        min="0"
                                        step="0.001"
                                    />
                                    <span className="price-range-separator">to</span>
                                    <input
                                        type="number"
                                        placeholder="Max"
                                        value={priceRange.max}
                                        onChange={e => setPriceRange({ ...priceRange, max: e.target.value })}
                                        min="0"
                                        step="0.001"
                                    />
                                </div>
                            </div>

                            <button
                                className="clear-filters-button"
                                onClick={() => {
                                    setSelectedCategories([]);
                                    setSelectedCollections([]);
                                    setPriceRange({ min: '', max: '' });
                                }}
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
                            <LoadingSkeleton
                                type="card"
                                count={6}
                                className="grid"
                            />
                        ) : currentItems.length > 0 ? (
                            <>
                                <div className={`listings-${viewMode}`}>
                                    {currentItems.map(listing => (
                                        <ListingCard
                                            key={listing.id}
                                            listing={listing}
                                            viewMode={viewMode}
                                        />
                                    ))}
                                </div>

                                {/* Pagination */}
                                {totalPages > 1 && (
                                    <div className="pagination">
                                        <button
                                            onClick={() => paginate(1)}
                                            disabled={currentPage === 1}
                                            className="pagination-button"
                                        >
                                            First
                                        </button>
                                        <button
                                            onClick={() => paginate(currentPage - 1)}
                                            disabled={currentPage === 1}
                                            className="pagination-button"
                                        >
                                            Previous
                                        </button>

                                        <div className="pagination-info">
                                            Page {currentPage} of {totalPages}
                                        </div>

                                        <button
                                            onClick={() => paginate(currentPage + 1)}
                                            disabled={currentPage === totalPages}
                                            className="pagination-button"
                                        >
                                            Next
                                        </button>
                                        <button
                                            onClick={() => paginate(totalPages)}
                                            disabled={currentPage === totalPages}
                                            className="pagination-button"
                                        >
                                            Last
                                        </button>
                                    </div>
                                )}
                            </>
                        ) : (
                            <EmptyState
                                icon={searchTerm || selectedCategories.length > 0 || selectedCollections.length > 0 ||
                                    priceRange.min !== '' || priceRange.max !== '' ? "🔍" : "🛍️"}
                                title={searchTerm || selectedCategories.length > 0 || selectedCollections.length > 0 ||
                                    priceRange.min !== '' || priceRange.max !== '' ? "No Results Found" : "No NFTs Available"}
                                description={searchTerm || selectedCategories.length > 0 || selectedCollections.length > 0 ||
                                    priceRange.min !== '' || priceRange.max !== '' ?
                                    "Try adjusting your filters or search criteria to find what you're looking for." :
                                    "There are currently no active listings in the marketplace. Check back soon or be the first to list your NFT!"}
                                actionText="Refresh Marketplace"
                                onAction={() => {
                                    setSearchTerm('');
                                    setSelectedCategories([]);
                                    setSelectedCollections([]);
                                    setPriceRange({ min: '', max: '' });
                                    fetchListings();
                                }}
                                secondaryActionText={!(searchTerm || selectedCategories.length > 0 || selectedCollections.length > 0 ||
                                    priceRange.min !== '' || priceRange.max !== '') ? "List Your NFT" : "Clear Filters"}
                                onSecondaryAction={() => {
                                    if (searchTerm || selectedCategories.length > 0 || selectedCollections.length > 0 ||
                                        priceRange.min !== '' || priceRange.max !== '') {
                                        setSearchTerm('');
                                        setSelectedCategories([]);
                                        setSelectedCollections([]);
                                        setPriceRange({ min: '', max: '' });
                                    } else {
                                        window.location.href = '/sell';
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
                            <a href="/sell" className="primary-button">Create a Listing</a>
                        ) : (
                            <button className="primary-button" onClick={connect}>Connect Wallet</button>
                        )}
                        <a href="/profile" className="secondary-button">View Your Profile</a>
                    </div>
                </div>
                <div className="cta-image">
                    {/* Put blockdust-logo.png in /public root */}
                    <img src="src//blockdust-logo.png" alt="BlockDust NFT Marketplace" />
                </div>
            </section>
        </div>
    );
}

export default MarketplacePage;
