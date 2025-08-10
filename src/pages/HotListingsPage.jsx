import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';

import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import ListingCard from '../components/ListingCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
import './HotListingsPage.css';

/* ================================
   Minimal ABIs + Interface IDs
   ================================ */
const COLLECTION_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)'
];
const INTERFACE_ID_ERC721 = '0x80ac58cd';
const INTERFACE_ID_ERC1155 = '0xd9b67a26';

/* ================================
   Small helpers
   ================================ */
const short = (a) => (a && a.length > 9 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '—');
const isBrowser = typeof window !== 'undefined';
const byCountDesc = (a, b, map) => map[b].items.length - map[a].items.length;

/* ================================
   Background particles (SSR-safe)
   ================================ */
function createParticles(canvas) {
    if (!isBrowser || !canvas) return () => { };
    const ctx = canvas.getContext('2d');
    let raf = null;

    const resize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    resize();

    const colors = ['#ff3366', '#5533ff', '#33ccff'];
    const count = Math.min(80, Math.max(50, Math.floor((canvas.width * canvas.height) / 85000)));
    const particles = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 2 + 0.6,
        c: colors[(Math.random() * colors.length) | 0],
        vx: Math.random() * 0.9 - 0.45,
        vy: Math.random() * 0.9 - 0.45,
        a: Math.random() * 0.5 + 0.15,
    }));

    const draw = () => {
        raf = requestAnimationFrame(draw);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of particles) {
            const aHex = Math.round(p.a * 255).toString(16).padStart(2, '0');
            ctx.fillStyle = `${p.c}${aHex}`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();

            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0) p.x = canvas.width;
            if (p.x > canvas.width) p.x = 0;
            if (p.y < 0) p.y = canvas.height;
            if (p.y > canvas.height) p.y = 0;
        }
    };

    raf = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    return () => {
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
    };
}

/* ================================
   Caches
   ================================ */
const collectionDetailsCache = Object.create(null);

/* ================================
   Page Component
   ================================ */
