import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
import { ethers } from 'ethers';
import ListingCard from '../components/ListingCard';
import '../profile-page.css';
import CacheStats from '../components/CacheStats';
import { isAuctionsEnabled } from '../utils/featureFlags';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import { NFTScanner } from '../utils/nftScanner';
import { loadNFTMetadata, batchLoadMetadata } from '../utils/metadataLoader';

// Standard ERC721 and ERC1155 minimal ABIs
const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

const ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
    'function uri(uint256 id) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
];

// List of known NFT collections to scan
const KNOWN_NFT_CONTRACTS = [
    '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906', // Pixel Ninja Cats
    '0x89207A7F75C9cb7C8f95f0c2517b029BE1AE29b8', //NeonKatz
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
const coerceMs = (v) => {
    if (v == null) return NaN;
    if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
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
};
const timeAgo = (ms) => {
    const d = Math.max(0, Date.now() - ms);
    const s = Math.floor(d / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const days = Math.floor(h / 24);
    return `${days}d`;
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
    const [showNftModal, setShowNftModal] = useState(false);
    const [showStatsModal, setShowStatsModal] = useState(false);
    const [collectionStats, setCollectionStats] = useState({});
    const [sortOption, setSortOption] = useState('default');
    const [collapsedCollections, setCollapsedCollections] = useState({});
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage, setItemsPerPage] = useState(12);
    const modalRef = useRef(null);

    // NEW: Activity + auctions state
    const [userAuctions, setUserAuctions] = useState([]);
    const [isAuctionsLoading, setIsAuctionsLoading] = useState(false);
    const [activityFilter, setActivityFilter] = useState('all'); // all | listings | sales | purchases | auctions

    // Reset pagination when filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [nftFilter, showOnlyListable, sortOption, groupByCollection]);

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

    // OPTIMIZED: Build activity timeline from multiple sources with performance optimization
    const activities = useMemo(() => {
        if (!wallet) return [];

        const walletL = wallet.toLowerCase();
        const listingById = new Map(listings.map(l => [String(l.id), l]));
        const out = [];

        // 1) Listings created by user
        for (const l of userListings) {
            const ts =
                coerceMs(l.createdAt) ??
                coerceMs(l.created_at) ??
                coerceMs(l.timestamp) ??
                coerceMs(l.blockTimestamp) ??
                coerceMs(l.listedAt) ??
                Date.now();
            out.push({
                type: 'listing',
                ts,
                label: `Listed ${l.name || `#${l.tokenId}`}`,
                detail: `${shortAddr(l.nftContract)} · #${l.tokenId}`,
                refId: String(l.id),
                meta: { ...l }
            });
        }

        // 2) Purchases made by user (buyer = wallet)
        for (const s of salesHistory || []) {
            if ((s.buyer || '').toLowerCase() === walletL) {
                const ts = coerceMs(s.timestamp) || Date.now();
                const l = listingById.get(String(s.listingId));
                out.push({
                    type: 'purchase',
                    ts,
                    label: `Bought listing #${s.listingId}`,
                    detail: l ? `${shortAddr(l.nftContract)} · #${l.tokenId}` : `Listing #${s.listingId}`,
                    refId: String(s.listingId),
                    meta: { ...s, listing: l || null }
                });
            }
        }

        // 3) Sales by user (seller = wallet if known)
        for (const s of salesHistory || []) {
            const seller = (s.seller || listingById.get(String(s.listingId))?.seller || '').toLowerCase();
            if (seller && seller === walletL) {
                const ts = coerceMs(s.timestamp) || Date.now();
                const l = listingById.get(String(s.listingId));
                out.push({
                    type: 'sale',
                    ts,
                    label: `Sold listing #${s.listingId}`,
                    detail: l ? `${shortAddr(l.nftContract)} · #${l.tokenId}` : `Listing #${s.listingId}`,
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
                    out.push({
                        type: 'cancel',
                        ts: Date.now(), // no event ts available; show recent
                        label: `Canceled listing #${id}`,
                        detail: `${shortAddr(l.nftContract)} · #${l.tokenId}`,
                        refId: String(id),
                        meta: { listing: l }
                    });
                }
            }
        }

        // 5) Auctions created by user (if any from Supabase)
        for (const a of userAuctions) {
            const ts = coerceMs(a.createdAt) || Date.now();
            out.push({
                type: 'auction',
                ts,
                label: a.status === 'canceled' ? 'Canceled auction' : 'Created auction',
                detail: `${shortAddr(a.nftContract)} · #${a.tokenId}`,
                refId: String(a.id || ''),
                meta: { ...a }
            });
            if (a.endsAt) {
                const endTs = coerceMs(a.endsAt);
                if (Number.isFinite(endTs) && endTs <= Date.now()) {
                    out.push({
                        type: 'auction_end',
                        ts: endTs,
                        label: 'Auction ended',
                        detail: `${shortAddr(a.nftContract)} · #${a.tokenId}`,
                        refId: String(a.id || ''),
                        meta: { ...a }
                    });
                }
            }
        }

        // Sort newest first
        out.sort((a, b) => (b.ts || 0) - (a.ts || 0));

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
    const generateFallbackImage = (contractAddress, tokenId) => {
        try {
            const hash = contractAddress.toLowerCase() + tokenId.toString();
            let hashNum = 0;
            for (let i = 0; i < hash.length; i++) {
                hashNum = ((hashNum << 5) - hashNum) + hash.charCodeAt(i);
                hashNum = hashNum & hashNum;
            }

            const angle = Math.abs(hashNum % 360);
            const hue1 = Math.abs(hashNum % 360);
            const hue2 = (hue1 + 180) % 360;

            const collectionInfo = contractInfo[contractAddress] || {};
            const symbol = collectionInfo.symbol || '';
            const shortName = (symbol || collectionInfo.name || '').substring(0, 8);

            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='%230f0f0f'/%3E%3Ccircle cx='150' cy='150' r='120' fill='none' stroke='hsl(${hue1},80%,50%)' stroke-width='2' stroke-opacity='0.3'/%3E%3Ccircle cx='150' cy='150' r='90' fill='none' stroke='hsl(${hue2},80%,60%)' stroke-width='2'/%3E%3Cpath d='M150,60 A90,90 0 0 1 ${150 + 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue1},80%,60%)' stroke-width='8' fill='none'/%3E%3Cpath d='M150,60 A90,90 0 0 0 ${150 - 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue2},80%,60%)' stroke-width='8' fill='none'/%3E%3Ccircle cx='150' cy='150' r='40' fill='%230f0f0f' stroke='%23ffffff' stroke-width='1' stroke-opacity='0.4'/%3E%3Ctext x='150' y='140' font-family='monospace' font-size='22' fill='%23ffffff' text-anchor='middle' font-weight='bold'%3E%23${tokenId}%3C/text%3E%3Ctext x='150' y='170' font-family='monospace' font-size='18' fill='hsl(${hue1},80%,60%)' text-anchor='middle'%3E${shortName}%3C/text%3E%3Ctext x='150' y='230' font-family='monospace' font-size='12' fill='%23ffffff' text-anchor='middle' font-weight='bold' opacity='0.7'%3EWNFT%3C/text%3E%3C/svg%3E`;
        } catch (err) {
            criticalError("Error generating SVG:", err);
            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%23000'/%3E%3Ctext x='150' y='150' fill='%23fff' text-anchor='middle' font-size='24'%3E%23${tokenId}%3C/text%3E%3C/svg%3E`;
        }
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
            // Use the optimized metadata loader
            const metadata = await loadNFTMetadata(contractAddress, tokenId, provider, 
                tokenURI ? { tokenURI } : null);

            setNftMetadata(prev => ({
                ...prev,
                [key]: metadata
            }));

        } catch (error) {
            debugWarn(`Failed to load metadata for ${contractAddress}:${tokenId}`, error);
            
            const fallbackImg = generateFallbackImage(contractAddress, tokenId);
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
                            const ownedCachedNfts = await filterOwnedNFTs(cachedProfile.nfts, wallet);
                            
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
                    const ownedNfts = await filterOwnedNFTs(foundNfts, wallet);
                    
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
            console.log('⚡ [METADATA RETRY] Calling batchFetchMetadata...');
            await batchFetchMetadata(nftList);
            console.log('✅ [METADATA RETRY] batchFetchMetadata completed successfully');
            setStatus(`✅ Metadata retry completed for ${nftsWithoutMetadata.length} NFTs`);
            setTimeout(() => setStatus(''), 3000);
        } catch (error) {
            console.error('❌ [METADATA RETRY] batchFetchMetadata failed:', error);
            setStatus(`❌ Metadata retry failed: ${error.message}`);
            setTimeout(() => setStatus(''), 3000);
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

    // Pagination logic
    const paginateItems = (items) => {
        if (!groupByCollection) {
            const startIdx = (currentPage - 1) * itemsPerPage;
            const endIdx = startIdx + itemsPerPage;
            return items.slice(startIdx, endIdx);
        }
        return items; // When grouped by collection, we'll paginate the NFTs within each collection
    };

    const paginatedItems = paginateItems(processedNfts);

    // Calculate total pages
    const totalPages = !groupByCollection
        ? Math.ceil(processedNfts.length / itemsPerPage)
        : 1; // When grouped, pagination happens within collections

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
                                {activities.slice(0, 100).map((ev, idx) => (
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
                                                <span className="muted">· {timeAgo(ev.ts)} ago</span>
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
                                ))}
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
                                {paginatedItems.length > 0 ? (
                                    paginatedItems.map((collection) => {
                                        const isCollapsed = collapsedCollections[collection.contractAddress] || false;

                                        // Paginate items within each collection
                                        const collectionStartIdx = (currentPage - 1) * itemsPerPage;
                                        const collectionEndIdx = collectionStartIdx + itemsPerPage;
                                        const paginatedCollectionItems = isCollapsed
                                            ? []
                                            : collection.items.slice(collectionStartIdx, collectionEndIdx);

                                        const totalCollectionPages = Math.ceil(collection.items.length / itemsPerPage);

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
                                                    <>
                                                        <div className={`nfts-${currentView}`}>
                                                            {paginatedCollectionItems.map((nft) => renderNftCard(nft))}
                                                        </div>

                                                        {totalCollectionPages > 1 && (
                                                            <div className="pagination">
                                                                <button
                                                                    onClick={() => setCurrentPage(1)}
                                                                    disabled={currentPage === 1}
                                                                    className="pagination-button"
                                                                >
                                                                    First
                                                                </button>
                                                                <button
                                                                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                                                                    disabled={currentPage === 1}
                                                                    className="pagination-button"
                                                                >
                                                                    Previous
                                                                </button>
                                                                <span className="page-info">
                                                                    Page {currentPage} of {totalCollectionPages}
                                                                </span>
                                                                <button
                                                                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalCollectionPages))}
                                                                    disabled={currentPage === totalCollectionPages}
                                                                    className="pagination-button"
                                                                >
                                                                    Next
                                                                </button>
                                                                <button
                                                                    onClick={() => setCurrentPage(totalCollectionPages)}
                                                                    disabled={currentPage === totalCollectionPages}
                                                                    className="pagination-button"
                                                                >
                                                                    Last
                                                                </button>
                                                            </div>
                                                        )}
                                                    </>
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
                            // Regular view
                            <div className="ungrouped-view card">
                                {userNfts.length > 0 && (
                                    <div className="collection-stats-bar">
                                        {nftFilter ? (
                                            <p>Found {processedNfts.length} of {userNfts.length} NFTs matching "{nftFilter}"</p>
                                        ) : (
                                            <p>Showing {paginatedItems.length} of {processedNfts.length} NFTs</p>
                                        )}
                                    </div>
                                )}

                                {paginatedItems.length > 0 ? (
                                    <>
                                        <div className={`nfts-${currentView}`}>
                                            {paginatedItems.map(nft => renderNftCard(nft))}
                                        </div>

                                        {totalPages > 1 && (
                                            <div className="pagination">
                                                <button
                                                    onClick={() => setCurrentPage(1)}
                                                    disabled={currentPage === 1}
                                                    className="pagination-button"
                                                >
                                                    First
                                                </button>
                                                <button
                                                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                                                    disabled={currentPage === 1}
                                                    className="pagination-button"
                                                >
                                                    Previous
                                                </button>
                                                <span className="page-info">
                                                    Page {currentPage} of {totalPages}
                                                </span>
                                                <button
                                                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                                                    disabled={currentPage === totalPages}
                                                    className="pagination-button"
                                                >
                                                    Next
                                                </button>
                                                <button
                                                    onClick={() => setCurrentPage(totalPages)}
                                                    disabled={currentPage === totalPages}
                                                    className="pagination-button"
                                                >
                                                    Last
                                                </button>
                                            </div>
                                        )}
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

            {/* NFT Detail Modal */}
            {showNftModal && selectedNft && (
                <div className="modal-overlay">
                    <div className="nft-modal card" ref={modalRef}>
                        <button className="modal-close" onClick={() => setShowNftModal(false)}>×</button>
                        <NftDetailView nft={selectedNft} metadata={nftMetadata[`${selectedNft.contractAddress.toLowerCase()}-${selectedNft.tokenId}`]} contractInfo={contractInfo[selectedNft.contractAddress]} />
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
        const fallbackImg = generateFallbackImage(nft.contractAddress, nft.tokenId);
        const imageUrl = metadata.imageUrl || fallbackImg;
        const name = metadata.name || `NFT #${nft.tokenId}`;
        const collectionInfo = contractInfo[nft.contractAddress] || {};

        if (currentView === 'grid') {
            return (
                <div key={key} className="nft-card" onClick={() => openNftModal(nft)}>
                    <div className="nft-card-inner">
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
                                        const fallbackSrc = generateFallbackImage(nft.contractAddress, nft.tokenId);
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
                        </div>
                    </div>
                </div>
            );
        } else {
            // List view
            return (
                <div key={key} className="nft-list-item">
                    <div className="nft-list-image" onClick={() => openNftModal(nft)}>
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
                                    const fallbackSrc = generateFallbackImage(nft.contractAddress, nft.tokenId);
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
                    <div className="nft-list-details" onClick={() => openNftModal(nft)}>
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
                    </div>
                </div>
            );
        }
    }

}

// NFT Detail View Component for the modal
function NftDetailView({ nft, metadata = {}, contractInfo = {} }) {
    const [activeTab, setActiveTab] = useState('details');

    if (!nft) return null;

    const name = metadata.name || `NFT #${nft.tokenId}`;
    const description = metadata.description || 'No description available';
    const attributes = metadata.attributes || [];
    const imageUrl = metadata.imageUrl || generateFallbackImage(nft.contractAddress, nft.tokenId);
    const collectionName = contractInfo.name || 'Unknown Collection';
    const collectionSymbol = contractInfo.symbol || '';

    // Helper to generate fallback image - simple but reliable version
    // Generate a custom LP-style placeholder SVG for NFTs
    const generateFallbackImage = (contractAddress, tokenId) => {
        try {
            const hash = contractAddress.toLowerCase() + tokenId.toString();
            let hashNum = 0;
            for (let i = 0; i < hash.length; i++) {
                hashNum = ((hashNum << 5) - hashNum) + hash.charCodeAt(i);
                hashNum = hashNum & hashNum;
            }

            const angle = Math.abs(hashNum % 360);
            const hue1 = Math.abs(hashNum % 360);
            const hue2 = (hue1 + 180) % 360;

            const collectionInfo = contractInfo[contractAddress] || {};
            const symbol = collectionInfo.symbol || '';
            const shortName = (symbol || collectionInfo.name || '').substring(0, 8);

            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='%230f0f0f'/%3E%3Ccircle cx='150' cy='150' r='120' fill='none' stroke='hsl(${hue1},80%,50%)' stroke-width='2' stroke-opacity='0.3'/%3E%3Ccircle cx='150' cy='150' r='90' fill='none' stroke='hsl(${hue2},80%,60%)' stroke-width='2'/%3E%3Cpath d='M150,60 A90,90 0 0 1 ${150 + 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue1},80%,60%)' stroke-width='8' fill='none'/%3E%3Cpath d='M150,60 A90,90 0 0 0 ${150 - 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue2},80%,60%)' stroke-width='8' fill='none'/%3E%3Ccircle cx='150' cy='150' r='40' fill='%230f0f0f' stroke='%23ffffff' stroke-width='1' stroke-opacity='0.4'/%3E%3Ctext x='150' y='140' font-family='monospace' font-size='22' fill='%23ffffff' text-anchor='middle' font-weight='bold'%3E%23${tokenId}%3C/text%3E%3Ctext x='150' y='170' font-family='monospace' font-size='18' fill='hsl(${hue1},80%,60%)' text-anchor='middle'%3E${shortName}%3C/text%3E%3Ctext x='150' y='230' font-family='monospace' font-size='12' fill='%23ffffff' text-anchor='middle' font-weight='bold' opacity='0.7'%3EWNFT%3C/text%3E%3C/svg%3E`;
        } catch (err) {
            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%23000'/%3E%3Ctext x='150' y='150' fill='%23fff' text-anchor='middle' font-size='24'%3E%23${tokenId}%3C/text%3E%3C/svg%3E`;
        }
    };

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
                            const fallbackSrc = generateFallbackImage(nft.contractAddress, nft.tokenId);
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