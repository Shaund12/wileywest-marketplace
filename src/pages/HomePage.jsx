// HomePage.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { convertToUSDCValue } from '../utils/tokenUtils';
import ListingCard from '../components/ListingCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
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
    } = useMarketplace();

    const { provider } = useWallet();

    // Ensure data on cold landings
    useEffect(() => {
        if (!isInitialized && typeof fetchListings === 'function') {
            fetchListings().catch(() => { });
        }
    }, [isInitialized, fetchListings]);

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
                            return (
                                <Link to={`/collections/${t.address}`} className="hp-trend" key={t.address}>
                                    <div className="hp-trend__img" style={{ backgroundImage: `url(${img})` }} />
                                    <div className="hp-trend__info">
                                        <strong className="hp-trend__name">{labelFor(t.address)}</strong>
                                        <span className="hp-trend__meta">
                                            {t.count} listing{t.count === 1 ? '' : 's'}
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
