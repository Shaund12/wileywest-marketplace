import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import ListingCard from '../components/ListingCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
import { convertToUSDCValue } from '../utils/tokenUtils';
import './HotListingsPage.css';

/* ---------- Minimal collection ABI ---------- */
const COLLECTION_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
];

const IFACE_ERC721 = '0x80ac58cd';
const IFACE_ERC1155 = '0xd9b67a26';

/* ---------- Helpers / caches ---------- */
const norm = (a) => (a ? a.toLowerCase() : '');
const short = (a) => (a && a.length > 9 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '—');
const collectionDetailsCache = Object.create(null);

function useDebouncedValue(value, delay = 250) {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return v;
}

/* ---------- Subtle particles (perf-friendly) ---------- */
function createParticles(canvas) {
    if (!canvas || typeof window === 'undefined') return () => { };
    const ctx = canvas.getContext('2d');
    let raf = 0;

    const resize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    resize();

    const colors = ['#ff3366', '#5533ff', '#33ccff'];
    const count = Math.min(90, Math.max(50, Math.floor((canvas.width * canvas.height) / 90000)));
    const parts = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 2 + 0.6,
        c: colors[(Math.random() * colors.length) | 0],
        vx: (Math.random() - 0.5) * 0.7,
        vy: (Math.random() - 0.5) * 0.7,
        a: Math.random() * 0.45 + 0.15,
    }));

    const loop = () => {
        raf = requestAnimationFrame(loop);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of parts) {
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

    raf = requestAnimationFrame(loop);
    window.addEventListener('resize', resize);
    return () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
    };
}

