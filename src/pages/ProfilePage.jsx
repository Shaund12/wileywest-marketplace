import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
import { ethers } from 'ethers';
import ListingCard from '../components/ListingCard';
import { NFTScanner } from '../utils/nftScanner';
import '../profile-page.css';
import CacheStats from '../components/CacheStats';
import { isAuctionsEnabled } from '../utils/featureFlags';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';

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
];

// Multiple IPFS gateways to try for better reliability
const IPFS_GATEWAYS = [

    'https://ipfs.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://ipfs.fleek.co/ipfs/',
    'https://dweb.link/ipfs/',
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
    const [isScanning, setIsScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState({ found: 0, scanned: 0, total: 0 });
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
    const [activities, setActivities] = useState([]);
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

    // NEW: Build activity timeline from multiple sources (non-invasive, read-only)
    useEffect(() => {
        if (!wallet) { setActivities([]); return; }

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

        setActivities(filtered);
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

    // Fetch NFT metadata with improved error handling and multiple retry attempts
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
            if (tokenURI) {
                let resolvedUri = tokenURI;
                resolvedUri = resolvedUri.replace(/{id}/g, tokenId)
                    .replace(/{tokenId}/g, tokenId)
                    .replace(/\{id\}/g, tokenId);

                if (resolvedUri.startsWith('ipfs://')) {
                    resolvedUri = `https://cloudflare-ipfs.com/ipfs/${resolvedUri.replace('ipfs://', '')}`;
                }

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

                try {
                    const response = await fetch(resolvedUri, {
                        signal: controller.signal,
                        headers: {
                            'Accept': 'application/json'
                        }
                    });
                    clearTimeout(timeoutId);

                    if (response.ok) {
                        const metadata = await response.json();

                        let imageUrl = null;

                        if (metadata.image) {
                            imageUrl = metadata.image;
                            if (imageUrl.startsWith('ipfs://')) {
                                imageUrl = `https://cloudflare-ipfs.com/ipfs/${imageUrl.replace('ipfs://', '')}`;
                            }
                        } else if (metadata.image_url) {
                            imageUrl = metadata.image_url;
                        } else if (metadata.imageUrl) {
                            imageUrl = metadata.imageUrl;
                        }

                        const attributes = metadata.attributes || metadata.traits || [];

                        setNftMetadata(prev => ({
                            ...prev,
                            [key]: {
                                ...metadata,
                                imageUrl,
                                attributes,
                                loaded: true,
                                loading: false,
                                error: null
                            }
                        }));
                        return;
                    }
                } catch (fetchError) {
                    clearTimeout(timeoutId);

                    if (tokenURI.startsWith('ipfs://')) {
                        for (const gateway of IPFS_GATEWAYS) {
                            if (gateway === 'https://cloudflare-ipfs.com/ipfs/') continue;

                            try {
                                const altUri = `${gateway}${tokenURI.replace('ipfs://', '')}`;
                                const altResponse = await fetch(altUri);
                                if (altResponse.ok) {
                                    const metadata = await altResponse.json();

                                    let imageUrl = null;
                                    if (metadata.image) {
                                        imageUrl = metadata.image;
                                        if (imageUrl.startsWith('ipfs://')) {
                                            imageUrl = `${gateway}${imageUrl.replace('ipfs://', '')}`;
                                        }
                                    } else if (metadata.image_url) {
                                        imageUrl = metadata.image_url;
                                    }

                                    const attributes = metadata.attributes || metadata.traits || [];

                                    setNftMetadata(prev => ({
                                        ...prev,
                                        [key]: {
                                            ...metadata,
                                            imageUrl,
                                            attributes,
                                            loaded: true,
                                            loading: false,
                                            error: null
                                        }
                                    }));
                                    return;
                                }
                            } catch { /* next gateway */ }
                        }
                    }
                }
            }

            const fallbackImg = generateFallbackImage(contractAddress, tokenId);

            setNftMetadata(prev => ({
                ...prev,
                [key]: {
                    name: `NFT #${tokenId}`,
                    description: 'Metadata unavailable',
                    loaded: true,
                    loading: false,
                    error: 'Could not fetch metadata',
                    imageUrl: fallbackImg,
                    attributes: []
                }
            }));

        } catch (error) {
            const fallbackImg = generateFallbackImage(contractAddress, tokenId);

            setNftMetadata(prev => ({
                ...prev,
                [key]: {
                    name: `NFT #${tokenId}`,
                    description: 'Error loading metadata',
                    loaded: true,
                    loading: false,
                    error: error.message || 'Error loading metadata',
                    imageUrl: fallbackImg,
                    attributes: []
                }
            }));
        }
    };

    // Optimized batch fetching function with maximum parallelism
    const batchFetchMetadata = async (nfts) => {
        const nftsToFetch = nfts.filter(nft => {
            const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
            return !nftMetadata[key]?.loaded && nft.tokenURI;
        });

        if (nftsToFetch.length === 0) return;

        setStatus(`Fetching metadata for ${nftsToFetch.length} NFTs...`);

        const visibleNfts = nftsToFetch.slice(0, 20);
        const backgroundNfts = nftsToFetch.slice(20);

        if (visibleNfts.length > 0) {
            await Promise.all(
                visibleNfts.map(nft =>
                    fetchNftMetadata(nft.contractAddress, nft.tokenId, nft.tokenURI)
                        .catch(err => criticalError(`Error fetching visible metadata for ${nft.tokenId}:`, err))
                )
            );
        }

        if (backgroundNfts.length > 0) {
            const concurrencyLimit = 15;
            const chunks = [];

            for (let i = 0; i < backgroundNfts.length; i += concurrencyLimit) {
                chunks.push(backgroundNfts.slice(i, i + concurrencyLimit));
            }

            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                setStatus(`Fetching metadata chunk ${i + 1}/${chunks.length} (${chunk.length} NFTs)...`);

                await Promise.all(
                    chunk.map(nft =>
                        fetchNftMetadata(nft.contractAddress, nft.tokenId, nft.tokenURI)
                            .catch(err => criticalError(`Error fetching background metadata for ${nft.tokenId}:`, err))
                    )
                );
            }
        }

        setStatus(`Finished loading metadata for ${nftsToFetch.length} NFTs`);
    }

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

    // Scan for ERC721 NFTs owned by user
    const scanERC721 = async (contractAddress) => {
        try {
            const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
            const balance = await contract.balanceOf(wallet);

            if (balance.toString() === '0') return [];

            await getContractInfo(contractAddress, 'ERC721');

            const nfts = [];
            const balanceNum = Number(balance.toString());

            setScanProgress(prev => ({
                ...prev,
                total: prev.total + balanceNum
            }));

            const batchSize = 5;
            for (let batchStart = 0; batchStart < balanceNum; batchStart += batchSize) {
                const batchPromises = [];

                for (let i = batchStart; i < Math.min(batchStart + batchSize, balanceNum); i++) {
                    batchPromises.push((async () => {
                        try {
                            const tokenId = await contract.tokenOfOwnerByIndex(wallet, i);
                            let tokenURI = null;

                            try {
                                tokenURI = await contract.tokenURI(tokenId);
                            } catch { }

                            const nft = {
                                contractAddress,
                                tokenId: tokenId.toString(),
                                type: 'ERC721',
                                tokenURI,
                                balance: '1',
                            };

                            nfts.push(nft);

                            setScanProgress(prev => ({
                                ...prev,
                                found: prev.found + 1,
                                scanned: prev.scanned + 1
                            }));

                            return nft;
                        } catch (e) {
                            setScanProgress(prev => ({
                                ...prev,
                                scanned: prev.scanned + 1
                            }));
                            return null;
                        }
                    })());
                }

                await Promise.all(batchPromises);
            }

            if (nfts.length > 0) {
                setTimeout(() => batchFetchMetadata(nfts), 100);
            }

            return nfts;
        } catch (e) {
            return [];
        }
    };

    // Scan for ERC1155 NFTs based on recent transfer events
    const scanERC1155 = async (contractAddress) => {
        try {
            const contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider);

            await getContractInfo(contractAddress, 'ERC1155');

            const transferSingleFilter = contract.filters.TransferSingle(null, null, wallet);
            const transferBatchFilter = contract.filters.TransferBatch(null, null, wallet);

            const currentBlock = await provider.getBlockNumber();
            const fromBlock = 0;

            const singleEvents = await contract.queryFilter(transferSingleFilter, fromBlock);
            const batchEvents = await contract.queryFilter(transferBatchFilter, fromBlock);

            const tokenIds = new Set();

            singleEvents.forEach(event => {
                tokenIds.add(event.args.id.toString());
            });

            batchEvents.forEach(event => {
                event.args.ids.forEach(id => tokenIds.add(id.toString()));
            });

            listings
                .filter(l => l.nftContract.toLowerCase() === contractAddress.toLowerCase())
                .forEach(l => tokenIds.add(l.tokenId.toString()));

            for (let i = 1; i <= 10; i++) {
                tokenIds.add(i.toString());
            }

            const uniqueTokenIds = [...tokenIds];

            setScanProgress(prev => ({
                ...prev,
                total: prev.total + uniqueTokenIds.length
            }));

            const nfts = [];

            for (const tokenId of uniqueTokenIds) {
                try {
                    const balance = await contract.balanceOf(wallet, tokenId);

                    if (balance.toString() !== '0') {
                        let tokenURI = null;
                        try {
                            tokenURI = await contract.uri(tokenId);
                        } catch { }

                        nfts.push({
                            contractAddress,
                            tokenId,
                            type: 'ERC1155',
                            tokenURI,
                            balance: balance.toString()
                        });

                        fetchNftMetadata(contractAddress, tokenId, tokenURI);

                        setScanProgress(prev => ({
                            ...prev,
                            found: prev.found + 1
                        }));
                    }

                    setScanProgress(prev => ({
                        ...prev,
                        scanned: prev.scanned + 1
                    }));

                } catch {
                    setScanProgress(prev => ({
                        ...prev,
                        scanned: prev.scanned + 1
                    }));
                }
            }

            return nfts;
        } catch (e) {
            return [];
        }
    };

    // Scan Transfer events for NFTs sent to the user
    const scanForTransferEvents = async () => {
        try {
            const erc721TransferTopic = ethers.id('Transfer(address,address,uint256)');
            const toUserTopic = ethers.zeroPadValue(wallet.toLowerCase(), 32);

            const filter = {
                topics: [erc721TransferTopic, null, toUserTopic],
                fromBlock: -10000,
                toBlock: 'latest'
            };

            const logs = await provider.getLogs(filter);
            const contracts = [...new Set(logs.map(log => log.address.toLowerCase()))];

            return contracts;
        } catch (e) {
            return [];
        }
    };

    // Find ALL NFTs owned by the user with cache-first approach and throttling
    const scanningInProgress = useRef(false);
    const scanningTimeout = useRef(null);

    // Reset scanning state with timeout protection
    const resetScanningState = () => {
        scanningInProgress.current = false;
        if (scanningTimeout.current) {
            clearTimeout(scanningTimeout.current);
            scanningTimeout.current = null;
        }
    };

    // Force reset scanning state (for stuck situations)
    const forceResetScanningState = () => {
        resetScanningState();
        setIsLoading(false);
        setIsScanning(false);
    };

    // Find ALL NFTs owned by the user with cache-first approach and ALWAYS scan from genesis (block 0)
    // USER REQUIREMENT: Always load cache AND always scan from block 0 no matter what
    const findAllUserNfts = async (forceRefresh = false, allowBackgroundUpdate = false, scanFromGenesis = true) => {
        if (!wallet || !provider) return;

        if (scanFromGenesis) {
            forceResetScanningState();
        } else {
            if (scanningInProgress.current && !forceRefresh) {
                return;
            }
            if (forceRefresh) {
                resetScanningState();
            }
        }

        setIsLoading(true);
        scanningInProgress.current = true;

        scanningTimeout.current = setTimeout(() => {
            forceResetScanningState();
            setStatus("Scanning timed out - please try again");
        }, 10 * 60 * 1000);

        try {
            // Always load cache first
            if (supabaseConnected && getCachedProfile) {
                setStatus("Loading profile from cache...");
                try {
                    const cachedProfile = await getCachedProfile(wallet);
                    if (cachedProfile?.nfts && cachedProfile.nfts.length > 0) {
                        setUserNfts(cachedProfile.nfts);
                        setNftMetadata(cachedProfile.metadata || {});
                        setStatus(`Loaded ${cachedProfile.nfts.length} NFTs from cache`);
                        await fetchContractInfoForNfts(cachedProfile.nfts);
                        await batchFetchMetadata(cachedProfile.nfts);
                    }
                } catch { /* ignore cache errors */ }
            }

            // Always scan from chain (genesis or conservative)
            setStatus(scanFromGenesis
                ? "🔥 SCANNING ALL BLOCKCHAIN HISTORY FROM BLOCK 0 - This may take a few minutes..."
                : "Scanning recent blockchain activity...");
            await scanUserNftsFromBlockchain(false, forceRefresh, scanFromGenesis);

        } catch (error) {
            setStatus(`Error loading NFTs: ${error.message}`);
        } finally {
            setIsLoading(false);
            resetScanningState();
        }
    };

    const scanUserNftsFromBlockchain = async (isBackgroundUpdate = false, isForceRefresh = false, scanFromGenesis = true) => {
        if (scanFromGenesis) {
            // always allowed
        } else {
            if (scanningInProgress.current && !isForceRefresh) {
                return;
            }
        }

        const now = Date.now();
        if (isBackgroundUpdate && now - lastScanTime.current < SCAN_THROTTLE_MS) {
            return;
        }

        if (!isBackgroundUpdate) {
            setIsScanning(true);
            setScanProgress({ found: 0, scanned: 0, total: 0 });
            setStatus("Scanning blockchain for your NFTs...");
            scanningInProgress.current = true;
            scanningTimeout.current = setTimeout(() => {
                forceResetScanningState();
                setStatus("Scanning timed out - please try again");
            }, 5 * 60 * 1000);
        }

        lastScanTime.current = now;

        try {
            let scanner;
            try {
                scanner = new NFTScanner(provider, wallet, (statusMsg) => {
                    if (!isBackgroundUpdate) {
                        setStatus(statusMsg);
                    }
                });
            } catch (scannerError) {
                setStatus(`Error initializing scanner: ${scannerError.message}`);
                return;
            }

            const foundNfts = await scanner.scanAllNFTs(isBackgroundUpdate, scanFromGenesis);

            if (foundNfts.length > 0) {
                setUserNfts(foundNfts);
                if (!isBackgroundUpdate) {
                    setStatus(`✅ Found ${foundNfts.length} NFTs in your wallet`);
                }

                await fetchContractInfoForNfts(foundNfts);

                if (supabaseConnected && cacheProfileData) {
                    try {
                        const profileData = {
                            nfts: foundNfts,
                            listings: userListings,
                            balance: await provider.getBalance(wallet).then(b => b.toString())
                        };
                        await cacheProfileData(wallet, profileData);
                    } catch { }
                }

                batchFetchMetadata(foundNfts);
            } else {
                if (isForceRefresh) {
                    setUserNfts([]);
                    setStatus("Force refresh complete - no NFTs found in wallet");
                } else if (!isBackgroundUpdate) {
                    setStatus("⚠️ Scan found 0 NFTs - there may be RPC issues. Try 'Force Refresh'.");
                }
            }

            if (!isBackgroundUpdate && foundNfts.length > 0) {
                setTimeout(() => setStatus(''), 3000);
            }

        } catch (error) {
            let errorMessage = `Error scanning: ${error.message}`;
            if (error.message?.includes?.('network')) errorMessage = "Network error - please check your connection and try again";
            else if (error.message?.includes?.('timeout')) errorMessage = "Scan timed out - please try again";
            else if (error.message?.includes?.('rate limit')) errorMessage = "Too many requests - please wait a moment and try again";
            if (!isBackgroundUpdate) {
                setStatus(errorMessage);
            }
        } finally {
            if (!isBackgroundUpdate) {
                setIsScanning(false);
                resetScanningState();
            }
        }
    };

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

    // Fetch NFTs when tab is changed to collection
    useEffect(() => {
        if (activeTab === 'collection' && wallet && !userNfts.length) {
            // USER REQUIREMENT: ALWAYS scan from genesis (block 0) for initial load
            findAllUserNfts(false, true, true); // forceRefresh=false, allowBackgroundUpdate=true, scanFromGenesis=true
        }
    }, [activeTab, wallet]);

    // Set up real-time subscriptions for profile updates with improved throttling
    const lastScanTime = useRef(0);
    const SCAN_THROTTLE_MS = 2 * 60 * 1000; // Increased to 2 minutes to reduce frequency

    useEffect(() => {
        if (supabaseConnected && subscribeToProfiles && wallet) {
            const profileSubscription = subscribeToProfiles((payload) => {
                if (payload.new?.wallet_address === wallet.toLowerCase()) {
                    const now = Date.now();
                    if (scanningInProgress.current || isScanning) {
                        return;
                    }
                    if (now - lastScanTime.current > SCAN_THROTTLE_MS) {
                        lastScanTime.current = now;
                        findAllUserNfts(false, false, true); // scanFromGenesis = true
                    }
                }
            });

            return () => {
                if (profileSubscription) {
                    profileSubscription.unsubscribe();
                }
            };
        }
    }, [supabaseConnected, wallet]); // Removed subscribeToProfiles from dependencies

    // Cleanup scanning state when wallet changes or component unmounts
    useEffect(() => {
        return () => {
            resetScanningState();
        };
    }, [wallet]);

    // Also cleanup on component unmount
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
                                        onClick={() => findAllUserNfts(false, true, true)} // USER REQUIREMENT: ALWAYS scan from genesis
                                        disabled={isLoading || isScanning}
                                    >
                                        {isScanning ? (
                                            <>
                                                <span className="spinner"></span>
                                                Scanning...
                                            </>
                                        ) : (
                                            <>
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                    <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
                                                </svg>
                                                Find All NFTs
                                            </>
                                        )}
                                    </button>
                                    <button
                                        className="tertiary-button action-button scan-history-button"
                                        onClick={() => findAllUserNfts(false, false, true)}
                                        disabled={isLoading || isScanning}
                                        title="Comprehensive scan from blockchain genesis (block 0) - finds all historical NFTs"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                            <path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zM12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
                                        </svg>
                                        Scan All History
                                    </button>
                                    <button
                                        className="secondary-button action-button force-refresh-button"
                                        onClick={() => findAllUserNfts(true, false, true)} // USER REQUIREMENT: ALWAYS scan from genesis
                                        disabled={false}
                                        title="Force refresh - bypasses stuck scanning state and cache"
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

                        {isScanning && (
                            <div className="scan-progress">
                                <div className="progress-bar">
                                    <div
                                        className="progress-fill"
                                        style={{
                                            width: `${scanProgress.total > 0 ? (scanProgress.scanned / scanProgress.total * 100) : 0}%`
                                        }}
                                    ></div>
                                </div>
                                <div className="progress-stats">
                                    <span>Found: <strong>{scanProgress.found} NFTs</strong></span>
                                    <span>Scanned: <strong>{scanProgress.scanned}/{scanProgress.total || '?'}</strong></span>
                                </div>
                                {/* Add the disclaimer here */}
                                <NFTScannerDisclaimer />
                            </div>
                        )}

                        {isLoading && !isScanning ? (
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
                                                <p className="small">Try scanning for all your NFTs</p>
                                            </>
                                        )}
                                        <button
                                            className="primary-button"
                                            onClick={() => findAllUserNfts(true, false, true)} // USER REQUIREMENT: ALWAYS scan from genesis
                                            disabled={isScanning}
                                        >
                                            {isScanning ? 'Scanning...' : 'Force Refresh NFTs'}
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
                                                <p className="small">Try scanning for all your NFTs</p>
                                            </>

                                        )}
                                        <button
                                            className="primary-button"
                                            onClick={() => findAllUserNfts(true, false, true)} // USER REQUIREMENT: ALWAYS scan from genesis
                                            disabled={isScanning}
                                        >
                                            {isScanning ? 'Scanning...' : 'Force Refresh NFTs'}
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
                                        e.target.onerror = null;
                                        e.target.src = fallbackImg;
                                        e.target.classList.add('fallback');
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
                                    e.target.onerror = null;
                                    e.target.src = fallbackImg;
                                    e.target.classList.add('fallback');
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

    // Add this function inside ProfilePage component before the return statement
    function NFTScannerDisclaimer() {
        return (
            <div className="nft-scanner-disclaimer">
                <div className="disclaimer-header">
                    <i className="fas fa-info-circle"></i>
                    <h3>Enhanced NFT Scanning</h3>
                </div>
                <p>Searching for your NFTs using a balanced approach that covers the last 6 months of blockchain history. This ensures comprehensive coverage while maintaining good performance.</p>
                <div className="tips-container">
                    <h4>What we're doing:</h4>
                    <ul>
                        <li>Scanning known NFT contracts and recent transfer history</li>
                        <li>Automatically retrying failed network requests</li>
                        <li>Caching results for instant future loading</li>
                        <li>Using timeouts to prevent hanging requests</li>
                    </ul>
                </div>
                {scanProgress.total > 0 && (
                    <div className="scan-details">
                        <small>
                            Progress: {scanProgress.scanned}/{scanProgress.total} contracts checked,
                            {scanProgress.found} NFTs found
                        </small>
                    </div>
                )}
            </div>
        );
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
                            e.target.onerror = null;
                            e.target.src = generateFallbackImage(nft.contractAddress, nft.tokenId);
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