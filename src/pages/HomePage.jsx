// HomePage.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { useSupabase } from '../context/SupabaseContext';
import { convertToUSDCValue, getTokenSymbol, fetchTokenDetails } from '../utils/tokenUtils';
import ListingCard from '../components/ListingCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
import VtruMarketplaceArtifact from '../abi/VTRUNFTMarketplace.json';
import './HomePage.css';

/* -------------------------------
   Utils
-------------------------------- */
function useCountUp(target = 0, duration = 900) {
    const [val, setVal] = useState(0);
    const rafRef = useRef(0);

    useEffect(() => {
        cancelAnimationFrame(rafRef.current);
        const start = performance.now();

        const animate = (now) => {
            const p = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
            setVal(Math.floor(eased * (Number.isFinite(target) ? target : 0)));
            if (p < 1) rafRef.current = requestAnimationFrame(animate);
        };
        rafRef.current = requestAnimationFrame(animate);

        return () => cancelAnimationFrame(rafRef.current);
    }, [target, duration]);

    return val;
}

const formatUSD = (n) =>
    Number.isFinite(n) && n >= 0
        ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '$—';

const coerceNumber = (val) => {
    if (typeof val === 'number') return Number.isFinite(val) ? val : NaN;
    if (typeof val === 'string') {
        const n = Number(val);
        return Number.isFinite(n) ? n : NaN;
    }
    if (typeof val === 'bigint') {
        const n = Number(val);
        return Number.isFinite(n) ? n : NaN;
    }
    if (val && typeof val === 'object') {
        if (typeof val.toString === 'function') {
            const n = Number(val.toString());
            return Number.isFinite(n) ? n : NaN;
        }
        if (typeof val._hex === 'string') {
            const n = Number(val._hex);
            return Number.isFinite(n) ? n : NaN;
        }
    }
    return NaN;
};

// Timestamp coercion (seconds/ms, ISO, {seconds})
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

/* -------------------------------
   Collection name resolver
-------------------------------- */
const ERC721_METADATA_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
];

