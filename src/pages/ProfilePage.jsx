import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
import { ethers } from 'ethers';
import ListingCard from '../components/ListingCard';
import LazyNftGrid from '../components/LazyNftGrid';
import '../profile-page.css';
import CacheStats from '../components/CacheStats';
import EdgeCacheMonitor from '../components/EdgeCacheMonitor';
import { isAuctionsEnabled } from '../utils/featureFlags';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import { NFTScanner } from '../utils/nftScanner';
import { verifyNFTOwnership, filterOwnedNFTs } from '../utils/nftOwnershipUtils';
import { loadNFTMetadata, batchLoadMetadata } from '../utils/metadataLoader';
import { getCachedMetadata, getProxyImageUrl, batchPrewarm } from '../utils/edgeCacheUtils';
import { VSHARE_ADDRESS, vShareLpSvgDataUrl, vShareDefaultDescription, isVShareContract, getVShareMetadata } from '../utils/vShareUtils';
import { generateFallbackImage } from '../utils/nftUtils';

// Standard ERC721 and ERC1155 minimal ABIs
const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function transferFrom(address from, address to, uint256 tokenId)',
    'function safeTransferFrom(address from, address to, uint256 tokenId)',
    'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
    'function burn(uint256 tokenId)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

const ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
    'function uri(uint256 id) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
    'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
    'function burn(address account, uint256 id, uint256 value)',
    'function burnBatch(address account, uint256[] ids, uint256[] values)',
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
];

// List of known NFT collections to scan
const KNOWN_NFT_CONTRACTS = [
    '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906', // Pixel Ninja Cats
    '0x89207A7F75C9cb7C8f95f0c2517b029BE1AE29b8', // NeonKatz
    '0xc5d518d131738481947cFa4670F94eb7b948a1ac', // V-Share
];

// Multiple IPFS gateways to try for better reliability (ordered by reliability)
const IPFS_GATEWAYS = [
    'https://gateway.pinata.cloud/ipfs/',
    'https://dweb.link/ipfs/',
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.ipfs.io/ipfs/',
    'https://ipfs.fleek.co/ipfs/',
];

// Small helpers for activity timeline
const shortAddr = (a = '') => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

// Enhanced timestamp coercion with better validation and fallbacks
const coerceMs = (v) => {
    if (v == null || v === undefined) return null;
    
    // Handle number timestamps
    if (typeof v === 'number') {
        if (!Number.isFinite(v) || v <= 0) return null;
        // Convert seconds to milliseconds if needed (timestamps before year 2001 are likely in seconds)
        return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
    
    // Handle string timestamps
    if (typeof v === 'string') {
        if (v.trim() === '') return null;
        
        // Try parsing as number first
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
            return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
        }
        
        // Try parsing as date string
        const d = Date.parse(v);
        if (!Number.isNaN(d) && d > 0) return d;
        
        return null;
    }
    
    // Handle object timestamps (like Firestore timestamps)
    if (v && typeof v === 'object') {
        // Firestore timestamp format
        if (typeof v.seconds === 'number' && Number.isFinite(v.seconds)) {
            return Math.round(v.seconds * 1000);
        }
        
        // Try toString method
        if (typeof v.toString === 'function') {
            const str = v.toString();
            const n = Number(str);
            if (Number.isFinite(n) && n > 0) {
                return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
            }
        }
    }
    
    return null;
};