export default function HotListingsPage() {
    const navigate = useNavigate();
    const { hotListings = [], fetchListings } = useMarketplace();
    const { provider } = useWallet();

    const canvasRef = useRef(null);
    const [grouped, setGrouped] = useState({});
    const [order, setOrder] = useState([]);
    const [loading, setLoading] = useState(true);
    const [initialized, setInitialized] = useState(false);

    /* UI controls */
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('count'); // 'count' | 'name' | 'type'
    const [expanded, setExpanded] = useState(() => new Set()); // expanded collection addresses

    /* Particles boot */
    useEffect(() => createParticles(canvasRef.current), []);

    /* Ensure we have data */
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                setLoading(true);
                await fetchListings?.();
            } finally {
                if (alive) setInitialized(true);
            }
        })();
        return () => { alive = false; };
    }, [fetchListings]);

    /* Fetch collection details (safe + cached) */
    const fetchCollectionDetails = useCallback(
        async (addr) => {
            if (!addr) return { name: 'Unknown Collection', symbol: '', type: 'Unknown', address: '' };
            const key = addr.toLowerCase();
            if (collectionDetailsCache[key]) return collectionDetailsCache[key];

            if (!provider) {
                const fallback = { name: `Collection ${short(addr)}`, symbol: '', type: 'Unknown', address: addr };
                collectionDetailsCache[key] = fallback;
                return fallback;
            }

            try {
                const c = new ethers.Contract(addr, COLLECTION_ABI, provider);

                let is721 = false, is1155 = false;
                try { is721 = await c.supportsInterface(INTERFACE_ID_ERC721); } catch { }
                if (!is721) { try { is1155 = await c.supportsInterface(INTERFACE_ID_ERC1155); } catch { } }

                let name = '', symbol = '';
                try { name = await c.name(); } catch { }
                try { symbol = await c.symbol(); } catch { }

                const d = {
                    name: name || `Collection ${short(addr)}`,
                    symbol: symbol || '',
                    type: is721 ? 'ERC721' : is1155 ? 'ERC1155' : 'Unknown',
                    address: addr,
                };
                collectionDetailsCache[key] = d;
                return d;
            } catch {
                const fallback = { name: `Collection ${short(addr)}`, symbol: '', type: 'Unknown', address: addr };
                collectionDetailsCache[key] = fallback;
                return fallback;
            }
        },
        [provider]
    );

    /* Group + order listings */
    useEffect(() => {
        let alive = true;
        (async () => {
            setLoading(true);
            try {
                const map = Object.create(null);
                const addresses = Array.from(new Set(hotListings.map((l) => l?.nftContract).filter(Boolean)));

                const details = await Promise.all(addresses.map((a) => fetchCollectionDetails(a)));
                const headerMap = details.reduce((acc, d, i) => (acc[addresses[i]] = d, acc), Object.create(null));

                for (const l of hotListings) {
                    const addr = l?.nftContract;
                    if (!addr) continue;
                    if (!map[addr]) map[addr] = { ...headerMap[addr], items: [] };
                    map[addr].items.push(l);
                }

                // default order by item count desc
                let ord = Object.keys(map).sort((a, b) => byCountDesc(a, b, map));

                if (!alive) return;
                setGrouped(map);
                setOrder(ord);
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [hotListings, fetchCollectionDetails]);

    /* Derived: filtered + sorted order */
    const filteredOrder = useMemo(() => {
        let ord = order.slice();
        if (search.trim()) {
            const q = search.trim().toLowerCase();
            ord = ord.filter((addr) => {
                const c = grouped[addr];
                return (
                    c?.name?.toLowerCase().includes(q) ||
                    c?.symbol?.toLowerCase().includes(q) ||
                    addr.toLowerCase().includes(q)
                );
            });
        }
        if (sort === 'name') {
            ord.sort((a, b) => (grouped[a].name || '').localeCompare(grouped[b].name || ''));
        } else if (sort === 'type') {
            const rank = (t) => (t === 'ERC721' ? 0 : t === 'ERC1155' ? 1 : 2);
            ord.sort((a, b) => rank(grouped[a].type) - rank(grouped[b].type));
        } else {
            ord.sort((a, b) => byCountDesc(a, b, grouped));
        }
        return ord;
    }, [order, grouped, search, sort]);

    /* Expand/collapse handlers */
    const toggleExpand = useCallback((addr) => {
        setExpanded((prev) => {
            const n = new Set(prev);
            if (n.has(addr)) n.delete(addr); else n.add(addr);
            return n;
        });
    }, []);

    /* Render one collection section */
    const renderCollection = useCallback((addr) => {
        const col = grouped[addr];
        if (!col) return null;
        const open = expanded.has(addr);
        const badge = col.symbol || 'Featured';
        const items = open ? col.items : col.items.slice(0, 6);

        return (
            <section key={addr} className="collection-section">
                <header className="collection-header">
                    <div className="collection-header-left">
                        <h2 title={col.name}>{col.name}</h2>
                        {col.symbol && <span className="collection-symbol">{col.symbol}</span>}
                        {col.type !== 'Unknown' && <span className="collection-type">{col.type}</span>}

                        <button
                            className="copy-addr"
                            onClick={() => navigator.clipboard?.writeText(addr)}
                            title="Copy contract address"
                            type="button"
                        >
                            {short(addr)}
                        </button>
                    </div>

                    <div className="collection-right">
                        <span className="collection-count">{col.items.length} items</span>
                        <button
                            className="toggle-btn"
                            onClick={() => toggleExpand(addr)}
                            type="button"
                        >
                            {open ? 'Collapse' : 'Expand'}
                        </button>
                    </div>
                </header>

                <div className="listings-grid featured">
                    {items.map((listing, i) => (
                        <div className="listing-wrapper" style={{ '--item-index': i }} key={listing?.id ?? `${addr}-${listing?.tokenId}-${i}`}>
                            <div className="hot-badge">
                                <span className="fire-emoji">🔥</span> {badge}
                            </div>
                            <ListingCard listing={listing} featured />
                        </div>
                    ))}
                </div>

                {!open && col.items.length > 6 && (
                    <div className="collection-footer">
                        <button className="hp-btn hp-btn--primary" onClick={() => toggleExpand(addr)} type="button">
                            Show more
                        </button>
                    </div>
                )}
            </section>
        );
    }, [grouped, expanded, toggleExpand]);

    return (
        <div className="hot-listings-container organized">
            <canvas ref={canvasRef} className="particles-bg" aria-hidden />

            <div className="page-header">
                <h1><span className="fire-emoji">🔥</span> Premium Listings</h1>
                <p>Curated collections of exclusive digital assets from verified creators.</p>

                <div className="toolbar">
                    <div className="toolbar-left">
                        <input
                            type="search"
                            placeholder="Search collections or contract addresses..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="toolbar-search"
                        />
                    </div>
                    <div className="toolbar-right">
                        <label className="sr-only" htmlFor="sortSel">Sort</label>
                        <select
                            id="sortSel"
                            className="toolbar-sort"
                            value={sort}
                            onChange={(e) => setSort(e.target.value)}
                        >
                            <option value="count">Most items</option>
                            <option value="name">Name (A→Z)</option>
                            <option value="type">Type (ERC721/1155)</option>
                        </select>

                        <button className="hp-btn" onClick={() => navigate('/marketplace')} type="button">
                            Explore Marketplace
                        </button>
                        <button className="hp-btn hp-btn--primary" onClick={() => navigate('/sell')} type="button">
                            List Your NFT
                        </button>
                    </div>
                </div>
            </div>

            <div className="collections-container">
                {loading && !initialized ? (
                    <LoadingSkeleton type="card" count={6} className="grid" />
                ) : filteredOrder.length ? (
                    filteredOrder.map(renderCollection)
                ) : (
                    <EmptyState
                        icon="🔥"
                        title="No Premium Listings Yet"
                        description="Premium collections will appear here when they become available. Be the first to discover exclusive NFT drops!"
                        actionText="Explore Marketplace"
                        onAction={() => navigate('/marketplace')}
                        secondaryActionText="List Your NFT"
                        onSecondaryAction={() => navigate('/sell')}
                    />
                )}
            </div>
        </div>
    );
}