/* =======================================================
   HotListingsPage
======================================================= */
export default function HotListingsPage() {
    const navigate = useNavigate();
    const { hotListings = [], fetchListings } = useMarketplace();
    const { provider } = useWallet();

    const canvasRef = useRef(null);
    const fetchedOnceRef = useRef(false);

    const [pageLoading, setPageLoading] = useState(true);
    const [collectionsLoading, setCollectionsLoading] = useState(true);

    // normalizedKey -> { name, symbol, type, address (original case), items[] }
    const [grouped, setGrouped] = useState({});
    const [order, setOrder] = useState([]); // array of normalized keys

    // UI state
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('count'); // count | name | type
    const [expanded, setExpanded] = useState(() => new Set()); // stores normalized keys
    const [page, setPage] = useState(1);
    const PAGE_SIZE = 6;

    // Lazy collection stats loaded only when expanded
    // normalizedKey -> { loading, floorUSDC, avgUSDC, count }
    const [stats, setStats] = useState({});

    /* Particles init */
    useEffect(() => createParticles(canvasRef.current), []);

    /* One-time fetch (prevents refresh loop) */
    useEffect(() => {
        if (fetchedOnceRef.current) return;
        fetchedOnceRef.current = true;
        (async () => {
            try {
                setPageLoading(true);
                await fetchListings?.();
            } finally {
                setPageLoading(false);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* Fetch collection details (memoized & cached). Uses ORIGINAL address for calls; cached by normalized key. */
    const fetchCollectionDetails = useCallback(
        async (addrOriginal) => {
            if (!addrOriginal) return { name: 'Unknown', symbol: '', type: 'Unknown', address: '' };
            const key = norm(addrOriginal);
            if (collectionDetailsCache[key]) return collectionDetailsCache[key];

            if (!provider) {
                const fallback = { name: `Collection ${short(addrOriginal)}`, symbol: '', type: 'Unknown', address: addrOriginal };
                collectionDetailsCache[key] = fallback;
                return fallback;
            }

            try {
                const c = new ethers.Contract(addrOriginal, COLLECTION_ABI, provider);
                let is721 = false,
                    is1155 = false;
                try {
                    is721 = await c.supportsInterface(IFACE_ERC721);
                } catch { }
                if (!is721) {
                    try {
                        is1155 = await c.supportsInterface(IFACE_ERC1155);
                    } catch { }
                }

                let name = '',
                    symbol = '';
                try {
                    name = await c.name();
                } catch { }
                try {
                    symbol = await c.symbol();
                } catch { }

                const d = {
                    name: name || `Collection ${short(addrOriginal)}`,
                    symbol: symbol || '',
                    type: is721 ? 'ERC721' : is1155 ? 'ERC1155' : 'Unknown',
                    address: addrOriginal,
                };
                collectionDetailsCache[key] = d;
                return d;
            } catch {
                const fallback = { name: `Collection ${short(addrOriginal)}`, symbol: '', type: 'Unknown', address: addrOriginal };
                collectionDetailsCache[key] = fallback;
                return fallback;
            }
        },
        [provider]
    );

    /* Group hotListings locally with normalized keys */
    useEffect(() => {
        let alive = true;
        (async () => {
            setCollectionsLoading(true);
            try {
                // map normalized -> first-seen original address
                const normToOrig = Object.create(null);
                for (const l of hotListings) {
                    const a = l?.nftContract;
                    if (!a) continue;
                    const k = norm(a);
                    if (!normToOrig[k]) normToOrig[k] = a;
                }

                const uniqOriginals = Object.values(normToOrig);
                const detailResults = await Promise.all(uniqOriginals.map(fetchCollectionDetails));
                const detailsByNorm = {};
                for (const d of detailResults) detailsByNorm[norm(d.address)] = d;

                const map = Object.create(null);
                for (const l of hotListings) {
                    const a = l?.nftContract;
                    if (!a) continue;
                    const k = norm(a);
                    if (!map[k]) map[k] = { ...detailsByNorm[k], items: [] };
                    map[k].items.push(l);
                }

                const ord = Object.keys(map).sort((a, b) => map[b].items.length - map[a].items.length);
                if (!alive) return;
                setGrouped(map);
                setOrder(ord);
                setPage(1);
            } finally {
                if (alive) setCollectionsLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [hotListings, fetchCollectionDetails]);

    /* Debounced search + sort + paginate */
    const query = useDebouncedValue(search, 200);
    const filteredOrder = useMemo(() => {
        let ord = order.slice();
        if (query.trim()) {
            const q = query.trim().toLowerCase();
            ord = ord.filter((k) => {
                const c = grouped[k];
                return c?.name?.toLowerCase().includes(q) || c?.symbol?.toLowerCase().includes(q) || c?.address?.toLowerCase().includes(q);
            });
        }
        if (sort === 'name') {
            ord.sort((a, b) => (grouped[a].name || '').localeCompare(grouped[b].name || ''));
        } else if (sort === 'type') {
            const rank = (t) => (t === 'ERC721' ? 0 : t === 'ERC1155' ? 1 : 2);
            ord.sort((a, b) => rank(grouped[a].type) - rank(grouped[b].type));
        } else {
            ord.sort((a, b) => grouped[b].items.length - grouped[a].items.length);
        }
        return ord;
    }, [order, grouped, query, sort]);

    const totalPages = Math.max(1, Math.ceil(filteredOrder.length / PAGE_SIZE));
    const visibleOrder = filteredOrder.slice(0, page * PAGE_SIZE);

    /* Lazy stats loader for a collection when expanded; keyed by normalized */
    const loadStats = useCallback(
        async (k) => {
            if (!provider || !k) return;
            setStats((s) => ({ ...s, [k]: { ...(s[k] || {}), loading: true } }));
            try {
                const items = grouped[k]?.items || [];
                if (!items.length) {
                    setStats((s) => ({ ...s, [k]: { loading: false, floorUSDC: 0, avgUSDC: 0, count: 0 } }));
                    return;
                }

                // limit conversion for perf
                const sample = items.slice(0, 20);
                const values = await Promise.all(sample.map((it) => convertToUSDCValue(it.pricePerUnit, it.paymentToken, provider).catch(() => 0)));
                const filtered = values.filter((v) => Number.isFinite(v) && v > 0);
                const floor = filtered.length ? Math.min(...filtered) : 0;
                const avg = filtered.length ? filtered.reduce((a, b) => a + b, 0) / filtered.length : 0;
                setStats((s) => ({ ...s, [k]: { loading: false, floorUSDC: floor, avgUSDC: avg, count: items.length } }));
            } catch {
                setStats((s) => ({
                    ...s,
                    [k]: { loading: false, floorUSDC: 0, avgUSDC: 0, count: (grouped[k]?.items || []).length },
                }));
            }
        },
        [provider, grouped]
    );

    const toggleExpand = useCallback(
        (k) => {
            setExpanded((prev) => {
                const n = new Set(prev);
                if (n.has(k)) {
                    n.delete(k);
                } else {
                    n.add(k);
                    if (!stats[k]) loadStats(k);
                }
                return n;
            });
        },
        [stats, loadStats]
    );

    /* ---------- Render helpers ---------- */
    const renderCollection = useCallback(
        (k) => {
            const col = grouped[k];
            if (!col) return null;

            const open = expanded.has(k);
            const items = open ? col.items : col.items.slice(0, 6);
            const badge = col.symbol || 'Featured';
            const st = stats[k];

            return (
                <section key={k} className="collection-section">
                    <header className="collection-header">
                        <div className="collection-header-left">
                            <h2 title={col.name}>{col.name}</h2>
                            {col.symbol && <span className="collection-symbol">{col.symbol}</span>}
                            {col.type !== 'Unknown' && <span className="collection-type">{col.type}</span>}
                            <button
                                className="copy-addr"
                                onClick={() => navigator.clipboard?.writeText(col.address)}
                                title="Copy contract address"
                                type="button"
                            >
                                {short(col.address)}
                            </button>
                        </div>

                        <div className="collection-right">
                            <div className="collection-metrics">
                                {st?.loading ? (
                                    <div className="metric shimmer" />
                                ) : (
                                    <>
                                        <div className="metric">
                                            <span className="metric-label">Floor</span>
                                            <span className="metric-value">${(st?.floorUSDC ?? 0).toFixed(2)}</span>
                                        </div>
                                        <div className="metric">
                                            <span className="metric-label">Avg</span>
                                            <span className="metric-value">${(st?.avgUSDC ?? 0).toFixed(2)}</span>
                                        </div>
                                        <div className="metric">
                                            <span className="metric-label">Items</span>
                                            <span className="metric-value">{st?.count ?? col.items.length}</span>
                                        </div>
                                    </>
                                )}
                            </div>

                            <button
                                className="toggle-btn"
                                onClick={() => toggleExpand(k)}
                                aria-expanded={open}
                                aria-controls={`section-${k}`}
                                type="button"
                            >
                                {open ? 'Collapse' : 'Expand'}
                            </button>
                        </div>
                    </header>

                    <div id={`section-${k}`} className="listings-grid featured">
                        {items.map((listing, i) => (
                            <div className="listing-wrapper" style={{ '--item-index': i }} key={listing?.id ?? `${k}-${listing?.tokenId}-${i}`}>
                                <div className="hot-badge">
                                    <span className="fire-emoji">🔥</span> {badge}
                                </div>
                                <ListingCard listing={listing} featured />
                            </div>
                        ))}
                    </div>

                    {!open && col.items.length > 6 && (
                        <div className="collection-footer">
                            <button className="hp-btn hp-btn--primary" onClick={() => toggleExpand(k)} type="button">
                                Show more
                            </button>
                        </div>
                    )}
                </section>
            );
        },
        [grouped, expanded, stats, toggleExpand]
    );

    /* ---------- JSX ---------- */
    const queryVal = useDebouncedValue(search, 150);

    return (
        <div className="hot-listings-container organized">
            <canvas ref={canvasRef} className="particles-bg" aria-hidden />

            <div className="page-header">
                <h1>
                    <span className="fire-emoji">🔥</span> Premium Listings
                </h1>
                <p>Curated collections of exclusive digital assets from verified creators.</p>

                <div className="toolbar">
                    <div className="toolbar-left">
                        <input
                            type="search"
                            placeholder="Search collections or contract addresses…"
                            value={search}
                            onChange={(e) => {
                                setSearch(e.target.value);
                                setPage(1);
                            }}
                            className="toolbar-search"
                            aria-label="Search collections"
                        />
                    </div>
                    <div className="toolbar-right">
                        <label className="sr-only" htmlFor="sortSel">
                            Sort
                        </label>
                        <select
                            id="sortSel"
                            className="toolbar-sort"
                            value={sort}
                            onChange={(e) => {
                                setSort(e.target.value);
                                setPage(1);
                            }}
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
                {pageLoading || collectionsLoading ? (
                    <LoadingSkeleton type="card" count={6} className="grid" />
                ) : visibleOrder.length ? (
                    <>
                        {visibleOrder.map(renderCollection)}
                        {page < totalPages && (
                            <div className="load-more">
                                <button className="hp-btn hp-btn--primary" onClick={() => setPage((p) => p + 1)} type="button">
                                    Load more collections
                                </button>
                            </div>
                        )}
                    </>
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
