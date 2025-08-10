import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMarketplace } from '../context/MarketplaceContext';
import ListingCard from '../components/ListingCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
import './HomePage.css';

function useCountUp(target = 0, duration = 900) {
    const [val, setVal] = useState(0);
    const rafRef = useRef();
    const startRef = useRef();

    useEffect(() => {
        cancelAnimationFrame(rafRef.current);
        const start = performance.now();
        startRef.current = start;

        const animate = (now) => {
            const p = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
            setVal(Math.floor(eased * target));
            if (p < 1) rafRef.current = requestAnimationFrame(animate);
        };
        rafRef.current = requestAnimationFrame(animate);

        return () => cancelAnimationFrame(rafRef.current);
    }, [target, duration]);

    return val;
}

function HomePage() {
    const {
        listings = [],
        hotListings = [],
        isInitialized,
        status,
        marketplaceStats = {},
        fetchListings,
    } = useMarketplace();

    // Make sure we have some data when landing directly on home
    useEffect(() => {
        if (!isInitialized && typeof fetchListings === 'function') {
            fetchListings().catch(() => { });
        }
    }, [isInitialized, fetchListings]);

    // Basic activity feed (lightweight + local)
    const activity = useMemo(() => {
        return (listings || [])
            .slice() // copy
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

    // Quick categories (link to marketplace and let its filters do the rest)
    const categories = [
        { id: 'art', label: '🎨 Art' },
        { id: 'collectibles', label: '🧩 Collectibles' },
        { id: 'photography', label: '📸 Photography' },
        { id: 'music', label: '🎵 Music' },
        { id: 'gaming', label: '🎮 Gaming' },
        { id: 'sports', label: '🏅 Sports' },
        { id: 'utility', label: '🛠️ Utility' },
    ];

    // Stats (with graceful fallback)
    const totalListings = Number(marketplaceStats?.totalListings ?? listings?.length ?? 0);
    const floorPrice = marketplaceStats?.floorPrice ? Number(marketplaceStats.floorPrice) : 0;
    const totalVolume = marketplaceStats?.totalVolume ? Number(marketplaceStats.totalVolume) : 0;
    const currentListingVolume = marketplaceStats?.currentListingVolume
        ? Number(marketplaceStats.currentListingVolume)
        : 0;

    const totalListingsAnim = useCountUp(totalListings);
    const totalVolumeAnim = useCountUp(Math.round(totalVolume));
    const currentVolAnim = useCountUp(Math.round(currentListingVolume));

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
                        <div className="hp-mini__card">
                            <div className="hp-mini__label">Active Listings</div>
                            <div className="hp-mini__value">{totalListingsAnim.toLocaleString()}</div>
                        </div>
                        <div className="hp-mini__card">
                            <div className="hp-mini__label">Market Volume</div>
                            <div className="hp-mini__value">${totalVolumeAnim.toLocaleString()}</div>
                        </div>
                        <div className="hp-mini__card">
                            <div className="hp-mini__label">Live Listing Value</div>
                            <div className="hp-mini__value">${currentVolAnim.toLocaleString()}</div>
                        </div>
                        <div className="hp-mini__card">
                            <div className="hp-mini__label">Floor (USDC)</div>
                            <div className="hp-mini__value">${floorPrice ? floorPrice.toFixed(2) : '0.00'}</div>
                        </div>
                    </div>

                    {status && <div className="hp-status">{status}</div>}
                </div>
            </section>

            {/* QUICK CATEGORIES */}
            <section className="hp-cats">
                <h2>Browse by Category</h2>
                <div className="hp-cats__grid">
                    {categories.map((c) => (
                        <Link
                            key={c.id}
                            to={`/marketplace?cat=${encodeURIComponent(c.id)}`}
                            className="hp-cat"
                        >
                            <span className="hp-cat__icon">{c.label.split(' ')[0]}</span>
                            <span className="hp-cat__label">{c.label.split(' ').slice(1).join(' ')}</span>
                        </Link>
                    ))}
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
                    <div className="hp-ticker">
                        <div className="hp-ticker__track">
                            {[...activity, ...activity].map((a, i) => (
                                <div className="hp-ticker__item" key={`${a.id}-${i}`}>
                                    <div className="hp-ticker__img" style={{ backgroundImage: `url(${a.image || ''})` }} />
                                    <div className="hp-ticker__text">
                                        <strong>{a.name}</strong>
                                        <span> #{String(a.tokenId)}</span>
                                        <span className="hp-dot">•</span>
                                        <span className="hp-mono">{a.nftContract?.slice(0, 6)}…{a.nftContract?.slice(-4)}</span>
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