// Enhanced timeAgo function with proper validation and fallbacks
const timeAgo = (ms) => {
    // Handle invalid or missing timestamps
    if (!ms || !Number.isFinite(ms) || ms <= 0) {
        return 'recently';
    }
    
    const now = Date.now();
    const timestamp = Number(ms);
    
    // Handle future timestamps (invalid data)
    if (timestamp > now + 60000) { // Allow 1 minute future for clock skew
        return 'recently';
    }
    
    const d = Math.max(0, now - timestamp);
    const s = Math.floor(d / 1000);
    
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s`;
    
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    
    const days = Math.floor(h / 24);
    if (days < 7) return `${days}d`;
    
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}w`;
    
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo`;
    
    const years = Math.floor(days / 365);
    return `${years}y`;
};

function ProfilePage() {
    const navigate = useNavigate();
    const { wallet, connect, provider, signer, chainId } = useWallet();
    const {
        listings,
        fetchListings,
        status,
        setStatus,
        marketplace,
        // NEW: include sales + canceled for activity
        salesHistory,
        canceledListings
    } = useMarketplace();
    const {
        supabase, // NEW: direct access for auctions (optional)
        cacheProfileData,
        getCachedProfile,
        subscribeToProfiles,
        isConnected: supabaseConnected
    } = useSupabase();

    const [activeTab, setActiveTab] = useState('myListings');
    const [userListings, setUserListings] = useState([]);
    const [userNfts, setUserNfts] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isListingsLoading, setIsListingsLoading] = useState(false);
    const [nftMetadata, setNftMetadata] = useState({});
    const [cancellingId, setCancellingId] = useState(null);
    const [nftFilter, setNftFilter] = useState('');
    const [contractInfo, setContractInfo] = useState({});
    const [isAdvancedSearch, setIsAdvancedSearch] = useState(false);
    const [showOnlyListable, setShowOnlyListable] = useState(false);
    const [groupByCollection, setGroupByCollection] = useState(true); // Default to grouped by collection
    const [currentView, setCurrentView] = useState('grid'); // 'grid' or 'list'
    const [selectedNft, setSelectedNft] = useState(null);
    const [showCacheMonitor, setShowCacheMonitor] = useState(false); // Edge cache monitor visibility
    const [showNftModal, setShowNftModal] = useState(false);
    const [showStatsModal, setShowStatsModal] = useState(false);
    const [collectionStats, setCollectionStats] = useState({});
    const [sortOption, setSortOption] = useState('default');
    const [collapsedCollections, setCollapsedCollections] = useState({});
    const [selectedNfts, setSelectedNfts] = useState(new Set());
    const [bulkMode, setBulkMode] = useState(false);
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [transferToAddress, setTransferToAddress] = useState('');
    const [transferQuantities, setTransferQuantities] = useState({});
    const [isTransferring, setIsTransferring] = useState(false);
    // Pagination removed - using lazy loading instead
    // const [currentPage, setCurrentPage] = useState(1);
    // const [itemsPerPage, setItemsPerPage] = useState(12);
    const modalRef = useRef(null);

    // NEW: Activity + auctions state
    const [userAuctions, setUserAuctions] = useState([]);
    const [isAuctionsLoading, setIsAuctionsLoading] = useState(false);
    const [activityFilter, setActivityFilter] = useState('all'); // all | listings | sales | purchases | auctions

    // Calculate collection stats
    useEffect(() => {
        if (userNfts.length > 0) {
            // Group NFTs by collection
            const collections = {};
            const types = { ERC721: 0, ERC1155: 0 };
            let totalItems = userNfts.length;
            let totalQuantity = 0;

            userNfts.forEach(nft => {
                // Count by type
                types[nft.type] = (types[nft.type] || 0) + 1;

                // Count total quantity
                totalQuantity += parseInt(nft.balance || 1);

                // Group by collection
                if (!collections[nft.contractAddress]) {
                    collections[nft.contractAddress] = {
                        address: nft.contractAddress,
                        name: contractInfo[nft.contractAddress]?.name || 'Unknown Collection',
                        symbol: contractInfo[nft.contractAddress]?.symbol || '',
                        count: 0,
                        type: nft.type,
                        items: []
                    };
                }

                collections[nft.contractAddress].count++;
                collections[nft.contractAddress].items.push(nft);
            });

            setCollectionStats({
                totalItems,
                totalQuantity,
                types,
                collections: Object.values(collections).sort((a, b) => b.count - a.count)
            });
        }
    }, [userNfts, contractInfo]);

    // Filter user's active listings
    useEffect(() => {
        if (wallet && listings.length > 0) {
            const filtered = listings.filter(
                listing => listing.seller?.toLowerCase() === wallet.toLowerCase()
            );
            setUserListings(filtered);
        } else {
            setUserListings([]);
        }
    }, [wallet, listings]);

    // NEW: Load user's auctions (if feature enabled and Supabase available)
    useEffect(() => {
        let cancelled = false;
        async function loadAuctions() {
            if (!wallet || !supabaseConnected || !supabase || !isAuctionsEnabled()) {
                setUserAuctions([]);
                return;
            }
            setIsAuctionsLoading(true);
            try {
                // Try common table names. If none exist, silently ignore.
                const tryTables = ['auctions', 'marketplace_auctions', 'auction_listings'];
                let rows = [];
                for (const table of tryTables) {
                    try {
                        const { data, error } = await supabase
                            .from(table)
                            .select('*')
                            .eq('seller', wallet.toLowerCase());
                        if (!error && Array.isArray(data) && data.length) {
                            rows = data;
                            break;
                        }
                    } catch { /* ignore */ }
                }
                if (cancelled) return;

                // Normalize minimal fields
                const normalized = rows.map(r => ({
                    id: String(r.id ?? r.auction_id ?? ''),
                    nftContract: (r.nft_contract || r.contract || '').toLowerCase(),
                    tokenId: String(r.token_id ?? r.tokenId ?? ''),
                    seller: (r.seller || '').toLowerCase(),
                    startPrice: String(r.start_price ?? r.startPrice ?? r.reserve ?? '0'),
                    paymentToken: r.payment_token || r.paymentToken || ethers.ZeroAddress,
                    status: (r.status || '').toLowerCase(), // e.g. active, ended, canceled
                    createdAt: r.created_at || r.createdAt || null,
                    endsAt: r.ends_at || r.endsAt || null
                }));
                setUserAuctions(normalized);
            } finally {
                if (!cancelled) setIsAuctionsLoading(false);
            }
        }
        if (activeTab === 'activity') loadAuctions();
        return () => { cancelled = true; };
    }, [activeTab, wallet, supabaseConnected, supabase]);

    // OPTIMIZED: Load user's NFT collection when collection tab is selected
    useEffect(() => {
        if (activeTab === 'collection' && wallet && provider && !isLoading) {
            // Use a timeout to prevent immediate re-triggering
            const timer = setTimeout(() => {
                findAllUserNfts(false, false, false); // Load from cache first
            }, 0);
            return () => clearTimeout(timer);
        }
    }, [activeTab, wallet, provider]); // Keep simple dependencies only

    // ENHANCED AUTOMATIC METADATA LOADING with edge cache: Trigger metadata loading when userNfts changes
    useEffect(() => {
        if (userNfts.length > 0 && !isLoading) {
            // Debounce metadata loading to prevent multiple rapid calls
            const timer = setTimeout(async () => {
                console.log('🚀 [AUTO METADATA] Checking if metadata loading needed for', userNfts.length, 'NFTs');
                
                // Check if any NFTs need metadata loading
                const nftsNeedingMetadata = userNfts.filter(nft => {
                    const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                    const metadata = nftMetadata[key];
                    
                    // NFT needs metadata if:
                    // 1. No metadata entry exists
                    // 2. Metadata exists but is not loaded and not currently loading
                    // 3. Metadata exists but has no actual content (no image and no description)
                    const needsMetadata = !metadata || 
                                        (!metadata.loaded && !metadata.loading) ||
                                        (metadata.loaded && !metadata.imageUrl && !metadata.description);
                    
                    return needsMetadata;
                });
                
                if (nftsNeedingMetadata.length > 0) {
                    console.log('⚡ [AUTO METADATA] Auto-loading metadata for', nftsNeedingMetadata.length, 'NFTs');
                    
                    // First, try batch pre-warming for instant cache population
                    console.log('🔥 [AUTO METADATA] Pre-warming cache for instant loading...');
                    await batchPrewarm(nftsNeedingMetadata);
                    
                    // Then load with cache-first approach
                    batchFetchMetadataWithCache(nftsNeedingMetadata);
                } else {
                    console.log('✅ [AUTO METADATA] All NFTs already have metadata loaded');
                }
            }, 500); // 500ms debounce
            
            return () => clearTimeout(timer);
        }
    }, [userNfts, nftMetadata, isLoading]); // Trigger when userNfts or metadata state changes

    // OPTIMIZED: Build activity timeline from multiple sources with enhanced timestamp validation
    const activities = useMemo(() => {
        if (!wallet) return [];

        const walletL = wallet.toLowerCase();
        const listingById = new Map(listings.map(l => [String(l.id), l]));
        const out = [];

        // Helper to get valid timestamp with proper fallbacks
        const getValidTimestamp = (item, fallbackAge = 0) => {
            // Try multiple timestamp fields in order of preference
            const timestampFields = [
                'createdAt', 'created_at', 'timestamp', 'blockTimestamp', 
                'listedAt', 'soldAt', 'purchasedAt', 'canceledAt'
            ];
            
            for (const field of timestampFields) {
                const ts = coerceMs(item[field]);
                if (ts && Number.isFinite(ts) && ts > 0) {
                    return ts;
                }
            }
            
            // If no valid timestamp found, use current time minus fallback age
            return Date.now() - fallbackAge;
        };

        // 1) Listings created by user
        for (const l of userListings) {
            const ts = getValidTimestamp(l, 0); // Recent for current listings
            const nftName = l.name || l.metadata?.name || `NFT #${l.tokenId}`;
            
            out.push({
                type: 'listing',
                ts,
                label: `Listed ${nftName}`,
                detail: `${shortAddr(l.nftContract)} · #${l.tokenId}`,
                refId: String(l.id),
                meta: { ...l }
            });
        }

        // 2) Purchases made by user (buyer = wallet)
        for (const s of salesHistory || []) {
            if ((s.buyer || '').toLowerCase() === walletL) {
                const ts = getValidTimestamp(s, Math.random() * 7 * 24 * 60 * 60 * 1000); // Random age up to 7 days
                const l = listingById.get(String(s.listingId));
                const nftInfo = l ? `${shortAddr(l.nftContract)} · #${l.tokenId}` : `Listing #${s.listingId}`;
                
                out.push({
                    type: 'purchase',
                    ts,
                    label: `Purchased ${l?.name || l?.metadata?.name || `NFT #${l?.tokenId || s.listingId}`}`,
                    detail: nftInfo,
                    refId: String(s.listingId),
                    meta: { ...s, listing: l || null }
                });
            }
        }

        // 3) Sales by user (seller = wallet if known)
        for (const s of salesHistory || []) {
            const seller = (s.seller || listingById.get(String(s.listingId))?.seller || '').toLowerCase();
            if (seller && seller === walletL) {
                const ts = getValidTimestamp(s, Math.random() * 14 * 24 * 60 * 60 * 1000); // Random age up to 14 days
                const l = listingById.get(String(s.listingId));
                const nftInfo = l ? `${shortAddr(l.nftContract)} · #${l.tokenId}` : `Listing #${s.listingId}`;
                
                out.push({
                    type: 'sale',
                    ts,
                    label: `Sold ${l?.name || l?.metadata?.name || `NFT #${l?.tokenId || s.listingId}`}`,
                    detail: nftInfo,
                    refId: String(s.listingId),
                    meta: { ...s, listing: l || null }
                });
            }
        }

        // 4) Cancellations (only include if we can attribute to user via current listings or seller)
        if (canceledListings && canceledListings.size > 0) {
            for (const id of canceledListings) {
                const l = listingById.get(String(id));
                const canAttribute = l && l.seller?.toLowerCase() === walletL;
                if (canAttribute) {
                    const ts = Date.now() - Math.random() * 24 * 60 * 60 * 1000; // Random age up to 1 day
                    const nftName = l.name || l.metadata?.name || `NFT #${l.tokenId}`;
                    
                    out.push({
                        type: 'cancel',
                        ts,
                        label: `Canceled ${nftName}`,
                        detail: `${shortAddr(l.nftContract)} · #${l.tokenId}`,
                        refId: String(id),
                        meta: { listing: l }
                    });
                }
            }
        }

        // 5) Auctions created by user (if any from Supabase)
        for (const a of userAuctions) {
            const ts = getValidTimestamp(a, Math.random() * 30 * 24 * 60 * 60 * 1000); // Random age up to 30 days
            const nftName = a.name || a.metadata?.name || `NFT #${a.tokenId}`;
            
            out.push({
                type: 'auction',
                ts,
                label: a.status === 'canceled' ? `Canceled auction for ${nftName}` : `Created auction for ${nftName}`,
                detail: `${shortAddr(a.nftContract)} · #${a.tokenId}`,
                refId: String(a.id || ''),
                meta: { ...a }
            });
            
            if (a.endsAt) {
                const endTs = coerceMs(a.endsAt);
                if (endTs && Number.isFinite(endTs) && endTs > 0 && endTs <= Date.now()) {
                    out.push({
                        type: 'auction_end',
                        ts: endTs,
                        label: `Auction ended for ${nftName}`,
                        detail: `${shortAddr(a.nftContract)} · #${a.tokenId}`,
                        refId: String(a.id || ''),
                        meta: { ...a }
                    });
                }
            }
        }

        // Sort newest first with proper timestamp validation
        out.sort((a, b) => {
            const tsA = Number(a.ts) || 0;
            const tsB = Number(b.ts) || 0;
            return tsB - tsA;
        });

        // Filter by UI filter
        const filtered = out.filter((e) => {
            if (activityFilter === 'all') return true;
            if (activityFilter === 'listings') return e.type === 'listing' || e.type === 'cancel';
            if (activityFilter === 'sales') return e.type === 'sale';
            if (activityFilter === 'purchases') return e.type === 'purchase';
            if (activityFilter === 'auctions') return e.type === 'auction' || e.type === 'auction_end';
            return true;
        });

        return filtered;
    }, [wallet, userListings, listings, salesHistory, canceledListings, userAuctions, activityFilter]);

    // Cancel a listing
    const cancelListing = async (listingId) => {
        if (!signer || !marketplace) return;

        try {
            setCancellingId(listingId);
            setStatus(`Cancelling listing #${listingId}...`);

            const connectedMarketplace = marketplace.connect(signer);
            const tx = await connectedMarketplace.cancelListing(listingId);
            setStatus("Transaction submitted. Waiting for confirmation...");
            await tx.wait();
            setStatus(`Listing #${listingId} cancelled successfully!`);
            fetchListings();

        } catch (error) {
            criticalError("Error cancelling listing:", error);
            setStatus(`Error cancelling listing: ${error.message || error}`);
        } finally {
            setCancellingId(null);
        }
    };

    // Refresh listings manually
    const refreshListings = async () => {
        setIsListingsLoading(true);
        try {
            await fetchListings();

            // Fetch metadata for all listings immediately after they're loaded
            if (listings && listings.length > 0) {
                const listingNfts = listings.map(listing => ({
                    contractAddress: listing.nftContract,
                    tokenId: listing.tokenId,
                    tokenURI: listing.metadata?.tokenURI || null,
                    type: listing.isERC1155 ? 'ERC1155' : 'ERC721'
                }));
                setTimeout(() => batchFetchMetadata(listingNfts), 100);
            }

            // Cache updated listings for the user
            if (supabaseConnected && cacheProfileData) {
                try {
                    const profileData = {
                        nfts: userNfts,
                        listings: userListings,
                        balance: await provider.getBalance(wallet).then(b => b.toString())
                    };

                    await cacheProfileData(wallet, profileData);
                } catch (cacheError) {
                    debugWarn("Failed to cache updated profile data:", cacheError);
                }
            }

            setStatus("Listings refreshed successfully");
        } catch (error) {
            setStatus("Failed to refresh listings");
        } finally {
            setIsListingsLoading(false);
        }
    };

    // Resolve IPFS URIs for metadata and images with fallbacks
    const resolveIpfsUri = (uri) => {
        if (!uri) return '';
        if (uri.startsWith('ipfs://')) {
            const cid = uri.replace('ipfs://', '');
            return `${IPFS_GATEWAYS[0]}${cid}`;
        }
        return uri;
    };

    // Optimized image URL resolution with Vitruveo-appropriate timeouts
    const resolveImageUrl = async (imageUri, timeoutMs = 8000) => {
        if (!imageUri) return null;
        
        // Direct HTTP/HTTPS URLs - return as-is
        if (imageUri.startsWith('http://') || imageUri.startsWith('https://')) {
            return imageUri;
        }
        
        // Data URIs - validate and return
        if (imageUri.startsWith('data:')) {
            return isSafeSvgUri(imageUri) ? imageUri : null;
        }
        
        // IPFS URIs - try more gateways for better reliability
        if (imageUri.startsWith('ipfs://')) {
            const hash = imageUri.replace('ipfs://', '');
            const reliableGateways = IPFS_GATEWAYS.slice(0, 4); // Try top 4 gateways for better success
            
            for (const gateway of reliableGateways) {
                try {
                    const url = `${gateway}${hash}`;
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                    
                    const response = await fetch(url, { 
                        method: 'HEAD',
                        signal: controller.signal 
                    });
                    
                    clearTimeout(timeoutId);
                    
                    if (response.ok) {
                        return url;
                    }
                } catch (error) {
                    // Continue to next gateway
                    continue;
                }
            }
        }
        
        // If all else fails, return the original URI
        return imageUri;
    };

    // Generate a custom LP-style placeholder SVG for NFTs
    const generateFallbackImageForNft = (contractAddress, tokenId) => {
        return generateFallbackImage(contractAddress, tokenId, contractInfo);
    };

    // Safe SVG URI validation to prevent crashes
    const isSafeSvgUri = (uri) => {
        if (!uri || typeof uri !== 'string') return false;
        
        // Check for data URIs containing SVG
        if (uri.startsWith('data:image/svg+xml')) {
            try {
                // Decode and check for potential issues
                const decoded = decodeURIComponent(uri);
                // Block potentially problematic SVG content
                if (decoded.includes('<script') || 
                    decoded.includes('javascript:') || 
                    decoded.includes('onload=') ||
                    decoded.includes('onerror=') ||
                    decoded.length > 100000) { // Limit size to prevent memory issues
                    return false;
                }
                return true;
            } catch (e) {
                return false;
            }
        }
        
        // Check for .svg files
        if (uri.toLowerCase().includes('.svg')) {
            return true; // Let browser handle validation
        }
        
        return true; // Not an SVG, should be safe
    };

    // Ultra-fast NFT metadata loading optimized for custom blockchain
    const fetchNftMetadata = async (contractAddress, tokenId, tokenURI) => {
        const key = `${contractAddress.toLowerCase()}-${tokenId}`;

        if (nftMetadata[key]?.loaded && !nftMetadata[key]?.error) return;

        setNftMetadata(prev => ({
            ...prev,
            [key]: {
                ...prev[key],
                loading: true,
                error: null
            }
        }));

        try {
            // Special handling for V-Share - use custom metadata
            if (isVShareContract(contractAddress)) {
                const vShareMetadata = getVShareMetadata(contractAddress, tokenId);
                setNftMetadata(prev => ({
                    ...prev,
                    [key]: vShareMetadata
                }));
                return;
            }

            // Use the optimized metadata loader for other NFTs
            const metadata = await loadNFTMetadata(contractAddress, tokenId, provider, 
                tokenURI ? { tokenURI } : null);

            setNftMetadata(prev => ({
                ...prev,
                [key]: metadata
            }));

        } catch (error) {
            debugWarn(`Failed to load metadata for ${contractAddress}:${tokenId}`, error);
            
            // Use V-Share metadata if this is a V-Share contract, even on error
            if (isVShareContract(contractAddress)) {
                const vShareMetadata = getVShareMetadata(contractAddress, tokenId);
                setNftMetadata(prev => ({
                    ...prev,
                    [key]: vShareMetadata
                }));
                return;
            }
            
            const fallbackImg = generateFallbackImageForNft(contractAddress, tokenId);
            setNftMetadata(prev => ({
                ...prev,
                [key]: {
                    name: `NFT #${tokenId}`,
                    description: 'Metadata unavailable',
                    imageUrl: fallbackImg,
                    attributes: [],
                    loaded: true,
                    loading: false,
                    error: error.message
                }
            }));
        }
    };

    // Enhanced batch metadata loading with edge cache-first approach
    const batchFetchMetadataWithCache = async (nfts) => {
        console.log('🚀 [CACHE BATCH] Starting cache-first metadata loading for', nfts.length, 'NFTs');
        
        if (!nfts || nfts.length === 0) {
            console.log('❌ [CACHE BATCH] No NFTs provided');
            return;
        }

        setStatus(`Loading metadata using edge cache for ${nfts.length} NFTs...`);

        // Process NFTs with edge cache first
        const metadataPromises = nfts.map(async (nft, index) => {
            const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
            
            try {
                console.log(`🔍 [CACHE BATCH] ${index + 1}/${nfts.length}: Loading ${key} via edge cache`);
                
                // Special handling for V-Share contracts - use custom metadata
                if (isVShareContract(nft.contractAddress)) {
                    console.log(`🎯 [CACHE BATCH] Using V-Share metadata for ${key}`);
                    const vShareMetadata = getVShareMetadata(nft.contractAddress, nft.tokenId);
                    return { key, metadata: vShareMetadata };
                }
                
                // Try edge cache first
                const metadata = await getCachedMetadata(nft.contractAddress, nft.tokenId);
                
                if (metadata && metadata.name && metadata.name !== `NFT #${nft.tokenId}`) {
                    console.log(`✅ [CACHE BATCH] Edge cache success for ${key} (source: ${metadata.source})`);
                    
                    // Process image URL through proxy
                    if (metadata.image) {
                        const proxyImageUrl = await getProxyImageUrl(metadata.image);
                        metadata.imageUrl = proxyImageUrl;
                        metadata.image = proxyImageUrl;
                    }
                    
                    return { key, metadata };
                } else {
                    console.log(`⚠️ [CACHE BATCH] Edge cache returned basic metadata for ${key}, trying fallback`);
                    
                    // Fallback to legacy loader
                    const fallbackMetadata = await loadNFTMetadata(
                        nft.contractAddress, 
                        nft.tokenId, 
                        provider
                    );
                    
                    return { key, metadata: fallbackMetadata };
                }
                
            } catch (error) {
                console.error(`❌ [CACHE BATCH] Failed to load metadata for ${key}:`, error);
                
                // Special handling for V-Share contracts
                if (isVShareContract(nft.contractAddress)) {
                    console.log(`🎯 [CACHE BATCH] Using V-Share metadata for ${key}`);
                    const vShareMetadata = getVShareMetadata(nft.contractAddress, nft.tokenId);
                    return { key, metadata: vShareMetadata };
                }
                
                    // Return fallback metadata to prevent crashes
                return {
                    key,
                    metadata: {
                        name: `NFT #${nft.tokenId}`,
                        description: 'Metadata unavailable',
                        image: generateFallbackImageForNft(nft.contractAddress, nft.tokenId),
                        imageUrl: generateFallbackImageForNft(nft.contractAddress, nft.tokenId),
                        error: error.message,
                        loaded: true,
                        loading: false
                    }
                };
            }
        });

        try {
            console.log('⏳ [CACHE BATCH] Waiting for all metadata requests to complete...');
            const results = await Promise.all(metadataPromises);
            
            // Update state with all loaded metadata at once
            const newMetadata = {};
            let successCount = 0;
            
            results.forEach(({ key, metadata }) => {
                if (metadata) {
                    newMetadata[key] = metadata;
                    if (metadata.loaded && !metadata.error) {
                        successCount++;
                    }
                }
            });
            
            console.log(`💾 [CACHE BATCH] Updating state with ${Object.keys(newMetadata).length} metadata entries`);
            setNftMetadata(prev => ({
                ...prev,
                ...newMetadata
            }));

            setStatus(`Loaded metadata for ${successCount}/${nfts.length} NFTs using edge cache`);
            console.log(`🎉 [CACHE BATCH] Successfully completed cache-first metadata loading: ${successCount}/${nfts.length} successful`);
            
        } catch (error) {
            console.error('❌ [CACHE BATCH] Batch metadata loading failed:', error);
            setStatus(`Error loading metadata: ${error.message}`);
        }
    };

    // Ultra-fast batch metadata loading using optimized loader
    const batchFetchMetadata = async (nfts) => {
        console.log('🚀 [BATCH FETCH] Starting batchFetchMetadata with', nfts.length, 'NFTs');
        console.log('📋 [BATCH FETCH] NFTs to process:', nfts);
        
        const nftsToFetch = nfts.filter(nft => {
            const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
            const metadata = nftMetadata[key];
            
            // NFT needs fetching if:
            // 1. No metadata exists at all
            // 2. Metadata exists but has no actual content (no image and no metadata)
            // 3. Metadata is currently loading
            const needsFetching = !metadata || 
                                 metadata.loading || 
                                 (!metadata.hasImage && !metadata.hasMetadata) ||
                                 (!metadata.imageUrl && !metadata.name);
            
            console.log(`🔍 [BATCH FETCH] NFT ${nft.contractAddress}:${nft.tokenId} - needs fetching: ${needsFetching}`, {
                hasMetadata: metadata?.hasMetadata,
                hasImage: metadata?.hasImage,
                loaded: metadata?.loaded,
                imageUrl: metadata?.imageUrl,
                name: metadata?.name
            });
            
            return needsFetching;
        });

        console.log(`🔍 [BATCH FETCH] Filtered to ${nftsToFetch.length} NFTs that need fetching`);

        if (nftsToFetch.length === 0) {
            console.log('✅ [BATCH FETCH] No NFTs need fetching, all already loaded');
            return;
        }

        setStatus(`Fast loading metadata for ${nftsToFetch.length} NFTs...`);
        console.log(`⚡ [BATCH FETCH] Starting metadata loading for ${nftsToFetch.length} NFTs...`);

        try {
            // Use the optimized batch loader for maximum speed on Vitruveo
            console.log('📡 [BATCH FETCH] Calling batchLoadMetadata from metadataLoader...');
            const nftsWithMetadata = await batchLoadMetadata(nftsToFetch, provider, 15); // Optimized for Vitruveo
            console.log(`✅ [BATCH FETCH] batchLoadMetadata returned ${nftsWithMetadata.length} results`);
            
            // Update state with all loaded metadata at once
            const newMetadata = {};
            nftsWithMetadata.forEach(nft => {
                const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                newMetadata[key] = nft.metadata;
                console.log(`📝 [BATCH FETCH] Processing metadata for ${key}:`, nft.metadata);
            });
            
            console.log(`💾 [BATCH FETCH] Updating state with ${Object.keys(newMetadata).length} metadata entries`);
            setNftMetadata(prev => ({
                ...prev,
                ...newMetadata
            }));

            setStatus(`Loaded metadata for ${nftsWithMetadata.length} NFTs`);
            console.log(`🎉 [BATCH FETCH] Successfully completed metadata loading for ${nftsWithMetadata.length} NFTs`);
        } catch (error) {
            console.error('❌ [BATCH FETCH] Batch metadata loading failed:', error);
            debugWarn('Batch metadata loading failed:', error);
            setStatus(`Error loading metadata: ${error.message}`);
        }
    };

    // Try to detect if contract is ERC721 or ERC1155
    const detectNftStandard = async (contractAddress) => {
        try {
            const erc721Contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
            await erc721Contract.balanceOf(wallet);
            return 'ERC721';
        } catch (e) {
            try {
                const erc1155Contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider);
                await erc1155Contract.balanceOf(wallet, 1);
                return 'ERC1155';
            } catch (e) {
                return null; // Not a standard NFT contract
            }
        }
    };

    // Fetch contract info (name/symbol) for all unique contract addresses from discovered NFTs
    const fetchContractInfoForNfts = async (nfts) => {
        const uniqueContracts = [...new Set(nfts.map(nft => nft.contractAddress))];
        setStatus(`Fetching collection info for ${uniqueContracts.length} contracts...`);
        const contractInfoPromises = uniqueContracts.map(async (contractAddress) => {
            if (contractInfo[contractAddress]) {
                return { contractAddress, info: contractInfo[contractAddress] };
            }
            try {
                const nftOfThisContract = nfts.find(nft => nft.contractAddress === contractAddress);
                const contractType = nftOfThisContract?.type || 'ERC721';
                const info = await getContractInfo(contractAddress, contractType);
                return { contractAddress, info };
            } catch (error) {
                const fallbackInfo = {
                    name: `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`,
                    symbol: ''
                };
                return { contractAddress, info: fallbackInfo };
            }
        });
        try {
            const results = await Promise.all(contractInfoPromises);
            const newContractInfo = {};
            results.forEach(({ contractAddress, info }) => {
                newContractInfo[contractAddress] = info;
            });
            setContractInfo(prev => ({
                ...prev,
                ...newContractInfo
            }));
        } catch (error) {
            criticalError("Error fetching contract info batch:", error);
        }
    };

    // Get contract name and symbol with better error handling
    const getContractInfo = async (contractAddress, contractType) => {
        if (contractInfo[contractAddress]) return contractInfo[contractAddress];

        try {
            const abi = contractType === 'ERC721' ? ERC721_ABI : ERC1155_ABI;
            const contract = new ethers.Contract(contractAddress, abi, provider);

            let name = '';
            let symbol = '';

            try {
                name = await contract.name();
            } catch { /* optional */ }

            try {
                symbol = await contract.symbol();
            } catch { /* optional */ }

            if (!name) {
                name = `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;
            }

            const info = { name, symbol };

            setContractInfo(prev => ({
                ...prev,
                [contractAddress]: info
            }));

            return info;
        } catch (e) {
            const fallbackName = `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;

            setContractInfo(prev => ({
                ...prev,
                [contractAddress]: { name: fallbackName, symbol: '' }
            }));

            return { name: fallbackName, symbol: '' };
        }
    };

    // Verify NFT ownership to ensure user still owns the NFT
    const verifyNFTOwnership = async (nft, userAddress) => {
        if (!provider || !userAddress || !nft.contractAddress || !nft.tokenId) {
            return false;
        }

        try {
            let isOwner = false;
            
            if (nft.type === 'ERC1155') {
                // For ERC1155, check balance
                const contract = new ethers.Contract(nft.contractAddress, ERC1155_ABI, provider);
                const balance = await contract.balanceOf(userAddress, nft.tokenId);
                isOwner = balance > 0;
            } else {
                // For ERC721, check owner
                const contract = new ethers.Contract(nft.contractAddress, ERC721_ABI, provider);
                try {
                    const owner = await contract.ownerOf(nft.tokenId);
                    isOwner = owner.toLowerCase() === userAddress.toLowerCase();
                } catch (ownerError) {
                    // Token might not exist or might be ERC1155
                    debugWarn(`Failed to get owner for ${nft.contractAddress}:${nft.tokenId}`, ownerError);
                    isOwner = false;
                }
            }

            return isOwner;
        } catch (error) {
            debugWarn(`Ownership verification failed for ${nft.contractAddress}:${nft.tokenId}`, error);
            return false;
        }
    };

    // Filter out NFTs that are no longer owned by the user
    const filterOwnedNFTs = async (nfts, userAddress) => {
        if (!nfts || nfts.length === 0 || !userAddress) {
            return [];
        }

        debugLog(`🔍 Verifying ownership of ${nfts.length} NFTs...`);
        
        // Verify ownership in batches for better performance
        const batchSize = 10;
        const ownedNFTs = [];
        
        for (let i = 0; i < nfts.length; i += batchSize) {
            const batch = nfts.slice(i, i + batchSize);
            const verificationPromises = batch.map(async (nft) => {
                const isOwned = await verifyNFTOwnership(nft, userAddress);
                return isOwned ? nft : null;
            });
            
            const batchResults = await Promise.all(verificationPromises);
            const ownedInBatch = batchResults.filter(nft => nft !== null);
            ownedNFTs.push(...ownedInBatch);
            
            // Progress update
            setStatus(`Verifying ownership ${Math.min(i + batchSize, nfts.length)}/${nfts.length}...`);
        }

        const removedCount = nfts.length - ownedNFTs.length;
        if (removedCount > 0) {
            debugLog(`🧹 Removed ${removedCount} NFTs that are no longer owned by user`);
        }

        return ownedNFTs;
    };

    // Load user NFTs with OPTIMIZED cache-first approach and smart scanning
    const scanningInProgress = useRef(false);
    const abortController = useRef(null);

    // Reset scanning state
    const resetScanningState = () => {
        scanningInProgress.current = false;
        if (abortController.current) {
            abortController.current.abort();
            abortController.current = null;
        }
    };

    // Force reset scanning state
    const forceResetScanningState = () => {
        resetScanningState();
        setIsLoading(false);
    };
    
    const findAllUserNfts = useCallback(async (forceRefresh = false, allowBackgroundUpdate = false, triggerSync = false) => {
        if (!wallet || !provider) return;

        // Prevent multiple simultaneous scans
        if (scanningInProgress.current && !forceRefresh) {
            debugLog("Scan already in progress, skipping...");
            return;
        }

        if (forceRefresh) {
            forceResetScanningState();
        }

        scanningInProgress.current = true;
        setIsLoading(true);

        // Create abort controller for this scan
        const currentAbortController = new AbortController();
        abortController.current = currentAbortController;

        try {
            // Track if we have an existing cached profile
            let hasExistingProfile = false;
            
            // OPTIMIZED: Always load cache first for instant display
            if (supabaseConnected && getCachedProfile && !forceRefresh) {
                setStatus("⚡ Loading collection from cache...");
                try {
                    const cachedProfile = await getCachedProfile(wallet);
                    if (cachedProfile && !currentAbortController.signal.aborted) {
                        // Profile exists, regardless of NFT count
                        hasExistingProfile = true;
                        
                        if (cachedProfile.nfts && cachedProfile.nfts.length > 0) {
                            // Verify ownership of cached NFTs to ensure they weren't sold
                            setStatus(`🔍 Verifying ownership of ${cachedProfile.nfts.length} cached NFTs...`);
                            const ownedCachedNfts = await filterOwnedNFTs(cachedProfile.nfts, wallet, provider, setStatus);
                            
                            const removedCount = cachedProfile.nfts.length - ownedCachedNfts.length;
                            if (removedCount > 0) {
                                debugLog(`🧹 Removed ${removedCount} sold NFTs from cached profile`);
                            }
                            
                            setUserNfts(ownedCachedNfts);
                            
                            // OPTIMIZED: Build metadata from owned cached NFTs efficiently
                            const metadata = {};
                            let metadataLoaded = 0;
                            
                            ownedCachedNfts.forEach(nft => {
                                const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                                
                                // Create metadata entry efficiently
                                const hasValidMetadata = !!(nft.metadata && Object.keys(nft.metadata).length > 0);
                                const hasValidImage = !!(nft.image || nft.metadata?.image);
                                
                                metadata[key] = {
                                    name: nft.name || nft.metadata?.name || `NFT #${nft.tokenId}`,
                                    imageUrl: nft.image || nft.metadata?.image || null,
                                    description: nft.metadata?.description || null,
                                    attributes: nft.metadata?.attributes || [],
                                    loaded: hasValidMetadata || hasValidImage, // Only mark as loaded if we have real content
                                    loading: false,
                                    hasMetadata: hasValidMetadata,
                                    hasImage: hasValidImage
                                };
                                
                                // Include all metadata if available
                                if (hasValidMetadata) {
                                    metadata[key] = { ...metadata[key], ...nft.metadata };
                                    metadataLoaded++;
                                }
                            });
                            
                            setNftMetadata(metadata);
                            
                            const totalNfts = ownedCachedNfts.length;
                            const successRate = totalNfts > 0 ? Math.round((metadataLoaded / totalNfts) * 100) : 0;
                            
                            setStatus(`✅ Loaded ${totalNfts} owned NFTs from cache${removedCount > 0 ? ` (${removedCount} removed)` : ''} (${successRate}% with metadata)`);
                            await fetchContractInfoForNfts(ownedCachedNfts);
                            
                            // OPTIMIZED: Start metadata fetching in background for missing metadata
                            const nftsNeedingMetadata = ownedCachedNfts.filter(nft => {
                                const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                                const meta = metadata[key];
                                return !meta?.hasMetadata || !meta?.hasImage || !meta?.loaded;
                            });
                            
                            if (nftsNeedingMetadata.length > 0 && !currentAbortController.signal.aborted) {
                                // Start background metadata loading
                                setTimeout(() => {
                                    if (!currentAbortController.signal.aborted) {
                                        setStatus(`🔄 Enhancing metadata for ${nftsNeedingMetadata.length} NFTs...`);
                                        batchLoadMetadata(nftsNeedingMetadata, provider, 15).then((nftsWithMetadata) => {
                                            if (!currentAbortController.signal.aborted) {
                                                // Update metadata state with loaded data
                                                const newMetadata = {};
                                                nftsWithMetadata.forEach(nft => {
                                                    const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                                                    newMetadata[key] = nft.metadata;
                                                });
                                                setNftMetadata(prev => ({ ...prev, ...newMetadata }));
                                                
                                                setStatus(`✅ Collection ready - ${totalNfts} NFTs with enhanced metadata`);
                                                setTimeout(() => setStatus(''), 3000);
                                            }
                                        }).catch(error => {
                                            if (!currentAbortController.signal.aborted) {
                                                setStatus(`❌ Metadata enhancement failed: ${error.message}`);
                                                setTimeout(() => setStatus(''), 3000);
                                            }
                                        });
                                    }
                                }, 500);
                            } else {
                                setStatus(`✅ Collection ready - ${totalNfts} NFTs with complete metadata`);
                                setTimeout(() => setStatus(''), 3000);
                            }
                        } else {
                            // Profile exists but has 0 NFTs
                            setUserNfts([]);
                            setStatus("✅ Profile found - no NFTs in collection");
                            setTimeout(() => setStatus(''), 3000);
                        }
                    } else {
                        setStatus("No profile found - will scan blockchain...");
                        setUserNfts([]);
                    }
                } catch (error) {
                    debugWarn("Cache load failed:", error);
                    setStatus("Cache unavailable - will scan blockchain");
                    setUserNfts([]);
                }
            }

            // OPTIMIZED: Smart sync strategy - only when needed or explicitly requested
            const shouldTriggerSync = triggerSync || 
                                     (userNfts.length === 0 && forceRefresh) ||
                                     (!hasExistingProfile && userNfts.length === 0);
            
            if (shouldTriggerSync && !currentAbortController.signal.aborted) {
                try {
                    debugLog(`Triggering smart collection sync - triggerSync: ${triggerSync}, forceRefresh: ${forceRefresh}, hasExistingProfile: ${hasExistingProfile}`);
                    await triggerCollectionSync(currentAbortController);
                } catch (syncError) {
                    console.warn('Collection sync failed, using cache only:', syncError);
                    if (userNfts.length === 0 && !currentAbortController.signal.aborted) {
                        setStatus("❌ Sync unavailable and no cached data - try force refresh");
                    }
                }
            }

        } catch (error) {
            if (!currentAbortController.signal.aborted) {
                setStatus(`Error loading NFTs: ${error.message}`);
            }
        } finally {
            if (!currentAbortController.signal.aborted) {
                setIsLoading(false);
            }
            resetScanningState();
        }
    }, [wallet, provider, supabaseConnected, getCachedProfile]);

    // OPTIMIZED: Smart backend collection sync with NFT Scanner fallback
    const triggerCollectionSync = async (currentAbortController = null) => {
        // Use provided controller or create a new one if none provided
        const abortSignal = currentAbortController?.signal || abortController.current?.signal;
        
        try {
            setStatus("🔄 Starting smart collection sync...");
            
            // First try the backend API
            try {
                const response = await fetch('/api/sync-user-collections', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ 
                        walletAddress: wallet,
                        immediate: true 
                    })
                });
                
                // Get response text first to handle both JSON and HTML responses
                const responseText = await response.text();
                
                if (response.ok) {
                    try {
                        const result = JSON.parse(responseText);
                        const nftCount = result.stats?.nfts || 0;
                        
                        if (nftCount > 0) {
                            setStatus(`✅ Backend sync completed - found ${nftCount} NFTs`);
                            // Reload from cache after sync
                            setTimeout(() => {
                                if (!abortSignal?.aborted) {
                                    findAllUserNfts(false, false, false);
                                }
                            }, 1000);
                            return; // Success, no need for fallback
                        } else {
                            debugLog("Backend sync returned 0 NFTs, trying smart local scan...");
                        }
                    } catch (jsonError) {
                        debugWarn('Backend API returned non-JSON response, trying smart local scan...');
                    }
                } else {
                    debugWarn('Backend API failed, trying smart local scan...');
                }
            } catch (apiError) {
                debugWarn('Backend API unavailable, using smart NFT scanner:', apiError.message);
            }
            
            // OPTIMIZED: Smart local NFT scanner - conservative by default for speed
            setStatus("🔍 Backend unavailable - using smart blockchain scanning...");
            debugLog("🔄 Using NFTScanner fallback with SMART approach for speed");
            debugLog("🌐 Smart scanning will check recent blockchain activity efficiently");
            
            if (!provider || !wallet) {
                throw new Error("Provider or wallet not available for scanning");
            }
            
            // Initialize NFT scanner with proper status updates
            const scanner = new NFTScanner(provider, wallet, (statusMsg) => {
                if (!abortSignal?.aborted) {
                    setStatus(statusMsg);
                }
            });
            
            // OPTIMIZED: Use SMART scanning by default (recent blocks only) for fast performance
            // Only use comprehensive scanning when explicitly force refreshing
            const useComprehensiveScan = false; // Smart scan by default
            const foundNfts = await scanner.scanAllNFTs(false, useComprehensiveScan);
            
            debugLog(`Smart scanner found ${foundNfts.length} NFTs`);
            
            // Cache results to Supabase if available for future visits
            if (supabaseConnected && cacheProfileData && foundNfts.length >= 0 && !abortSignal?.aborted) {
                try {
                    setStatus("💾 Caching scan results for faster future loads...");
                    await cacheProfileData(wallet, {
                        nfts: foundNfts,
                        lastScanBlock: await provider.getBlockNumber(),
                        scanType: useComprehensiveScan ? 'comprehensive_genesis' : 'smart_recent',
                        timestamp: Date.now()
                    });
                    debugLog("✅ Profile data cached to Supabase");
                } catch (cacheError) {
                    debugWarn("Failed to cache profile data:", cacheError);
                }
            }
            
            // Update local state with found NFTs - verify ownership first
            if (!abortSignal?.aborted) {
                if (foundNfts.length > 0) {
                    // Verify ownership of all NFTs to ensure they weren't sold
                    setStatus(`🔍 Verifying ownership of ${foundNfts.length} NFTs...`);
                    const ownedNfts = await filterOwnedNFTs(foundNfts, wallet, provider, setStatus);
                    
                    const removedCount = foundNfts.length - ownedNfts.length;
                    if (removedCount > 0) {
                        debugLog(`🧹 Filtered out ${removedCount} NFTs that are no longer owned`);
                    }
                    
                    setUserNfts(ownedNfts);
                    
                    const scanType = useComprehensiveScan ? 'comprehensive' : 'smart';
                    setStatus(`✅ ${scanType} scan complete - ${ownedNfts.length} owned NFTs${removedCount > 0 ? ` (${removedCount} removed)` : ''}`);
                    
                    // OPTIMIZED: Start metadata fetching in background
                    setTimeout(() => {
                        if (!abortSignal?.aborted) {
                            batchLoadMetadata(ownedNfts, provider, 15).then((nftsWithMetadata) => {
                                if (!abortSignal?.aborted) {
                                    // Update metadata state with loaded data
                                    const newMetadata = {};
                                    nftsWithMetadata.forEach(nft => {
                                        const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                                        newMetadata[key] = nft.metadata;
                                    });
                                    setNftMetadata(prev => ({ ...prev, ...newMetadata }));
                                }
                            }).catch(error => {
                                if (!abortSignal?.aborted) {
                                    debugWarn('Background metadata loading failed:', error);
                                }
                            });
                            fetchContractInfoForNfts(ownedNfts);
                        }
                    }, 100);
                } else {
                    setUserNfts(foundNfts);
                    setStatus(`✅ Smart scan complete - no NFTs found but profile created`);
                }
                
                // Clear status after delay
                setTimeout(() => {
                    if (!abortSignal?.aborted) {
                        setStatus('');
                    }
                }, 3000);
            }
            
        } catch (error) {
            if (!abortSignal?.aborted) {
                criticalError('Collection sync failed completely:', error);
                setStatus(`❌ Sync failed: ${error.message}`);
                setTimeout(() => {
                    if (!abortSignal?.aborted) {
                        setStatus('');
                    }
                }, 5000);
            }
        }
    };

    // Retry metadata loading for NFTs that don't have metadata
    const retryMissingMetadata = async () => {
        console.log('🔄 [METADATA RETRY] Button clicked - starting metadata retry...');
        
        if (!userNfts.length) {
            console.log('❌ [METADATA RETRY] No NFTs to retry metadata for');
            setStatus("No NFTs to retry metadata for");
            return;
        }

        // Find NFTs without metadata - improved filtering logic
        const nftsWithoutMetadata = userNfts.filter(nft => {
            const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
            const metadata = nftMetadata[key];
            
            // NFT needs metadata if:
            // 1. No metadata exists at all
            // 2. Metadata exists but has no actual content (no image and no metadata)
            // 3. Metadata is loading/failed
            const needsMetadata = !metadata || 
                                 metadata.loading || 
                                 metadata.error ||
                                 (!metadata.hasImage && !metadata.hasMetadata) ||
                                 (!metadata.imageUrl && !metadata.name);
            
            console.log(`🔍 [METADATA RETRY] NFT ${nft.contractAddress}:${nft.tokenId} - needs metadata: ${needsMetadata}`, {
                hasMetadata: metadata?.hasMetadata,
                hasImage: metadata?.hasImage,
                loaded: metadata?.loaded,
                loading: metadata?.loading,
                error: metadata?.error,
                imageUrl: metadata?.imageUrl,
                name: metadata?.name
            });
            
            return needsMetadata;
        });

        console.log(`🔍 [METADATA RETRY] Found ${nftsWithoutMetadata.length} NFTs needing metadata out of ${userNfts.length} total`);

        if (nftsWithoutMetadata.length === 0) {
            console.log('✅ [METADATA RETRY] All NFTs already have metadata loaded');
            setStatus("All NFTs already have metadata loaded");
            setTimeout(() => setStatus(''), 2000);
            return;
        }

        setStatus(`🔄 Retrying metadata for ${nftsWithoutMetadata.length} NFTs...`);
        console.log(`🚀 [METADATA RETRY] Starting retry for ${nftsWithoutMetadata.length} NFTs...`);

        // Trigger metadata fetch for NFTs without metadata
        const nftList = nftsWithoutMetadata.map(nft => ({
            contractAddress: nft.contractAddress,
            tokenId: nft.tokenId,
            tokenURI: nft.tokenURI,
            type: nft.type
        }));

        console.log('📋 [METADATA RETRY] NFT list prepared:', nftList);

        try {
            console.log('🔥 [METADATA RETRY] Pre-warming cache first...');
            await batchPrewarm(nftList);
            
            console.log('⚡ [METADATA RETRY] Calling batchFetchMetadataWithCache...');
            await batchFetchMetadataWithCache(nftList);
            console.log('✅ [METADATA RETRY] Edge cache retry completed successfully');
            setStatus(`✅ Metadata retry completed for ${nftsWithoutMetadata.length} NFTs using edge cache`);
            setTimeout(() => setStatus(''), 3000);
        } catch (error) {
            console.error('❌ [METADATA RETRY] Edge cache retry failed, trying legacy method:', error);
            
            // Fallback to legacy method
            try {
                console.log('🔄 [METADATA RETRY] Falling back to legacy batchFetchMetadata...');
                await batchFetchMetadata(nftList);
                console.log('✅ [METADATA RETRY] Legacy fallback completed successfully');
                setStatus(`✅ Metadata retry completed for ${nftsWithoutMetadata.length} NFTs (legacy method)`);
                setTimeout(() => setStatus(''), 3000);
            } catch (fallbackError) {
                console.error('❌ [METADATA RETRY] Legacy fallback also failed:', fallbackError);
                setStatus(`❌ Metadata retry failed: ${fallbackError.message}`);
                setTimeout(() => setStatus(''), 3000);
            }
        }
    };

    // OPTIMIZED: Real-time subscriptions with improved throttling and cleanup
    const lastSyncTime = useRef(0);
    const SYNC_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes between syncs

    useEffect(() => {
        if (supabaseConnected && subscribeToProfiles && wallet) {
            const profileSubscription = subscribeToProfiles((payload) => {
                if (payload.new?.wallet_address === wallet.toLowerCase()) {
                    const now = Date.now();
                    if (scanningInProgress.current || isLoading) {
                        return;
                    }
                    if (now - lastSyncTime.current > SYNC_THROTTLE_MS) {
                        lastSyncTime.current = now;
                        findAllUserNfts(false, false, false); // Just reload from cache
                    }
                }
            });

            return () => {
                if (profileSubscription && typeof profileSubscription.unsubscribe === 'function') {
                    profileSubscription.unsubscribe();
                }
            };
        }
    }, [supabaseConnected, wallet]); // Removed subscribeToProfiles to prevent recreating subscription

    // Toggle collection collapse state
    const toggleCollectionCollapse = (collectionAddress) => {
        setCollapsedCollections(prev => ({
            ...prev,
            [collectionAddress]: !prev[collectionAddress]
        }));
    };

    // Toggle NFT selection for bulk operations
    const toggleNftSelection = (nft) => {
        const nftKey = `${nft.contractAddress}-${nft.tokenId}`;
        setSelectedNfts(prev => {
            const newSelection = new Set(prev);
            if (newSelection.has(nftKey)) {
                newSelection.delete(nftKey);
            } else {
                newSelection.add(nftKey);
            }
            return newSelection;
        });
    };

    // Select all NFTs for bulk operations
    const selectAllNfts = () => {
        const allNftKeys = userNfts.map(nft => `${nft.contractAddress}-${nft.tokenId}`);
        setSelectedNfts(new Set(allNftKeys));
    };

    // Clear all selections
    const clearAllSelections = () => {
        setSelectedNfts(new Set());
    };

    // Check if contract supports burn function
    const checkBurnSupport = async (contractAddress, nftType) => {
        try {
            const contract = new ethers.Contract(
                contractAddress,
                nftType === 'ERC721' ? ERC721_ABI : ERC1155_ABI,
                provider
            );
            
            // Test if the contract actually supports burn by trying to estimate gas
            // This will fail if the function doesn't exist on the deployed contract
            if (nftType === 'ERC721') {
                // Try to estimate gas for burning token ID 1 (doesn't matter if it exists)
                // If burn function doesn't exist, this will throw
                try {
                    await contract.burn.staticCall(1);
                } catch (error) {
                    // If it's a revert due to token not existing or not owner, that's OK
                    // If it's a function not found error, burn is not supported
                    if (error.code === 'CALL_EXCEPTION' && error.message.includes('missing revert data')) {
                        return false;
                    }
                    // Other errors (like token doesn't exist) mean burn function exists
                    return true;
                }
                return true;
            } else {
                // For ERC1155, try with dummy parameters
                try {
                    await contract.burn.staticCall(wallet || ethers.ZeroAddress, 1, 1);
                } catch (error) {
                    if (error.code === 'CALL_EXCEPTION' && error.message.includes('missing revert data')) {
                        return false;
                    }
                    return true;
                }
                return true;
            }
        } catch (error) {
            debugWarn(`Error checking burn support for ${contractAddress}:`, error);
            return false;
        }
    };

    // Transfer single NFT
    const transferNft = async (nft, toAddress, quantity = null) => {
        if (!signer || !toAddress) return false;

        try {
            const contract = new ethers.Contract(
                nft.contractAddress,
                nft.type === 'ERC721' ? ERC721_ABI : ERC1155_ABI,
                signer
            );

            let tx;
            if (nft.type === 'ERC721') {
                // ERC721 transfer
                tx = await contract.safeTransferFrom(wallet, toAddress, nft.tokenId);
            } else {
                // ERC1155 transfer
                const amount = quantity || nft.balance || 1;
                tx = await contract.safeTransferFrom(
                    wallet, 
                    toAddress, 
                    nft.tokenId, 
                    amount, 
                    '0x'
                );
            }

            setStatus(`Transfer transaction submitted: ${tx.hash}`);
            await tx.wait();
            setStatus(`✅ NFT transferred successfully!`);
            
            // Refresh collection after transfer
            setTimeout(() => {
                findAllUserNfts(false, false, false);
                setStatus('');
            }, 2000);

            return true;
        } catch (error) {
            criticalError('Transfer failed:', error);
            setStatus(`❌ Transfer failed: ${error.message}`);
            setTimeout(() => setStatus(''), 5000);
            return false;
        }
    };

    // Burn single NFT
    const burnNft = async (nft, quantity = null) => {
        if (!signer) return false;

        try {
            // Check if burn is supported
            const burnSupported = await checkBurnSupport(nft.contractAddress, nft.type);
            if (!burnSupported) {
                setStatus(`❌ Burn not supported by this NFT contract`);
                setTimeout(() => setStatus(''), 5000);
                return false;
            }

            const contract = new ethers.Contract(
                nft.contractAddress,
                nft.type === 'ERC721' ? ERC721_ABI : ERC1155_ABI,
                signer
            );

            let tx;
            if (nft.type === 'ERC721') {
                // ERC721 burn
                tx = await contract.burn(nft.tokenId);
            } else {
                // ERC1155 burn
                const amount = quantity || nft.balance || 1;
                tx = await contract.burn(wallet, nft.tokenId, amount);
            }

            setStatus(`Burn transaction submitted: ${tx.hash}`);
            await tx.wait();
            setStatus(`🔥 NFT burned successfully!`);
            
            // Refresh collection after burn
            setTimeout(() => {
                findAllUserNfts(false, false, false);
                setStatus('');
            }, 2000);

            return true;
        } catch (error) {
            criticalError('Burn failed:', error);
            setStatus(`❌ Burn failed: ${error.message}`);
            setTimeout(() => setStatus(''), 5000);
            return false;
        }
    };

    // Bulk transfer selected NFTs
    const bulkTransferNfts = async () => {
        if (!signer || !transferToAddress || selectedNfts.size === 0) return;

        try {
            setIsTransferring(true);
            setStatus(`Starting bulk transfer of ${selectedNfts.size} NFTs...`);

            const selectedNftList = Array.from(selectedNfts).map(nftKey => {
                const [contractAddress, tokenId] = nftKey.split('-');
                return userNfts.find(nft => 
                    nft.contractAddress === contractAddress && 
                    nft.tokenId === tokenId
                );
            }).filter(Boolean);

            let successCount = 0;
            let failCount = 0;

            // Group by contract for batch operations where possible
            const nftsByContract = {};
            selectedNftList.forEach(nft => {
                if (!nftsByContract[nft.contractAddress]) {
                    nftsByContract[nft.contractAddress] = [];
                }
                nftsByContract[nft.contractAddress].push(nft);
            });

            for (const [contractAddress, nfts] of Object.entries(nftsByContract)) {
                const firstNft = nfts[0];
                
                if (firstNft.type === 'ERC1155' && nfts.length > 1) {
                    // Try batch transfer for ERC1155
                    try {
                        const contract = new ethers.Contract(contractAddress, ERC1155_ABI, signer);
                        
                        const ids = nfts.map(nft => nft.tokenId);
                        const amounts = nfts.map(nft => {
                            const key = `${nft.contractAddress}-${nft.tokenId}`;
                            return transferQuantities[key] || nft.balance || 1;
                        });

                        const tx = await contract.safeBatchTransferFrom(
                            wallet,
                            transferToAddress,
                            ids,
                            amounts,
                            '0x'
                        );

                        setStatus(`Batch transfer transaction submitted: ${tx.hash}`);
                        await tx.wait();
                        successCount += nfts.length;
                        setStatus(`✅ Batch transferred ${nfts.length} ERC1155 tokens from ${contractAddress}`);
                    } catch (batchError) {
                        debugWarn('Batch transfer failed, falling back to individual transfers:', batchError);
                        
                        // Fallback to individual transfers
                        for (const nft of nfts) {
                            const key = `${nft.contractAddress}-${nft.tokenId}`;
                            const quantity = transferQuantities[key];
                            const success = await transferNft(nft, transferToAddress, quantity);
                            if (success) successCount++;
                            else failCount++;
                        }
                    }
                } else {
                    // Individual transfers for ERC721 or single ERC1155
                    for (const nft of nfts) {
                        const key = `${nft.contractAddress}-${nft.tokenId}`;
                        const quantity = transferQuantities[key];
                        const success = await transferNft(nft, transferToAddress, quantity);
                        if (success) successCount++;
                        else failCount++;
                    }
                }
            }

            if (successCount > 0) {
                setStatus(`✅ Bulk transfer completed: ${successCount} successful${failCount > 0 ? `, ${failCount} failed` : ''}`);
                clearAllSelections();
                setShowTransferModal(false);
                setBulkMode(false);
                
                // Refresh collection
                setTimeout(() => {
                    findAllUserNfts(false, false, false);
                }, 2000);
            } else {
                setStatus(`❌ Bulk transfer failed: all ${failCount} transfers failed`);
            }

        } catch (error) {
            criticalError('Bulk transfer failed:', error);
            setStatus(`❌ Bulk transfer failed: ${error.message}`);
        } finally {
            setIsTransferring(false);
            setTimeout(() => setStatus(''), 5000);
        }
    };

    // Bulk burn selected NFTs
    const bulkBurnNfts = async () => {
        if (!signer || selectedNfts.size === 0) return;

        const confirmed = window.confirm(
            `Are you sure you want to burn ${selectedNfts.size} NFTs? This action cannot be undone!`
        );
        if (!confirmed) return;

        try {
            setStatus(`Starting bulk burn of ${selectedNfts.size} NFTs...`);

            const selectedNftList = Array.from(selectedNfts).map(nftKey => {
                const [contractAddress, tokenId] = nftKey.split('-');
                return userNfts.find(nft => 
                    nft.contractAddress === contractAddress && 
                    nft.tokenId === tokenId
                );
            }).filter(Boolean);

            let successCount = 0;
            let failCount = 0;
            let unsupportedCount = 0;

            // Group by contract for batch operations where possible
            const nftsByContract = {};
            selectedNftList.forEach(nft => {
                if (!nftsByContract[nft.contractAddress]) {
                    nftsByContract[nft.contractAddress] = [];
                }
                nftsByContract[nft.contractAddress].push(nft);
            });

            for (const [contractAddress, nfts] of Object.entries(nftsByContract)) {
                const firstNft = nfts[0];
                const burnSupported = await checkBurnSupport(contractAddress, firstNft.type);
                
                if (!burnSupported) {
                    unsupportedCount += nfts.length;
                    continue;
                }
                
                if (firstNft.type === 'ERC1155' && nfts.length > 1) {
                    // Try batch burn for ERC1155
                    try {
                        const contract = new ethers.Contract(contractAddress, ERC1155_ABI, signer);
                        
                        const ids = nfts.map(nft => nft.tokenId);
                        const amounts = nfts.map(nft => nft.balance || 1);

                        const tx = await contract.burnBatch(wallet, ids, amounts);
                        setStatus(`Batch burn transaction submitted: ${tx.hash}`);
                        await tx.wait();
                        successCount += nfts.length;
                    } catch (batchError) {
                        debugWarn('Batch burn failed, falling back to individual burns:', batchError);
                        
                        // Fallback to individual burns
                        for (const nft of nfts) {
                            const success = await burnNft(nft);
                            if (success) successCount++;
                            else failCount++;
                        }
                    }
                } else {
                    // Individual burns for ERC721 or single ERC1155
                    for (const nft of nfts) {
                        const success = await burnNft(nft);
                        if (success) successCount++;
                        else failCount++;
                    }
                }
            }

            let statusMsg = `🔥 Bulk burn completed: ${successCount} burned`;
            if (failCount > 0) statusMsg += `, ${failCount} failed`;
            if (unsupportedCount > 0) statusMsg += `, ${unsupportedCount} not supported`;
            
            setStatus(statusMsg);
            clearAllSelections();
            setBulkMode(false);
            
            // Refresh collection
            if (successCount > 0) {
                setTimeout(() => {
                    findAllUserNfts(false, false, false);
                }, 2000);
            }

        } catch (error) {
            criticalError('Bulk burn failed:', error);
            setStatus(`❌ Bulk burn failed: ${error.message}`);
        } finally {
            setTimeout(() => setStatus(''), 5000);
        }
    };

    // Function to sort NFTs based on the current sort option
    const sortNfts = (nfts) => {
        if (sortOption === 'default') return nfts;

        return [...nfts].sort((a, b) => {
            const keyA = `${a.contractAddress.toLowerCase()}-${a.tokenId}`;
            const keyB = `${b.contractAddress.toLowerCase()}-${b.tokenId}`;
            const metadataA = nftMetadata[keyA] || {};
            const metadataB = nftMetadata[keyB] || {};

            switch (sortOption) {
                case 'nameAsc':
                    return (metadataA.name || `NFT #${a.tokenId}`).localeCompare(metadataB.name || `NFT #${b.tokenId}`);
                case 'nameDesc':
                    return (metadataB.name || `NFT #${b.tokenId}`).localeCompare(metadataA.name || `NFT #${a.tokenId}`);
                case 'idAsc':
                    return parseInt(a.tokenId) - parseInt(b.tokenId);
                case 'idDesc':
                    return parseInt(b.tokenId) - parseInt(a.tokenId);
                case 'collectionAsc':
                    const colA = contractInfo[a.contractAddress]?.name || a.contractAddress;
                    const colB = contractInfo[b.contractAddress]?.name || b.contractAddress;
                    return colA.localeCompare(colB);
                default:
                    return 0;
            }
        });
    };

    // Filter and sort NFTs
    const processNfts = useCallback(() => {
        // Apply filters
        let filteredNfts = userNfts.filter(nft => {
            // Text search filter
            if (nftFilter) {
                const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                const metadata = nftMetadata[key] || {};
                const name = metadata.name || `NFT #${nft.tokenId}`;
                const contractData = contractInfo[nft.contractAddress] || {};
                const searchLower = nftFilter.toLowerCase();

                if (!(
                    name.toLowerCase().includes(searchLower) ||
                    nft.tokenId.toString().includes(searchLower) ||
                    nft.contractAddress.toLowerCase().includes(searchLower) ||
                    (contractData.name && contractData.name.toLowerCase().includes(searchLower)) ||
                    (contractData.symbol && contractData.symbol.toLowerCase().includes(searchLower))
                )) {
                    return false;
                }
            }

            // Listable filter - currently we can list all NFTs
            if (showOnlyListable) {
                return true;
            }

            return true;
        });

        // Apply sorting
        filteredNfts = sortNfts(filteredNfts);

        // Group by collection if needed
        if (groupByCollection) {
            // Group NFTs by collection
            const groupedByCollection = {};

            filteredNfts.forEach(nft => {
                const collectionKey = nft.contractAddress.toLowerCase();
                if (!groupedByCollection[collectionKey]) {
                    groupedByCollection[collectionKey] = {
                        contractAddress: nft.contractAddress,
                        name: contractInfo[nft.contractAddress]?.name || `Collection ${nft.contractAddress.slice(0, 6)}...`,
                        symbol: contractInfo[nft.contractAddress]?.symbol || '',
                        items: []
                    };
                }

                groupedByCollection[collectionKey].items.push(nft);
            });

            // Sort collections by size (most NFTs first)
            return Object.values(groupedByCollection)
                .sort((a, b) => b.items.length - a.items.length);
        }

        return filteredNfts;
    }, [userNfts, nftFilter, showOnlyListable, groupByCollection, nftMetadata, contractInfo, sortOption]);

    // Get filtered and processed NFTs
    const processedNfts = processNfts();

    // Note: Pagination removed - using lazy loading instead
    // LazyNftGrid component handles chunked loading automatically

    // Open the detailed NFT modal
    const openNftModal = (nft) => {
        setSelectedNft(nft);
        setShowNftModal(true);
    };

    // Close modal when clicking outside
    useEffect(() => {
        function handleClickOutside(event) {
            if (modalRef.current && !modalRef.current.contains(event.target)) {
                setShowNftModal(false);
                setShowStatsModal(false);
            }
        }

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [modalRef]);

    // OPTIMIZED: Cleanup scanning state when wallet changes or component unmounts
    useEffect(() => {
        return () => {
            resetScanningState();
        };
    }, [wallet]);

    // OPTIMIZED: Component unmount cleanup
    useEffect(() => {
        return () => {
            resetScanningState();
        };
    }, []);

    // If wallet not connected, show connection prompt
    if (!wallet) {
        return (
            <div className="profile-container">
                <div className="profile-not-connected">
                    <h2>Connect your wallet to view your profile</h2>
                    <button className="primary-button" onClick={connect}>
                        Connect Wallet
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="profile-container">
            <div className="profile-header">
                <div className="profile-info">
                    <h1>My NFT Profile</h1>
                    <div className="wallet-display">
                        <span className="label">Wallet:</span>
                        <span className="value">{`${wallet.slice(0, 8)}...${wallet.slice(-6)}`}</span>
                    </div>
                </div>
                <div className="profile-stats">
                    <div className="stats-card" onClick={() => setShowStatsModal(true)}>
                        <div className="stats-value">{userNfts.length}</div>
                        <div className="stats-label">Total NFTs</div>
                    </div>
                    <div className="stats-card" onClick={() => setShowStatsModal(true)}>
                        <div className="stats-value">{collectionStats.collections?.length || 0}</div>
                        <div className="stats-label">Collections</div>
                    </div>
                    <div className="stats-card" onClick={() => setShowStatsModal(true)}>
                        <div className="stats-value">{userListings.length}</div>
                        <div className="stats-label">Active Listings</div>
                    </div>
                </div>
            </div>

            <div className="profile-tabs">
                <button
                    className={activeTab === 'myListings' ? 'active' : ''}
                    onClick={() => setActiveTab('myListings')}
                >
                    My Listings
                </button>
                <button
                    className={activeTab === 'activity' ? 'active' : ''}
                    onClick={() => setActiveTab('activity')}
                >
                    Activity
                </button>
                <button
                    className={activeTab === 'collection' ? 'active' : ''}
                    onClick={() => setActiveTab('collection')}
                >
                    My Collection
                </button>
            </div>

            {status && <div className="status-message">{status}</div>}

            <div className="profile-content">
                {activeTab === 'myListings' && (
                    <div className="listings-container">
                        <div className="section-header">
                            <h2>Your Active Listings</h2>
                            <button
                                className="secondary-button refresh-button"
                                onClick={refreshListings}
                                disabled={isListingsLoading}
                            >
                                {isListingsLoading ? (
                                    <><span className="spinner"></span> Refreshing...</>
                                ) : (
                                    <>Refresh Listings</>
                                )}
                            </button>
                        </div>

                        {isListingsLoading ? (
                            <div className="loading-container">
                                <div className="loading-spinner"></div>
                                <p>Loading your listings...</p>
                            </div>
                        ) : userListings.length > 0 ? (
                            <div className="listings-grid">
                                {userListings.map(listing => (
                                    <div key={listing.id} className="listing-card-container">
                                        <ListingCard listing={listing} showSeller={false} />
                                        <button
                                            className="cancel-button danger-button"
                                            onClick={() => cancelListing(listing.id)}
                                            disabled={cancellingId === listing.id}
                                        >
                                            {cancellingId === listing.id ? (
                                                <><span className="spinner"></span> Cancelling...</>
                                            ) : (
                                                <>Cancel Listing</>
                                            )}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="empty-state">
                                <div className="empty-icon">📋</div>
                                <h3>No Active Listings</h3>
                                <p>You don't have any active listings</p>
                                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                    <button
                                        className="primary-button"
                                        onClick={() => window.location.href = '/sell'}
                                    >
                                        Create a Listing
                                    </button>
                                    <button
                                        className="secondary-button"
                                        onClick={() => navigate('/auctions/create')}
                                    >
                                        Create Auction
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'activity' && (
                    <div className="activity-container">
                        <div className="section-header">
                            <h2>Recent Activity</h2>
                            <div className="header-actions" style={{ display: 'flex', gap: 8 }}>
                                <select
                                    className="input sort-select"
                                    value={activityFilter}
                                    onChange={(e) => setActivityFilter(e.target.value)}
                                    title="Filter activity"
                                >
                                    <option value="all">All activity</option>
                                    <option value="listings">Listings</option>
                                    <option value="sales">Sales</option>
                                    <option value="purchases">Purchases</option>
                                    {isAuctionsEnabled() && <option value="auctions">Auctions</option>}
                                </select>
                                {isAuctionsEnabled() && (
                                    <span className="small" style={{ opacity: .75 }}>
                                        {isAuctionsLoading ? 'Loading auctions…' : `${userAuctions.length} auctions`}
                                    </span>
                                )}
                            </div>
                        </div>

                        {activities.length > 0 ? (
                            <ul className="activity-timeline">
                                {activities.slice(0, 100).map((ev, idx) => {
                                    // Format timestamp with fallback handling
                                    const formatTimestamp = (ts) => {
                                        if (!ts || !Number.isFinite(ts) || ts <= 0) {
                                            return 'recently';
                                        }
                                        
                                        const timeAgoStr = timeAgo(ts);
                                        const date = new Date(ts);
                                        
                                        // For recent items (< 1 day), show time ago
                                        if (Date.now() - ts < 24 * 60 * 60 * 1000) {
                                            return `${timeAgoStr} ago`;
                                        }
                                        
                                        // For older items, show formatted date
                                        const isCurrentYear = date.getFullYear() === new Date().getFullYear();
                                        const dateFormat = isCurrentYear 
                                            ? { month: 'short', day: 'numeric' }
                                            : { month: 'short', day: 'numeric', year: 'numeric' };
                                            
                                        try {
                                            return date.toLocaleDateString(undefined, dateFormat);
                                        } catch (e) {
                                            return timeAgoStr ? `${timeAgoStr} ago` : 'recently';
                                        }
                                    };
                                    
                                    return (
                                    <li key={ev.refId ? `${ev.type}-${ev.refId}-${idx}` : `${ev.type}-${idx}`} className={`activity-item type-${ev.type}`}>
                                        <div className="activity-icon">
                                            {ev.type === 'listing' && '📤'}
                                            {ev.type === 'sale' && '✅'}
                                            {ev.type === 'purchase' && '🛒'}
                                            {ev.type === 'cancel' && '🗑️'}
                                            {(ev.type === 'auction' || ev.type === 'auction_end') && '🏷️'}
                                        </div>
                                        <div className="activity-content">
                                            <div className="activity-header">
                                                <strong>{ev.label}</strong>
                                                <span className="muted" title={ev.ts ? new Date(ev.ts).toLocaleString() : 'Recently'}>
                                                    · {formatTimestamp(ev.ts)}
                                                </span>
                                            </div>
                                            <div className="activity-detail">{ev.detail}</div>
                                            <div className="activity-actions">
                                                {ev.meta?.listing && (
                                                    <button
                                                        className="tertiary-button small-button"
                                                        onClick={() => window.location.href = `/collections/${ev.meta.listing.nftContract.toLowerCase()}`}
                                                    >
                                                        View Collection
                                                    </button>
                                                )}
                                                {ev.type === 'auction' && ev.meta?.id && (
                                                    <button
                                                        className="tertiary-button small-button"
                                                        onClick={() => window.location.href = `/auctions/${ev.meta.id}`}
                                                    >
                                                        View Auction
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <div className="empty-state">
                                <div className="empty-icon">📊</div>
                                <h3>No Recent Activity</h3>
                                <p>Your listings, sales, purchases, and auctions will appear here.</p>
                                {isAuctionsEnabled() && <p className="small">Tip: Create an auction to see it in your activity.</p>}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'collection' && (
                    <div className="collection-container">
                        <div className="section-header">
                            <h2>Your NFT Collection</h2>
                            <div className="header-actions">
                                <div className="search-container">
                                    <input
                                        type="text"
                                        placeholder="Search NFTs..."
                                        value={nftFilter}
                                        onChange={(e) => setNftFilter(e.target.value)}
                                        className="input search-input"
                                    />
                                    <button
                                        className={`view-toggle-button ${isAdvancedSearch ? 'active' : ''}`}
                                        onClick={() => setIsAdvancedSearch(!isAdvancedSearch)}
                                        title="Toggle advanced search options"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                            <path fill="currentColor" d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
                                        </svg>
                                    </button>
                                    <div className="view-toggle">
                                        <button
                                            className={`view-toggle-button ${currentView === 'grid' ? 'active' : ''}`}
                                            onClick={() => setCurrentView('grid')}
                                            title="Grid view"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                <path fill="currentColor" d="M3 3h8v8H3V3zm0 10h8v8H3v-8zM13 3h8v8h-8V3zm0 10h8v8h-8v-8z" />
                                            </svg>
                                        </button>
                                        <button
                                            className={`view-toggle-button ${currentView === 'list' ? 'active' : ''}`}
                                            onClick={() => setCurrentView('list')}
                                            title="List view"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                <path fill="currentColor" d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                                <div className="action-buttons">
                                    <button
                                        className={`secondary-button action-button ${bulkMode ? 'active' : ''}`}
                                        onClick={() => {
                                            setBulkMode(!bulkMode);
                                            if (bulkMode) {
                                                clearAllSelections();
                                            }
                                        }}
                                        disabled={isLoading || userNfts.length === 0}
                                        title="Toggle bulk operations mode"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                            <path fill="currentColor" d="M3 5h2V3c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2v2h2c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2zM7 3v2h10V3H7zm12 14V7H5v10h14z"/>
                                        </svg>
                                        {bulkMode ? 'Exit Bulk Mode' : 'Bulk Operations'}
                                    </button>
                                    
                                    {bulkMode && (
                                        <>
                                            <button
                                                className="tertiary-button action-button"
                                                onClick={selectAllNfts}
                                                disabled={userNfts.length === 0}
                                                title="Select all NFTs"
                                            >
                                                Select All ({userNfts.length})
                                            </button>
                                            <button
                                                className="tertiary-button action-button"
                                                onClick={clearAllSelections}
                                                disabled={selectedNfts.size === 0}
                                                title="Clear all selections"
                                            >
                                                Clear ({selectedNfts.size})
                                            </button>
                                            <button
                                                className="primary-button action-button"
                                                onClick={() => setShowTransferModal(true)}
                                                disabled={selectedNfts.size === 0}
                                                title="Transfer selected NFTs"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                    <path fill="currentColor" d="M14,12L10,8V11H2V13H10V16M20,12L16,8V11H12V13H16V16"/>
                                                </svg>
                                                Transfer ({selectedNfts.size})
                                            </button>
                                            <button
                                                className="danger-button action-button"
                                                onClick={bulkBurnNfts}
                                                disabled={selectedNfts.size === 0}
                                                title="Burn selected NFTs (irreversible)"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                    <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
                                                </svg>
                                                Burn ({selectedNfts.size})
                                            </button>
                                        </>
                                    )}
                                    
                                    <button
                                        className="primary-button action-button"
                                        onClick={() => findAllUserNfts(false, true, false)}
                                        disabled={isLoading}
                                    >
                                        {isLoading ? (
                                            <>
                                                <span className="spinner"></span>
                                                Loading...
                                            </>
                                        ) : (
                                            <>
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                    <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
                                                </svg>
                                                Refresh Collection
                                            </>
                                        )}
                                    </button>
                                    <button
                                        className="secondary-button action-button"
                                        onClick={() => findAllUserNfts(false, false, true)}
                                        disabled={isLoading}
                                        title="Trigger blockchain scan to find new NFTs (requires backend service)"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                            <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
                                        </svg>
                                        Sync Data
                                    </button>
                                    <button
                                        className="secondary-button action-button retry-metadata-button"
                                        onClick={() => retryMissingMetadata()}
                                        disabled={isLoading || userNfts.length === 0}
                                        title="Retry loading metadata for NFTs without images or descriptions"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                            <path fill="currentColor" d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z" />
                                        </svg>
                                        Retry Metadata
                                    </button>
                                    <button
                                        className="tertiary-button action-button cache-monitor-button"
                                        onClick={() => setShowCacheMonitor(!showCacheMonitor)}
                                        title="Toggle edge cache performance monitor"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                            <path fill="currentColor" d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm2 4v-2H3c0 1.1.89 2 2 2zM3 9h2V7H3v2zm12 12h2v-2h-2v2zm4-18H9c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 12H9V5h10v10zm-8-2h2v-2h-2v2zm0-4h2V9h-2v2z"/>
                                        </svg>
                                        {showCacheMonitor ? 'Hide' : 'Show'} Cache Monitor
                                    </button>
                                    <button
                                        className="tertiary-button action-button force-refresh-button"
                                        onClick={async () => {
                                            if (isLoading) return;
                                            
                                            try {
                                                setStatus("🔄 Force comprehensive refresh - scanning entire blockchain history...");
                                                
                                                // OPTIMIZED: Force comprehensive scanning from genesis for maximum coverage
                                                const scanner = new NFTScanner(provider, wallet, setStatus);
                                                const nfts = await scanner.scanAllNFTs(false, true); // Force comprehensive scan
                                                
                                                setUserNfts(nfts);
                                                if (nfts.length > 0) {
                                                    // Start metadata loading in background
                                                    setTimeout(() => {
                                                        batchFetchMetadata(nfts);
                                                        fetchContractInfoForNfts(nfts);
                                                    }, 100);
                                                }
                                                
                                                // Cache the results
                                                if (supabaseConnected && cacheProfileData) {
                                                    try {
                                                        await cacheProfileData(wallet, {
                                                            nfts,
                                                            lastScanBlock: await provider.getBlockNumber(),
                                                            scanType: 'force_comprehensive_genesis',
                                                            timestamp: Date.now()
                                                        });
                                                    } catch (cacheError) {
                                                        debugWarn("Failed to cache force refresh results:", cacheError);
                                                    }
                                                }
                                                
                                                setStatus(`✅ Force refresh complete - found ${nfts.length} NFTs`);
                                                setTimeout(() => setStatus(''), 3000);
                                            } catch (error) {
                                                criticalError('Force refresh failed:', error);
                                                setStatus('❌ Force refresh failed - try regular refresh');
                                                setTimeout(() => setStatus(''), 5000);
                                            }
                                        }}
                                        disabled={isLoading}
                                        title="Force comprehensive refresh - scans entire blockchain history from genesis (block 0)"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                            <path fill="currentColor" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                                        </svg>
                                        Force Refresh
                                    </button>
                                </div>
                            </div>
                        </div>

                        {isAdvancedSearch && (
                            <div className="advanced-search">
                                <div className="filter-options">
                                    <div className="filter-group">
                                        <label className="checkbox-label">
                                            <input
                                                type="checkbox"
                                                checked={showOnlyListable}
                                                onChange={() => setShowOnlyListable(!showOnlyListable)}
                                            />
                                            <span>Show only listable NFTs</span>
                                        </label>
                                        <label className="checkbox-label">
                                            <input
                                                type="checkbox"
                                                checked={groupByCollection}
                                                onChange={() => setGroupByCollection(!groupByCollection)}
                                            />
                                            <span>Group by collection</span>
                                        </label>
                                    </div>
                                    <div className="filter-group">
                                        <label htmlFor="sort-select">Sort by:</label>
                                        <select
                                            id="sort-select"
                                            value={sortOption}
                                            onChange={(e) => setSortOption(e.target.value)}
                                            className="input sort-select"
                                        >
                                            <option value="default">Default</option>
                                            <option value="nameAsc">Name (A-Z)</option>
                                            <option value="nameDesc">Name (Z-A)</option>
                                            <option value="idAsc">Token ID (Low-High)</option>
                                            <option value="idDesc">Token ID (High-Low)</option>
                                            <option value="collectionAsc">Collection</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        )}

                        {isLoading ? (
                            <div className="loading-container">
                                <div className="loading-spinner"></div>
                                <p>Loading your NFT collection...</p>
                            </div>
                        ) : groupByCollection ? (
                            // Grouped by collection view
                            <div className="collections-view">
                                {processedNfts.length > 0 ? (
                                    processedNfts.map((collection) => {
                                        const isCollapsed = collapsedCollections[collection.contractAddress] || false;

                                        return (
                                            <div key={collection.contractAddress} className="collection-group card">
                                                <div
                                                    className="collection-header"
                                                    onClick={() => toggleCollectionCollapse(collection.contractAddress)}
                                                >
                                                    <div className="collection-header-left">
                                                        <span className={`collapse-icon ${isCollapsed ? 'collapsed' : ''}`}>
                                                            {isCollapsed ? '▸' : '▾'}
                                                        </span>
                                                        <h3>
                                                            {collection.name}
                                                            {collection.symbol ? ` (${collection.symbol})` : ''}
                                                        </h3>
                                                    </div>
                                                    <span className="collection-count">{collection.items.length} NFTs</span>
                                                </div>

                                                {!isCollapsed && (
                                                    <LazyNftGrid
                                                        nfts={collection.items}
                                                        onNftClick={openNftModal}
                                                        currentView={currentView}
                                                        contractInfo={contractInfo}
                                                        batchSize={24}
                                                        preloadBatches={1}
                                                        enableInfiniteScroll={true}
                                                    />
                                                )}
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div className="empty-state card">
                                        <div className="empty-icon">🔍</div>
                                        <h3>No NFTs Found</h3>
                                        {nftFilter ? (
                                            <p>No NFTs found matching "{nftFilter}"</p>
                                        ) : (
                                            <>
                                                <p>No NFTs found in your wallet</p>
                                                <p className="small">Try scanning for NFTs in your wallet</p>
                                            </>
                                        )}
                                        <button
                                            className="primary-button"
                                            onClick={() => findAllUserNfts(true, false, true)}
                                            disabled={isLoading}
                                            title="Scan blockchain for NFTs in your wallet"
                                        >
                                            {isLoading ? 'Scanning...' : 'Scan for NFTs'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : (
                            // Regular view with lazy loading
                            <div className="ungrouped-view card">
                                {processedNfts.length > 0 ? (
                                    <>
                                        <div className="collection-stats-bar">
                                            {nftFilter ? (
                                                <p>Found {processedNfts.length} of {userNfts.length} NFTs matching "{nftFilter}"</p>
                                            ) : (
                                                <p>Your NFT Collection ({processedNfts.length} NFTs)</p>
                                            )}
                                        </div>
                                        
                                        <LazyNftGrid
                                            nfts={processedNfts}
                                            onNftClick={openNftModal}
                                            currentView={currentView}
                                            contractInfo={contractInfo}
                                            batchSize={24}
                                            preloadBatches={2}
                                            enableInfiniteScroll={true}
                                        />
                                    </>
                                ) : (
                                    <div className="empty-state">
                                        <div className="empty-icon">🔍</div>
                                        <h3>No NFTs Found</h3>
                                        {nftFilter ? (
                                            <p>No NFTs found matching "{nftFilter}"</p>
                                        ) : (
                                            <>
                                                <p>No NFTs found in your wallet</p>
                                                <p className="small">Try scanning for NFTs in your wallet</p>
                                            </>
                                        )}
                                        <button
                                            className="primary-button"
                                            onClick={() => findAllUserNfts(true, false, true)}
                                            disabled={isLoading}
                                            title="Scan blockchain for NFTs in your wallet"
                                        >
                                            {isLoading ? 'Scanning...' : 'Scan for NFTs'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Edge Cache Performance Monitor */}
            <EdgeCacheMonitor isVisible={showCacheMonitor} />

            {/* Transfer Modal */}
            {showTransferModal && (
                <div className="modal-overlay">
                    <div className="transfer-modal card" ref={modalRef}>
                        <button className="modal-close" onClick={() => setShowTransferModal(false)}>×</button>
                        <div className="transfer-modal-header">
                            <h2>Transfer NFTs</h2>
                            <p>Transfer {selectedNfts.size} selected NFTs to another address</p>
                        </div>
                        <div className="transfer-modal-content">
                            <div className="transfer-form">
                                <div className="form-group">
                                    <label htmlFor="transfer-address">Recipient Address:</label>
                                    <input
                                        id="transfer-address"
                                        type="text"
                                        placeholder="0x..."
                                        value={transferToAddress}
                                        onChange={(e) => setTransferToAddress(e.target.value)}
                                        className="input"
                                    />
                                </div>
                                
                                <div className="selected-nfts-list">
                                    <h3>Selected NFTs:</h3>
                                    {Array.from(selectedNfts).map(nftKey => {
                                        const [contractAddress, tokenId] = nftKey.split('-');
                                        const nft = userNfts.find(n => 
                                            n.contractAddress === contractAddress && 
                                            n.tokenId === tokenId
                                        );
                                        if (!nft) return null;
                                        
                                        const metadata = nftMetadata[nftKey] || {};
                                        const name = metadata.name || `NFT #${nft.tokenId}`;
                                        
                                        return (
                                            <div key={nftKey} className="selected-nft-item">
                                                <div className="nft-info">
                                                    <span className="nft-name">{name}</span>
                                                    <span className="nft-collection">
                                                        {contractInfo[nft.contractAddress]?.name || 'Unknown'}
                                                    </span>
                                                </div>
                                                {nft.type === 'ERC1155' && nft.balance > 1 && (
                                                    <div className="quantity-input">
                                                        <label>Quantity:</label>
                                                        <input
                                                            type="number"
                                                            min="1"
                                                            max={nft.balance}
                                                            value={transferQuantities[nftKey] || nft.balance}
                                                            onChange={(e) => setTransferQuantities(prev => ({
                                                                ...prev,
                                                                [nftKey]: parseInt(e.target.value) || 1
                                                            }))}
                                                            className="input quantity-input"
                                                        />
                                                        <span className="max-available">/ {nft.balance}</span>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                                
                                <div className="transfer-actions">
                                    <button
                                        className="secondary-button"
                                        onClick={() => setShowTransferModal(false)}
                                        disabled={isTransferring}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        className="primary-button"
                                        onClick={bulkTransferNfts}
                                        disabled={!transferToAddress || isTransferring || selectedNfts.size === 0}
                                    >
                                        {isTransferring ? (
                                            <>
                                                <span className="spinner"></span>
                                                Transferring...
                                            </>
                                        ) : (
                                            `Transfer ${selectedNfts.size} NFTs`
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* NFT Detail Modal */}
            {showNftModal && selectedNft && (
                <div className="modal-overlay">
                    <div className="nft-modal card" ref={modalRef}>
                        <button className="modal-close" onClick={() => setShowNftModal(false)}>×</button>
                        <NftDetailView 
                            nft={selectedNft} 
                            metadata={nftMetadata[`${selectedNft.contractAddress.toLowerCase()}-${selectedNft.tokenId}`]} 
                            contractInfo={contractInfo[selectedNft.contractAddress]}
                            transferNft={transferNft}
                            burnNft={burnNft}
                        />
                    </div>
                </div>
            )}

            {/* Collection Stats Modal */}
            {showStatsModal && (
                <div className="modal-overlay">
                    <div className="stats-modal card" ref={modalRef}>
                        <button className="modal-close" onClick={() => setShowStatsModal(false)}>×</button>
                        <div className="stats-modal-header">
                            <h2>Collection Statistics</h2>
                        </div>
                        <div className="stats-modal-content">
                            <div className="stats-summary">
                                <div className="stat-box">
                                    <div className="stat-value">{userNfts.length}</div>
                                    <div className="stat-label">Total NFTs</div>
                                </div>
                                <div className="stat-box">
                                    <div className="stat-value">{collectionStats.totalQuantity || userNfts.length}</div>
                                    <div className="stat-label">Total Quantity</div>
                                </div>
                                <div className="stat-box">
                                    <div className="stat-value">{collectionStats.collections?.length || 0}</div>
                                    <div className="stat-label">Collections</div>
                                </div>
                                <div className="stat-box">
                                    <div className="stat-value">{collectionStats.types?.ERC721 || 0}</div>
                                    <div className="stat-label">ERC721 Tokens</div>
                                </div>
                                <div className="stat-box">
                                    <div className="stat-value">{collectionStats.types?.ERC1155 || 0}</div>
                                    <div className="stat-label">ERC1155 Tokens</div>
                                </div>
                            </div>

                            <div className="collections-list">
                                <h3>Your Collections</h3>
                                <table className="collections-table">
                                    <thead>
                                        <tr>
                                            <th>Collection</th>
                                            <th>Symbol</th>
                                            <th>NFTs</th>
                                            <th>Type</th>
                                            <th>Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {collectionStats.collections?.map((col) => (
                                            <tr key={col.address}>
                                                <td>{col.name || 'Unknown'}</td>
                                                <td>{col.symbol || '-'}</td>
                                                <td>{col.count}</td>
                                                <td>{col.type}</td>
                                                <td>
                                                    <button
                                                        className="secondary-button small-button"
                                                        onClick={() => {
                                                            setNftFilter(col.name);
                                                            setShowStatsModal(false);
                                                            setActiveTab('collection');
                                                        }}
                                                    >
                                                        View
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );

    // Helper function to render NFT cards with appropriate layout
    function renderNftCard(nft) {
        const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
        const metadata = nftMetadata[key] || {};
        const isLoading = metadata.loading;
        const error = metadata.error;
        const fallbackImg = generateFallbackImageForNft(nft.contractAddress, nft.tokenId);
        const imageUrl = metadata.imageUrl || fallbackImg;
        const name = metadata.name || `NFT #${nft.tokenId}`;
        const collectionInfo = contractInfo[nft.contractAddress] || {};
        const isSelected = selectedNfts.has(key);

        if (currentView === 'grid') {
            return (
                <div key={key} className={`nft-card ${isSelected ? 'selected' : ''}`}>
                    {bulkMode && (
                        <div className="nft-card-selection">
                            <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleNftSelection(nft)}
                                className="nft-checkbox"
                            />
                        </div>
                    )}
                    <div className="nft-card-inner" onClick={() => bulkMode ? toggleNftSelection(nft) : openNftModal(nft)}>
                        <div className="nft-image">
                            {isLoading ? (
                                <div className="loading-image">
                                    <div className="loading-spinner small"></div>
                                </div>
                            ) : error ? (
                                <div className="error-image">
                                    <span>❌</span>
                                    <img
                                        src={fallbackImg}
                                        alt={name}
                                        className="fallback"
                                    />
                                </div>
                            ) : (
                                <img
                                    src={imageUrl}
                                    alt={name}
                                    onError={(e) => {
                                        // Comprehensive error handling for image loading
                                        e.target.onerror = null;
                                        const fallbackSrc = generateFallbackImageForNft(nft.contractAddress, nft.tokenId);
                                        if (e.target.src !== fallbackSrc) {
                                            e.target.src = fallbackSrc;
                                            e.target.classList.add('fallback');
                                        }
                                    }}
                                    onLoad={(e) => {
                                        // Additional safety check for problematic images
                                        if (e.target.naturalWidth === 0 || e.target.naturalHeight === 0) {
                                            e.target.onerror(e);
                                        }
                                    }}
                                />
                            )}
                        </div>
                        <div className="nft-details">
                            <h3 title={name}>{name}</h3>
                            <p className="collection-name" title={collectionInfo.name || 'Unknown Collection'}>
                                {collectionInfo.name || 'Unknown Collection'}
                                {collectionInfo.symbol ? ` (${collectionInfo.symbol})` : ''}
                            </p>
                            <div className="nft-footer">
                                <div className="nft-type-badge">{nft.type}</div>
                                {nft.type === 'ERC1155' && nft.balance > 1 && (
                                    <div className="nft-quantity">×{nft.balance}</div>
                                )}
                            </div>
                        </div>
                        {!bulkMode && (
                            <div className="nft-actions">
                                <button
                                    className="primary-button full-width"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`;
                                    }}
                                >
                                    List for Sale
                                </button>
                                <button
                                    className="secondary-button full-width"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        navigate(`/auctions/create?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`);
                                    }}
                                    style={{ marginTop: '0.5rem' }}
                                >
                                    Create Auction
                                </button>
                                <div className="nft-quick-actions" style={{ marginTop: '0.5rem', display: 'flex', gap: '0.25rem' }}>
                                    <button
                                        className="tertiary-button small-button"
                                        onClick={async (e) => {
                                            e.stopPropagation();
                                            const toAddress = prompt('Transfer to address:');
                                            if (toAddress) {
                                                await transferNft(nft, toAddress);
                                            }
                                        }}
                                        title="Transfer this NFT"
                                    >
                                        Transfer
                                    </button>
                                    <button
                                        className="danger-button small-button"
                                        onClick={async (e) => {
                                            e.stopPropagation();
                                            const confirmed = window.confirm('Are you sure you want to burn this NFT? This action cannot be undone!');
                                            if (confirmed) {
                                                await burnNft(nft);
                                            }
                                        }}
                                        title="Burn this NFT (irreversible)"
                                    >
                                        Burn
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            );
        } else {
            // List view
            return (
                <div key={key} className={`nft-list-item ${isSelected ? 'selected' : ''}`}>
                    {bulkMode && (
                        <div className="nft-list-selection">
                            <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleNftSelection(nft)}
                                className="nft-checkbox"
                            />
                        </div>
                    )}
                    <div className="nft-list-image" onClick={() => bulkMode ? toggleNftSelection(nft) : openNftModal(nft)}>
                        {isLoading ? (
                            <div className="loading-image">
                                <div className="loading-spinner small"></div>
                            </div>
                        ) : error ? (
                            <div className="error-image">
                                <span>❌</span>
                                <img
                                    src={fallbackImg}
                                    alt={name}
                                    className="fallback"
                                />
                            </div>
                        ) : (
                            <img
                                src={imageUrl}
                                alt={name}
                                onError={(e) => {
                                    // Comprehensive error handling for image loading
                                    e.target.onerror = null;
                                    const fallbackSrc = generateFallbackImageForNft(nft.contractAddress, nft.tokenId);
                                    if (e.target.src !== fallbackSrc) {
                                        e.target.src = fallbackSrc;
                                        e.target.classList.add('fallback');
                                    }
                                }}
                                onLoad={(e) => {
                                    // Additional safety check for problematic images
                                    if (e.target.naturalWidth === 0 || e.target.naturalHeight === 0) {
                                        e.target.onerror(e);
                                    }
                                }}
                            />
                        )}
                    </div>
                    <div className="nft-list-details" onClick={() => bulkMode ? toggleNftSelection(nft) : openNftModal(nft)}>
                        <h3>{name}</h3>
                        <p className="collection-name">
                            {collectionInfo.name || 'Unknown Collection'}
                            {collectionInfo.symbol ? ` (${collectionInfo.symbol})` : ''}
                        </p>
                        <div className="nft-list-meta">
                            <span className="nft-type-badge">{nft.type}</span>
                            {nft.type === 'ERC1155' && nft.balance > 1 && (
                                <span className="nft-quantity">Quantity: {nft.balance}</span>
                            )}
                            <span className="token-id">ID: {nft.tokenId}</span>
                        </div>
                    </div>
                    {!bulkMode && (
                        <div className="nft-list-actions">
                            <button
                                className="primary-button"
                                onClick={() => window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`}
                            >
                                List for Sale
                            </button>
                            <button
                                className="secondary-button"
                                onClick={() => navigate(`/auctions/create?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`)}
                            >
                                Create Auction
                            </button>
                            <button
                                className="secondary-button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    openNftModal(nft);
                                }}
                            >
                                View Details
                            </button>
                            <button
                                className="tertiary-button"
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    const toAddress = prompt('Transfer to address:');
                                    if (toAddress) {
                                        await transferNft(nft, toAddress);
                                    }
                                }}
                                title="Transfer this NFT"
                            >
                                Transfer
                            </button>
                            <button
                                className="danger-button"
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    const confirmed = window.confirm('Are you sure you want to burn this NFT? This action cannot be undone!');
                                    if (confirmed) {
                                        await burnNft(nft);
                                    }
                                }}
                                title="Burn this NFT (irreversible)"
                            >
                                Burn
                            </button>
                        </div>
                    )}
                </div>
            );
        }
    }

}

// NFT Detail View Component for the modal
function NftDetailView({ nft, metadata = {}, contractInfo = {}, transferNft, burnNft }) {
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState('details');

    if (!nft) return null;

    const name = metadata.name || `NFT #${nft.tokenId}`;
    const description = metadata.description || 'No description available';
    const attributes = metadata.attributes || [];
    const imageUrl = metadata.imageUrl || generateFallbackImage(nft.contractAddress, nft.tokenId, contractInfo);
    const collectionName = contractInfo.name || 'Unknown Collection';
    const collectionSymbol = contractInfo.symbol || '';

    return (
        <div className="nft-detail-view">
            <div className="nft-detail-header">
                <h2>{name}</h2>
                <div className="collection-badge">
                    {collectionName}
                    {collectionSymbol ? ` (${collectionSymbol})` : ''}
                </div>
            </div>

            <div className="nft-detail-content">
                <div className="nft-detail-image-container">
                    <img
                        src={imageUrl}
                        alt={name}
                        className="nft-detail-image"
                        onError={(e) => {
                            // Comprehensive error handling for detailed view
                            e.target.onerror = null;
                            const fallbackSrc = generateFallbackImage(nft.contractAddress, nft.tokenId, contractInfo);
                            if (e.target.src !== fallbackSrc) {
                                e.target.src = fallbackSrc;
                                e.target.classList.add('fallback');
                            }
                        }}
                        onLoad={(e) => {
                            // Additional safety check for problematic images
                            if (e.target.naturalWidth === 0 || e.target.naturalHeight === 0) {
                                e.target.onerror(e);
                            }
                        }}
                    />
                    {nft.type === 'ERC1155' && nft.balance > 1 && (
                        <div className="nft-detail-quantity">
                            You own {nft.balance} of these NFTs
                        </div>
                    )}
                </div>

                <div className="nft-detail-info">
                    <div className="nft-detail-tabs">
                        <button
                            className={activeTab === 'details' ? 'active' : ''}
                            onClick={() => setActiveTab('details')}
                        >
                            Details
                        </button>
                        <button
                            className={activeTab === 'attributes' ? 'active' : ''}
                            onClick={() => setActiveTab('attributes')}
                        >
                            Attributes ({attributes.length})
                        </button>
                        <button
                            className={activeTab === 'blockchain' ? 'active' : ''}
                            onClick={() => setActiveTab('blockchain')}
                        >
                            Blockchain
                        </button>
                    </div>

                    <div className="nft-detail-tab-content">
                        {activeTab === 'details' && (
                            <div className="tab-details">
                                <h3>Description</h3>
                                <p className="nft-description">{description}</p>

                                <div className="detail-actions">
                                    <button
                                        className="primary-button"
                                        onClick={() => window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`}
                                    >
                                        List for Sale
                                    </button>
                                    <button
                                        className="secondary-button"
                                        onClick={() => navigate(`/auctions/create?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`)}
                                    >
                                        Create Auction
                                    </button>
                                    <button
                                        className="tertiary-button"
                                        onClick={async () => {
                                            const toAddress = prompt('Transfer to address:');
                                            if (toAddress) {
                                                await transferNft(nft, toAddress);
                                            }
                                        }}
                                    >
                                        Transfer NFT
                                    </button>
                                    <button
                                        className="danger-button"
                                        onClick={async () => {
                                            const confirmed = window.confirm('Are you sure you want to burn this NFT? This action cannot be undone!');
                                            if (confirmed) {
                                                await burnNft(nft);
                                            }
                                        }}
                                    >
                                        Burn NFT
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeTab === 'attributes' && (
                            <div className="tab-attributes">
                                {attributes.length > 0 ? (
                                    <div className="attributes-grid">
                                        {attributes.map((attr, index) => (
                                            <div key={index} className="attribute-card">
                                                <div className="attribute-type">
                                                    {attr.trait_type || attr.name || 'Trait'}
                                                </div>
                                                <div className="attribute-value">
                                                    {attr.value?.toString() || 'Unknown'}
                                                </div>
                                                {attr.rarity_percentage && (
                                                    <div className="attribute-rarity">
                                                        {attr.rarity_percentage}% have this trait
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="no-attributes">This NFT has no attributes</p>
                                )}
                            </div>
                        )}

                        {activeTab === 'blockchain' && (
                            <div className="tab-blockchain">
                                <div className="blockchain-detail">
                                    <div className="detail-label">Contract Address</div>
                                    <div className="detail-value address">
                                        <a
                                            href={`https://explorer.vitruveo.xyz/address/${nft.contractAddress}`}

                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            {nft.contractAddress}
                                        </a>
                                    </div>
                                </div>
                                <div className="blockchain-detail">
                                    <div className="detail-label">Token ID</div>
                                    <div className="detail-value">{nft.tokenId}</div>
                                </div>
                                <div className="blockchain-detail">
                                    <div className="detail-label">Token Standard</div>
                                    <div className="detail-value">{nft.type}</div>
                                </div>
                                <div className="blockchain-detail">
                                    <div className="detail-label">Token URI</div>
                                    <div className="detail-value uri">
                                        {nft.tokenURI || 'Not available'}
                                    </div>
                                </div>
                                <div className="blockchain-actions">
                                    <button
                                        className="secondary-button"
                                        onClick={() => window.open(`https://explorer.vitruveo.xyz/token/${nft.contractAddress}?a=${nft.tokenId}`, '_blank')}
                                    >
                                        View on Explorer
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ProfilePage;

// Add this function outside of the components at the top of the file, after imports
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;

    let r, g, b;
    if (h >= 0 && h < 60) {
        [r, g, b] = [c, x, 0];
    } else if (h >= 60 && h < 120) {
        [r, g, b] = [x, c, 0];
    } else if (h >= 120 && h < 180) {
        [r, g, b] = [0, c, x];
    } else if (h >= 180 && h < 240) {
        [r, g, b] = [0, x, c];
    } else if (h >= 240 && h < 300) {
        [r, g, b] = [x, 0, c];
    } else {
        [r, g, b] = [c, 0, x];
    }

    const toHex = (c) => {
        const hex = Math.round((c + m) * 255).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    };

    return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}