function useCollectionNames(addresses = [], provider) {
    const [names, setNames] = useState({}); // { [lowerAddr]: 'Cool Cats' }

    useEffect(() => {
        let cancelled = false;
        if (!provider) return;

        const unique = Array.from(
            new Set((addresses || []).filter(Boolean).map((a) => a.toLowerCase()))
        );

        const missing = unique.filter((a) => !names[a]);
        if (missing.length === 0) return;

        (async () => {
            const entries = await Promise.all(
                missing.map(async (addr) => {
                    try {
                        const c = new ethers.Contract(addr, ERC721_METADATA_ABI, provider);
                        let label = '';
                        try {
                            label = await c.name();
                        } catch {
                            try {
                                label = await c.symbol();
                            } catch {
                                /* ignore */
                            }
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
                        if (!next[addr]) next[addr] = label || null;
                    }
                    return next;
                });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [addresses, provider, names]);

    return names;
}

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const fmtToken = (n) => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';

// Auction time formatting
const timeLeft = (endMs) => {
    const d = Math.max(0, endMs - Date.now());
    const s = Math.floor(d / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
};

/* -------------------------------
   HomePage
-------------------------------- */
function HomePage() {
    const {
        listings = [],
        hotListings = [],
        isInitialized,
        status,
        marketplaceStats = {},
        fetchListings,
        marketplaceAddress,
    } = useMarketplace();

    const { provider } = useWallet();
    const { supabase, isConnected: supabaseConnected } = useSupabase();

    // Auctions state
    const [auctions, setAuctions] = useState([]);
    const [isAuctionsLoading, setIsAuctionsLoading] = useState(false);

    // Ensure data on cold landings
    useEffect(() => {
        if (!isInitialized && typeof fetchListings === 'function') {
            fetchListings().catch(() => { });
        }
    }, [isInitialized, fetchListings]);

    // Fetch auctions for homepage
    const fetchAuctions = useCallback(async () => {
        if (!provider || !marketplaceAddress) return;

        setIsAuctionsLoading(true);
        try {
            // Try Supabase first if available
            let auctions = [];
            if (supabaseConnected && supabase) {
                try {
                    const { data, error } = await supabase
                        .from('auctions')
                        .select('*')
                        .eq('marketplace_address', marketplaceAddress.toLowerCase())
                        .order('created_at', { ascending: false })
                        .limit(6);
                    
                    if (!error && Array.isArray(data)) {
                        auctions = data.map(a => ({
                            id: String(a.id || a.auction_id || ''),
                            nftContract: (a.nft_contract || '').toLowerCase(),
                            tokenId: String(a.token_id || ''),
                            seller: (a.seller || '').toLowerCase(),
                            paymentToken: a.payment_token || ethers.ZeroAddress,
                            reservePrice: String(a.reserve_price || '0'),
                            startPrice: String(a.start_price || '0'),
                            startTime: Number(a.start_time || 0) * 1000,
                            endTime: Number(a.end_time || 0) * 1000,
                            highestBid: String(a.highest_bid || '0'),
                            highestBidder: (a.highest_bidder || '').toLowerCase(),
                            image: a.image_url || null,
                            name: a.name || `#${a.token_id || ''}`,
                            status: (a.status || '').toLowerCase(),
                            active: true
                        }));
                    }
                } catch (e) {
                    console.warn('Supabase auction fetch failed:', e);
                }
            }

            // If no auctions from Supabase, try on-chain (limited scan)
            if (auctions.length === 0) {
                try {
                    const contract = new ethers.Contract(marketplaceAddress, VtruMarketplaceArtifact.abi, provider);
                    const current = await provider.getBlockNumber();
                    const fromBlock = Math.max(0, current - 10000); // Last 10k blocks only for homepage
                    
                    const created = await contract.queryFilter(contract.filters.AuctionCreated(), fromBlock, current);
                    const recent = created.slice(-6); // Last 6 auctions
                    
                    auctions = await Promise.all(recent.map(async (ev) => {
                        try {
                            const auctionId = String(ev.args?.auctionId?.toString?.() || '');
                            if (!auctionId) return null;
                            
                            const a = await contract.auctions(auctionId);
                            const endMs = Number(a.endTime || 0) * 1000;
                            const active = Boolean(a.started) && !Boolean(a.settled) && (endMs ? Date.now() < endMs : true);
                            
                            return {
                                id: auctionId,
                                nftContract: (a.nftContract || '').toLowerCase(),
                                tokenId: String(a.tokenId || '0'),
                                seller: (a.seller || '').toLowerCase(),
                                paymentToken: a.paymentToken || ethers.ZeroAddress,
                                reservePrice: String(a.reservePrice || '0'),
                                startPrice: String(a.startPrice || '0'),
                                startTime: Number(a.startTime || 0) * 1000,
                                endTime: endMs,
                                highestBid: String(a.highestBid || '0'),
                                highestBidder: (a.highestBidder || '').toLowerCase(),
                                image: null,
                                name: `#${a.tokenId || '0'}`,
                                active
                            };
                        } catch {
                            return null;
                        }
                    }));
                    auctions = auctions.filter(Boolean);
                } catch (e) {
                    console.warn('Chain auction fetch failed:', e);
                }
            }

            // Only show active auctions
            const activeAuctions = auctions.filter(a => {
                const endMs = a.endTime;
                return !endMs || Date.now() < endMs;
            });

            setAuctions(activeAuctions);
        } finally {
            setIsAuctionsLoading(false);
        }
    }, [provider, marketplaceAddress, supabaseConnected, supabase]);

    useEffect(() => {
        if (provider && marketplaceAddress) {
            fetchAuctions();
        }
    }, [fetchAuctions]);

    // Activity feed (simple, local)
    const activity = useMemo(() => {
        return (listings || [])
            .slice()
            .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
            .slice(0, 12)
            .map((l) => ({
                id: l.id,
                name: l.metadata?.name || l.name || `#${l.tokenId}`,
                seller: l.seller,
                nftContract: l.nftContract,
                tokenId: l.tokenId,
                image: l.image || l.imageUrl || l.metadata?.image || l.metadata?.image_url,
            }));
    }, [listings]);

    /* ---------- Trending collections (by listing count) ---------- */
    const trendingCollections = useMemo(() => {
        const map = new Map();
        for (const l of listings || []) {
            const addr = (l?.nftContract || '').toLowerCase();
            if (!addr) continue;
            const entry = map.get(addr) || { address: addr, count: 0, sample: null };
            entry.count += 1;
            if (
                !entry.sample &&
                (l.image || l.imageUrl || l.metadata?.image || l.metadata?.image_url)
            ) {
                entry.sample = l;
            }
            map.set(addr, entry);
        }
        return Array.from(map.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 6);
    }, [listings]);

    // Addresses needing names (trending + activity)
    const addressesNeedingNames = useMemo(() => {
        const s = new Set();
        for (const t of trendingCollections) s.add(t.address);
        for (const a of activity) if (a.nftContract) s.add(a.nftContract.toLowerCase());
        return Array.from(s);
    }, [trendingCollections, activity]);

    const nameMap = useCollectionNames(addressesNeedingNames, provider);
    const labelFor = useCallback(
        (addr) => {
            const key = (addr || '').toLowerCase();
            return nameMap[key] || shortAddr(addr);
        },
        [nameMap]
    );

    // ----- Stats (with resilient fallbacks) -----
    const totalListingsStat = coerceNumber(marketplaceStats?.totalListings);
    const totalListings = Number.isFinite(totalListingsStat) && totalListingsStat > 0
        ? totalListingsStat
        : (listings?.length || 0);

    const totalVolume = (() => {
        const n = coerceNumber(marketplaceStats?.totalVolume);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    })();

    const currentListingVolume = (() => {
        const n = coerceNumber(marketplaceStats?.currentListingVolume);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    })();

    // Floor (USDC) — prefer backend, else derive from live listings
    const [derivedFloor, setDerivedFloor] = useState(null);
    const [floorLoading, setFloorLoading] = useState(false);
    const [floorSource, setFloorSource] = useState('stat'); // 'stat' | 'live'

    const floorFromStats = useMemo(() => {
        const fp = marketplaceStats?.floorPrice ?? marketplaceStats?.floorPriceUSDC;
        const n = coerceNumber(fp);
        return Number.isFinite(n) && n > 0 ? n : null;
    }, [marketplaceStats]);

    const computeLiveFloor = useCallback(
        async () => {
            if (!provider || !listings?.length) {
                setDerivedFloor(null);
                return;
            }
            setFloorLoading(true);
            setFloorSource('live');
            try {
                const sample = listings
                    .filter((l) => l?.pricePerUnit && l?.paymentToken)
                    .slice(0, 80);

                const results = await Promise.allSettled(
                    sample.map((l) => convertToUSDCValue(l.pricePerUnit, l.paymentToken, provider))
                );

                const values = results
                    .map((r) => (r.status === 'fulfilled' ? Number(r.value) : NaN))
                    .filter((v) => Number.isFinite(v) && v > 0);

                setDerivedFloor(values.length ? Math.min(...values) : null);
            } catch {
                setDerivedFloor(null);
            } finally {
                setFloorLoading(false);
            }
        },
        [provider, listings]
    );

    // Compute on mount & when listings change (only if no valid stat)
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (floorFromStats) {
                if (!cancelled) {
                    setFloorSource('stat');
                    setDerivedFloor(null);
                    setFloorLoading(false);
                }
                return;
            }
            await computeLiveFloor();
        })();
        return () => {
            cancelled = true;
        };
    }, [floorFromStats, computeLiveFloor]);

    const floorUSDC = floorFromStats ?? derivedFloor;

    // Small counters
    const totalListingsAnim = useCountUp(totalListings);
    const totalVolumeAnim = useCountUp(Math.round(totalVolume));
    const currentVolAnim = useCountUp(Math.round(currentListingVolume));

    /* --------------------------
       NEXT-LEVEL: Market Insights
    --------------------------- */
    const [insights, setInsights] = useState({
        uniqueCollections: 0,
        uniqueSellers: 0,
        listings24h: 0,
        avgUSDC: null,
        maxUSDC: null,
    });
    const [insightsLoading, setInsightsLoading] = useState(false);

    const computeInsights = useCallback(async () => {
        if (!listings?.length) {
            setInsights({
                uniqueCollections: 0,
                uniqueSellers: 0,
                listings24h: 0,
                avgUSDC: null,
                maxUSDC: null,
            });
            return;
        }
        setInsightsLoading(true);
        try {
            // Unique collections and sellers
            const coll = new Set();
            const sellers = new Set();
            const now = Date.now();
            const cutoff = now - 24 * 60 * 60 * 1000;
            let cnt24h = 0;

            for (const l of listings) {
                if (l?.nftContract) coll.add(l.nftContract.toLowerCase());
                if (l?.seller) sellers.add(l.seller.toLowerCase());
                const ts = coerceMs(l.createdAt) ?? coerceMs(l.created_at) ?? coerceMs(l.timestamp) ?? coerceMs(l.time) ?? coerceMs(l.blockTimestamp) ?? coerceMs(l.listedAt);
                if (Number.isFinite(ts) && ts >= cutoff) cnt24h++;
            }

            // Price stats (USDC)
            let avg = null, max = null;
            if (provider) {
                const sample = listings
                    .filter((l) => l?.pricePerUnit && l?.paymentToken)
                    .slice(0, 100);

                const results = await Promise.allSettled(
                    sample.map((l) => convertToUSDCValue(l.pricePerUnit, l.paymentToken, provider))
                );

                const values = results
                    .map((r) => (r.status === 'fulfilled' ? Number(r.value) : NaN))
                    .filter((v) => Number.isFinite(v) && v > 0);

                if (values.length) {
                    const sum = values.reduce((a, b) => a + b, 0);
                    avg = sum / values.length;
                    max = Math.max(...values);
                }
            }

            setInsights({
                uniqueCollections: coll.size,
                uniqueSellers: sellers.size,
                listings24h: cnt24h,
                avgUSDC: avg,
                maxUSDC: max,
            });
        } finally {
            setInsightsLoading(false);
        }
    }, [listings, provider]);

    useEffect(() => {
        computeInsights().catch(() => { });
    }, [computeInsights]);

    /* --------------------------
       NEXT-LEVEL: Collection Leaderboard
    --------------------------- */
    const [collectionFloors, setCollectionFloors] = useState({});
    const [floorsLoading, setFloorsLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!provider || !trendingCollections.length) return;
            setFloorsLoading(true);
            try {
                const next = {};
                const top = trendingCollections.slice(0, 5);
                for (const t of top) {
                    const items = listings.filter((l) => (l?.nftContract || '').toLowerCase() === t.address).slice(0, 12);
                    const results = await Promise.allSettled(
                        items.map((l) => convertToUSDCValue(l.pricePerUnit, l.paymentToken, provider))
                    );
                    const vals = results
                        .map((r) => (r.status === 'fulfilled' ? Number(r.value) : NaN))
                        .filter((v) => Number.isFinite(v) && v > 0);
                    next[t.address] = vals.length ? Math.min(...vals) : null;
                }
                if (!cancelled) setCollectionFloors(next);
            } finally {
                if (!cancelled) setFloorsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [provider, trendingCollections, listings]);

    /* --------------------------
       Token breakdown (by payment token)
       - Per-token USDC volume, count, and native token total
    --------------------------- */
    const [tokenStats, setTokenStats] = useState({ list: [], totalUSDC: 0 });
    const [tokenStatsLoading, setTokenStatsLoading] = useState(false);

    const computeTokenStats = useCallback(async () => {
        if (!provider || !listings?.length) {
            setTokenStats({ list: [], totalUSDC: 0 });
            return;
        }
        setTokenStatsLoading(true);
        try {
            const sample = listings.filter((l) => l?.pricePerUnit && l?.paymentToken);
            const uniqTokens = Array.from(new Set(sample.map((l) => (l.paymentToken || ethers.ZeroAddress).toLowerCase())));

            // Resolve token meta (symbol/decimals)
            const metaEntries = await Promise.all(uniqTokens.map(async (addr) => {
                try {
                    const meta = await fetchTokenDetails(addr, provider);
                    return [addr, { symbol: meta?.symbol || getTokenSymbol(addr), decimals: Number(meta?.decimals ?? 18) }];
                } catch {
                    return [addr, { symbol: getTokenSymbol(addr), decimals: 18 }];
                }
            }));
            const metaMap = Object.fromEntries(metaEntries);

            // Convert all to USDC
            const conv = await Promise.allSettled(sample.map((l) =>
                convertToUSDCValue(l.pricePerUnit, l.paymentToken, provider)
            ));

            const byToken = new Map();
            let grand = 0;

            for (let i = 0; i < sample.length; i++) {
                const l = sample[i];
                const tokenAddr = (l.paymentToken || ethers.ZeroAddress).toLowerCase();
                const meta = metaMap[tokenAddr] || { symbol: getTokenSymbol(tokenAddr), decimals: 18 };
                const usdc = conv[i].status === 'fulfilled' ? Number(conv[i].value) : 0;
                const tokenAmount = Number(ethers.formatUnits(l.pricePerUnit, meta.decimals));

                if (!byToken.has(tokenAddr)) {
                    byToken.set(tokenAddr, {
                        address: tokenAddr,
                        symbol: meta.symbol,
                        decimals: meta.decimals,
                        count: 0,
                        usdcTotal: 0,
                        tokenTotal: 0,
                        minUSDC: Number.POSITIVE_INFINITY,
                        maxUSDC: 0,
                    });
                }
                const entry = byToken.get(tokenAddr);
                entry.count += 1;
                entry.usdcTotal += usdc;
                entry.tokenTotal += tokenAmount;
                if (usdc > 0) {
                    if (usdc < entry.minUSDC) entry.minUSDC = usdc;
                    if (usdc > entry.maxUSDC) entry.maxUSDC = usdc;
                }
                grand += usdc;
            }

            const list = Array.from(byToken.values())
                .map((x) => ({
                    ...x,
                    minUSDC: Number.isFinite(x.minUSDC) ? x.minUSDC : 0,
                    avgUSDC: x.count > 0 ? x.usdcTotal / x.count : 0,
                }))
                .sort((a, b) => b.usdcTotal - a.usdcTotal);

            setTokenStats({ list, totalUSDC: grand });
        } catch {
            setTokenStats({ list: [], totalUSDC: 0 });
        } finally {
            setTokenStatsLoading(false);
        }
    }, [provider, listings]);

    useEffect(() => {
        computeTokenStats().catch(() => { });
    }, [computeTokenStats]);

    // ----- Featured listings -----
    const renderFeaturedListings = () => {
        if (!isInitialized) {
            return <LoadingSkeleton type="card" count={3} className="grid" />;
        }

        if (!hotListings || hotListings.length === 0) {
            return (
                <EmptyState
                    icon="✨"
                    title="No Featured Listings (yet)"
                    description="Check back soon for exciting drops and curated collections."
                    actionText="Explore Marketplace"
                    onAction={() => (window.location.href = '/marketplace')}
                    secondaryActionText="List Your NFT"
                    onSecondaryAction={() => (window.location.href = '/sell')}
                />
            );
        }

        return (
            <div className="hp-featured-grid">
                {hotListings.slice(0, 3).map((listing) => (
                    <ListingCard key={listing.id} listing={listing} featured />
                ))}
            </div>
        );
    };

    // Lucky pick handler (fun)
    const openLuckyCollection = () => {
        const pool = listings || [];
        if (!pool.length) return;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        const addr = (pick?.nftContract || '').toLowerCase();
        if (addr) window.location.href = `/collections/${addr}`;
    };

    return (
        <div className="hp">
            {/* HERO */}
            <section className="hp-hero">
                <div className="hp-hero__bg" aria-hidden />
                <div className="hp-hero__content">
                    <h1>
                        Trade in the <span className="hp-glow">neon shadows</span>.
                        <br /> Own the <span className="hp-glow-2">future</span>.
                    </h1>
                    <p className="hp-subtitle">
                        BlockDust is a fast, gas-light NFT marketplace on Vitruveo. Discover rare mints,
                        support creators, and flip collectibles—safely and in style.
                    </p>
                    <div className="hp-cta">
                        <Link to="/marketplace" className="hp-btn hp-btn--primary">Explore NFTs</Link>
                        <Link to="/sell" className="hp-btn">List Your NFT</Link>
                        <Link to="/auctions/create" className="hp-btn">Create Auction</Link>
                        <button type="button" className="hp-btn hp-btn--ghost hp-btn--lucky" onClick={openLuckyCollection} title="Warp to a random collection">
                            ✨ Lucky Jump
                        </button>
                    </div>

                    {/* Quick mini-stats */}
                    <div className="hp-mini">
                        <div className="hp-mini__card" title="Total live listings">
                            <div className="hp-mini__label">Active Listings</div>
                            <div className="hp-mini__value">{totalListingsAnim.toLocaleString()}</div>
                        </div>

                        <div className="hp-mini__card" title="All-time market volume (USDC)">
                            <div className="hp-mini__label">Market Volume</div>
                            <div className="hp-mini__value">{formatUSD(totalVolumeAnim)}</div>
                        </div>

                        <div className="hp-mini__card" title="Sum of current listing prices (USDC)">
                            <div className="hp-mini__label">Live Listing Value</div>
                            <div className="hp-mini__value">{formatUSD(currentVolAnim)}</div>
                        </div>

                        <div
                            className="hp-mini__card hp-mini__card--floor"
                            title="Lowest active listing price across the market (USDC)"
                        >
                            <div className="hp-mini__label">
                                Floor (USDC)
                                <span
                                    className={`hp-badge hp-badge--${floorFromStats ? 'stat' : 'live'}`}
                                    aria-label={`Floor source: ${floorFromStats ? 'Stat' : 'Live'}`}
                                    title={`Source: ${floorFromStats ? 'Backend stat' : 'Derived from listings'}`}
                                >
                                    {floorFromStats ? 'Stat' : 'Live'}
                                </span>
                                <button
                                    className="hp-mini__refresh"
                                    onClick={computeLiveFloor}
                                    type="button"
                                    title="Recalculate live floor"
                                >
                                    ↻
                                </button>
                            </div>
                            <div className="hp-mini__value">
                                {floorLoading ? '…' : formatUSD(floorUSDC)}
                            </div>
                        </div>
                    </div>

                    {status && <div className="hp-status">{status}</div>}
                </div>
            </section>

            {/* FEATURED */}
            <section className="hp-featured">
                <div className="hp-section__head">
                    <h2>Featured Listings</h2>
                    <Link to="/hot-listings" className="hp-link">View all →</Link>
                </div>
                {renderFeaturedListings()}
            </section>

            {/* LIVE AUCTIONS */}
            <section className="hp-featured">
                <div className="hp-section__head">
                    <h2>Live Auctions</h2>
                    <Link to="/my-auctions" className="hp-link">View all →</Link>
                </div>
                {isAuctionsLoading ? (
                    <LoadingSkeleton type="card" count={3} className="grid" />
                ) : auctions.length > 0 ? (
                    <div className="hp-featured-grid">
                        {auctions.slice(0, 3).map((auction) => {
                            const endMs = auction.endTime || 0;
                            const endsIn = endMs ? timeLeft(endMs) : '—';
                            const hasBid = ethers.getBigInt(auction.highestBid || 0) > 0n;
                            const price = hasBid ? auction.highestBid : auction.startPrice;
                            const title = auction.name || `#${auction.tokenId}`;
                            
                            return (
                                <Link
                                    key={auction.id}
                                    to={`/auctions/${auction.id}`}
                                    className="auction-preview-card"
                                    style={{
                                        display: 'block',
                                        padding: '1rem',
                                        borderRadius: '12px',
                                        background: 'var(--hp-card-bg)',
                                        border: '1px solid var(--hp-border)',
                                        textDecoration: 'none',
                                        color: 'inherit',
                                        transition: 'all 0.2s ease',
                                        position: 'relative'
                                    }}
                                >
                                    <div style={{
                                        position: 'absolute',
                                        top: '8px',
                                        right: '8px',
                                        background: 'linear-gradient(45deg, #ff6b35, #f7931e)',
                                        color: 'white',
                                        fontSize: '11px',
                                        fontWeight: '600',
                                        padding: '4px 8px',
                                        borderRadius: '6px',
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.5px'
                                    }}>
                                        AUCTION
                                    </div>
                                    <div style={{
                                        width: '100%',
                                        height: '200px',
                                        borderRadius: '8px',
                                        background: auction.image ? `url(${auction.image})` : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                                        backgroundSize: 'cover',
                                        backgroundPosition: 'center',
                                        marginBottom: '12px'
                                    }} />
                                    <h4 style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: '600' }}>{title}</h4>
                                    <div style={{ fontSize: '14px', color: 'var(--hp-muted)', marginBottom: '12px' }}>
                                        Collection: {shortAddr(auction.nftContract)}
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <div style={{ fontSize: '12px', color: 'var(--hp-muted)' }}>
                                                {hasBid ? 'Highest Bid' : 'Starting Bid'}
                                            </div>
                                            <div style={{ fontWeight: '600', color: 'var(--hp-accent)' }}>
                                                {fmtToken(parseFloat(ethers.formatEther(price)))} VTRU
                                            </div>
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontSize: '12px', color: 'var(--hp-muted)' }}>Ends In</div>
                                            <div style={{ fontWeight: '600', color: 'var(--hp-accent)' }}>{endsIn}</div>
                                        </div>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                ) : (
                    <EmptyState
                        icon="🏷️"
                        title="No Live Auctions"
                        description="Create or participate in auctions to see them here."
                        actionText="Create Auction"
                        onAction={() => (window.location.href = '/auctions/create')}
                        secondaryActionText="View All Auctions"
                        onSecondaryAction={() => (window.location.href = '/my-auctions')}
                    />
                )}
            </section>

            {/* NEXT-LEVEL: MARKET INSIGHTS */}
            <section className="hp-insights">
                <div className="hp-section__head">
                    <h2>Market Insights</h2>
                    <span className="hp-hint">auto-derived from live listings</span>
                </div>
                <div className="hp-insights__grid">
                    <div className="hp-insight">
                        <div className="hp-insight__label">Unique Collections</div>
                        <div className="hp-insight__value">{insights.uniqueCollections.toLocaleString()}</div>
                    </div>
                    <div className="hp-insight">
                        <div className="hp-insight__label">Unique Sellers</div>
                        <div className="hp-insight__value">{insights.uniqueSellers.toLocaleString()}</div>
                    </div>
                    <div className="hp-insight">
                        <div className="hp-insight__label">New Listings (24h)</div>
                        <div className="hp-insight__value">{insights.listings24h.toLocaleString()}</div>
                    </div>
                    <div className="hp-insight">
                        <div className="hp-insight__label">Avg Listing (USDC)</div>
                        <div className="hp-insight__value">{insightsLoading ? '…' : formatUSD(insights.avgUSDC)}</div>
                    </div>
                    <div className="hp-insight">
                        <div className="hp-insight__label">Highest Listing (USDC)</div>
                        <div className="hp-insight__value">{insightsLoading ? '…' : formatUSD(insights.maxUSDC)}</div>
                    </div>
                    <div className="hp-insight hp-insight--accent">
                        <div className="hp-insight__label">Global Floor (USDC)</div>
                        <div className="hp-insight__value">{floorLoading ? '…' : formatUSD(floorUSDC)}</div>
                    </div>
                </div>
            </section>

            {/* TOKEN BREAKDOWN */}
            <section className="hp-insights">
                <div className="hp-section__head">
                    <h2>Token Stats</h2>
                    <span className="hp-hint">USDC volume by payment token</span>
                </div>
                {tokenStatsLoading ? (
                    <LoadingSkeleton type="card" count={6} className="grid" />
                ) : tokenStats.list.length === 0 ? (
                    <EmptyState
                        icon="🪙"
                        title="No token activity yet"
                        description="When listings appear, the token breakdown will light up here."
                        actionText="Explore Marketplace"
                        onAction={() => (window.location.href = '/marketplace')}
                    />
                ) : (
                    <div className="hp-insights__grid">
                        <div className="hp-insight hp-insight--accent" title="Total USDC volume across all payment tokens">
                            <div className="hp-insight__label">Total USDC Volume</div>
                            <div className="hp-insight__value">{formatUSD(tokenStats.totalUSDC)}</div>
                        </div>
                        {tokenStats.list.slice(0, 11).map((t) => {
                            const pct = tokenStats.totalUSDC > 0 ? (t.usdcTotal / tokenStats.totalUSDC) * 100 : 0;
                            return (
                                <div key={t.address} className="hp-insight" title={`${t.symbol} • ${shortAddr(t.address)}`}>
                                    <div className="hp-insight__label">
                                        <strong>{t.symbol}</strong> <span className="hp-hint">({shortAddr(t.address)})</span>
                                    </div>
                                    <div className="hp-insight__value">{formatUSD(t.usdcTotal)}</div>
                                    <div className="hp-hint">
                                        {fmtToken(t.tokenTotal)} {t.symbol} • {t.count} listings • {pct.toFixed(1)}%
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* TRENDING COLLECTIONS */}
            <section className="hp-trending">
                <div className="hp-section__head">
                    <h2>Trending Collections</h2>
                    <Link to="/collections" className="hp-link">View all →</Link>
                </div>
                {!isInitialized ? (
                    <LoadingSkeleton type="card" count={6} className="grid" />
                ) : trendingCollections.length === 0 ? (
                    <EmptyState
                        icon="🔥"
                        title="No trending collections yet"
                        description="As listings pick up, you’ll see hot collections here."
                        actionText="Explore Marketplace"
                        onAction={() => (window.location.href = '/marketplace')}
                    />
                ) : (
                    <div className="hp-trending__grid">
                        {trendingCollections.map((t) => {
                            const img =
                                t.sample?.image ||
                                t.sample?.imageUrl ||
                                t.sample?.metadata?.image ||
                                t.sample?.metadata?.image_url ||
                                '';
                            const floor = collectionFloors[t.address];
                            return (
                                <Link to={`/collections/${t.address}`} className="hp-trend" key={t.address}>
                                    <div className="hp-trend__img" style={{ backgroundImage: `url(${img})` }} />
                                    <div className="hp-trend__info">
                                        <strong className="hp-trend__name">{labelFor(t.address)}</strong>
                                        <span className="hp-trend__meta">
                                            {t.count} listing{t.count === 1 ? '' : 's'}
                                            <span className="hp-dot">•</span>
                                            Floor: {floorsLoading ? '…' : formatUSD(floor)}
                                        </span>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* LATEST LISTINGS */}
            <section className="hp-latest">
                <div className="hp-section__head">
                    <h2>Latest Listings</h2>
                    <Link to="/marketplace" className="hp-link">Explore marketplace →</Link>
                </div>
                {!isInitialized ? (
                    <LoadingSkeleton type="card" count={8} className="grid" />
                ) : listings.length === 0 ? (
                    <EmptyState
                        icon="🛍️"
                        title="Nothing listed yet"
                        description="Be the first to mint the moment. Your next 1/1 is waiting."
                        actionText="List yours"
                        onAction={() => (window.location.href = '/sell')}
                    />
                ) : (
                    <div className="hp-latest__grid">
                        {listings.slice(0, 8).map((l) => (
                            <ListingCard key={l.id} listing={l} />
                        ))}
                    </div>
                )}
            </section>

            {/* ACTIVITY TICKER */}
            {activity.length > 0 && (
                <section className="hp-activity" aria-label="Recent marketplace activity">
                    <div className="hp-section__head">
                        <h2>Live Activity</h2>
                        <span className="hp-pulse">• live</span>
                    </div>

                    {/* force animation on */}
                    <div className="hp-ticker" data-animate="true" style={{ '--hp-speed': '22s' }}>
                        <div className="hp-ticker__track">
                            {[...activity, ...activity].map((a, i) => (
                                <div className="hp-ticker__item" key={`${a.id}-${i}`}>
                                    <div
                                        className="hp-ticker__img"
                                        style={{ backgroundImage: `url(${a.image || ''})` }}
                                    />
                                    <div className="hp-ticker__text">
                                        <strong>{a.name}</strong>
                                        <span> #{String(a.tokenId)}</span>
                                        <span className="hp-dot">•</span>
                                        <span className="hp-mono">{labelFor(a.nftContract)}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            )}

            {/* HOW IT WORKS */}
            <section className="hp-how">
                <h2>How it works</h2>
                <div className="hp-steps">
                    <div className="hp-step">
                        <div className="hp-step__num">1</div>
                        <h3>Connect Wallet</h3>
                        <p>Link MetaMask (Vitruveo 1490 / 0x5d2) or a compatible wallet.</p>
                    </div>
                    <div className="hp-step">
                        <div className="hp-step__num">2</div>
                        <h3>Discover</h3>
                        <p>Explore curated drops, trending collections, and rare mints.</p>
                    </div>
                    <div className="hp-step">
                        <div className="hp-step__num">3</div>
                        <h3>Trade</h3>
                        <p>Buy or list instantly with low fees and clear USDC pricing.</p>
                    </div>
                </div>
            </section>

            {/* CTA */}
            <section className="hp-cta">
                <div className="hp-cta__card">
                    <h3>Ready to list?</h3>
                    <p>Creators keep more. Collectors pay less. Everyone wins.</p>
                    <div className="hp-cta__actions">
                        <Link to="/sell" className="hp-btn hp-btn--primary">Create a Listing</Link>
                        <Link to="/profile" className="hp-btn hp-btn--ghost">View Your Profile</Link>
                    </div>
                </div>
            </section>
        </div>
    );
}

export default HomePage;