// src/pages/HotListingsPage.jsx
// Enhanced with Tailwind classes while preserving existing CSS and behavior.
// Uses <ListingCard /> for items (which now uses the same SmartImage loader as Marketplace).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
const statsCache = Object.create(null);

/* Concurrency-limited mapper (small + local) */
async function mapWithConcurrency(items, mapper, limit = 6) {
    const ret = new Array(items.length);
    let i = 0;
    let inFlight = 0;
    let resolve;
    const done = new Promise((r) => (resolve = r));
    function next() {
        while (inFlight < limit && i < items.length) {
            const idx = i++;
            inFlight++;
            Promise.resolve()
                .then(() => mapper(items[idx], idx))
                .then((val) => {
                    ret[idx] = val;
                })
                .catch(() => {
                    ret[idx] = undefined;
                })
                .finally(() => {
                    inFlight--;
                    if (i >= items.length && inFlight === 0) resolve();
                    else next();
                });
        }
    }
    next();
    await done;
    return ret;
}

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

/* ---------- Reveal on scroll (IntersectionObserver) ---------- */
function useReveal() {
    const containerRef = useRef(null);
    useEffect(() => {
        const root = containerRef.current;
        if (!root || typeof IntersectionObserver === 'undefined') return;
        const els = root.querySelectorAll('.reveal');
        const obs = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        e.target.classList.add('reveal--in');
                        obs.unobserve(e.target);
                    }
                }
            },
            { rootMargin: '0px 0px -10% 0px', threshold: 0.1 }
        );
        els.forEach((el) => obs.observe(el));
        return () => obs.disconnect();
    }, []);
    return containerRef;
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

    // normalizedKey -> { name, symbol, type, address (original), items[] }
    const [grouped, setGrouped] = useState({});
    the
    const [order, setOrder] = useState([]); // array of normalized keys

    // UI state
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('count'); // count | name | type | floor_low | floor_high | avg_high
    const [expanded, setExpanded] = useState({}); // { [normalizedKey]: true|false }
    const [page, setPage] = useState(1);
    const PAGE_SIZE = 6;

    // filter toggles
    const [filterType, setFilterType] = useState('any'); // any|ERC721|ERC1155
    const [minItems, setMinItems] = useState(0);

    // Lazy collection stats loaded only when expanded (cached across session)
    // normalizedKey -> { loading, floorUSDC, avgUSDC, count, ts }
    const [stats, setStats] = useState({});

    const explorerBase =
        (import.meta && import.meta.env && import.meta.env.VITE_BLOCK_EXPLORER) ||
        ''; // if you have one; else leave blank and we won't render explorer links

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

    /* Fetch collection details (memoized & cached) */
    const fetchCollectionDetails = useCallback(
        async (addrOriginal) => {
            if (!addrOriginal) return { name: 'Unknown', symbol: '', type: 'Unknown', address: '' };
            const key = norm(addrOriginal);
            if (collectionDetailsCache[key]) return collectionDetailsCache[key];

            if (!provider) {
                const fallback = {
                    name: `Collection ${short(addrOriginal)}`,
                    symbol: '',
                    type: 'Unknown',
                    address: addrOriginal,
                };
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
                const fallback = {
                    name: `Collection ${short(addrOriginal)}`,
                    symbol: '',
                    type: 'Unknown',
                    address: addrOriginal,
                };
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

    /* Debounced search */
    const query = useDebouncedValue(search, 200);

    /* Filter + sort + paginate list of collection keys */
    const filteredOrder = useMemo(() => {
        let ord = order.slice();

        // filter by search
        if (query.trim()) {
            const q = query.trim().toLowerCase();
            ord = ord.filter((k) => {
                const c = grouped[k];
                return c?.name?.toLowerCase().includes(q) || c?.symbol?.toLowerCase().includes(q) || c?.address?.toLowerCase().includes(q);
            });
        }

        // filter by type
        if (filterType !== 'any') {
            ord = ord.filter((k) => grouped[k]?.type === filterType);
        }

        // filter by min items
        if (minItems > 0) {
            ord = ord.filter((k) => (grouped[k]?.items?.length || 0) >= minItems);
        }

        // sort
        if (sort === 'name') {
            ord.sort((a, b) => (grouped[a].name || '').localeCompare(grouped[b].name || ''));
        } else if (sort === 'type') {
            const rank = (t) => (t === 'ERC721' ? 0 : t === 'ERC1155' ? 1 : 2);
            ord.sort((a, b) => rank(grouped[a].type) - rank(grouped[b].type));
        } else if (sort === 'floor_low' || sort === 'floor_high' || sort === 'avg_high') {
            // rely on cached stats if present; fall back to item count
            const getFloor = (k) => stats[k]?.floorUSDC ?? Number.POSITIVE_INFINITY;
            const getAvg = (k) => stats[k]?.avgUSDC ?? 0;
            const byFloorAsc = (a, b) => getFloor(a) - getFloor(b);
            const byFloorDesc = (a, b) => getFloor(b) - getFloor(a);
            const byAvgDesc = (a, b) => getAvg(b) - getAvg(a);

            if (sort === 'floor_low') ord.sort(byFloorAsc);
            else if (sort === 'floor_high') ord.sort(byFloorDesc);
            else ord.sort(byAvgDesc);
        } else {
            // count
            ord.sort((a, b) => grouped[b].items.length - grouped[a].items.length);
        }

        return ord;
    }, [order, grouped, query, sort, filterType, minItems, stats]);

    const totalPages = Math.max(1, Math.ceil(filteredOrder.length / PAGE_SIZE));
    const visibleOrder = filteredOrder.slice(0, page * PAGE_SIZE);

    /* Lazy stats loader (normalized key) with concurrency + cache */
    const loadStats = useCallback(
        async (k) => {
            if (!provider || !k) return;

            // cached?
            if (statsCache[k]) {
                setStats((s) => ({ ...s, [k]: { ...statsCache[k], loading: false } }));
                return;
            }

            setStats((s) => ({ ...s, [k]: { ...(s[k] || {}), loading: true } }));
            try {
                const items = grouped[k]?.items || [];
                if (!items.length) {
                    const payload = { loading: false, floorUSDC: 0, avgUSDC: 0, count: 0, ts: Date.now() };
                    statsCache[k] = payload;
                    setStats((s) => ({ ...s, [k]: payload }));
                    return;
                }

                // sample more generously; concurrency keeps it fast without hammering RPC
                const sample = items.slice(0, 40);
                const converted = await mapWithConcurrency(
                    sample,
                    (it) => convertToUSDCValue(it.pricePerUnit, it.paymentToken, provider).catch(() => 0),
                    6
                );
                const filtered = converted.filter((v) => Number.isFinite(v) && v > 0);
                const floor = filtered.length ? Math.min(...filtered) : 0;
                const avg = filtered.length ? filtered.reduce((a, b) => a + b, 0) / filtered.length : 0;
                const payload = { loading: false, floorUSDC: floor, avgUSDC: avg, count: items.length, ts: Date.now() };

                statsCache[k] = payload;
                setStats((s) => ({ ...s, [k]: payload }));
            } catch {
                const fallback = { loading: false, floorUSDC: 0, avgUSDC: 0, count: (grouped[k]?.items || []).length, ts: Date.now() };
                statsCache[k] = fallback;
                setStats((s) => ({ ...s, [k]: fallback }));
            }
        },
        [provider, grouped]
    );

    /* Expand/collapse (object map—robust) */
    const toggleExpand = useCallback(
        (k) => {
            setExpanded((prev) => {
                const next = { ...prev, [k]: !prev[k] };
                // if opening now, kick off stats
                if (!prev[k]) loadStats(k);
                return next;
            });
            // scroll into view when expanding
            const el = document.getElementById(`section-${k}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
        [loadStats]
    );

    /* Copy feedback (ARIA live region) */
    const [copiedMsg, setCopiedMsg] = useState('');
    const announceCopy = (text) => {
        setCopiedMsg(`Copied ${text}`);
        const t = setTimeout(() => setCopiedMsg(''), 1200);
        return () => clearTimeout(t);
    };

    /* Reveal container */
    const revealRef = useReveal();

    /* ---------- Render helpers ---------- */
    const renderCollection = useCallback(
        (k) => {
            const col = grouped[k];
            if (!col) return null;

            const open = !!expanded[k];
            const items = open ? col.items : col.items.slice(0, 6);
            const st = stats[k];

            return (
                <section
                    key={k}
                    className="collection-section reveal rounded-2xl border border-white/10 bg-black/30 backdrop-blur-sm shadow-lg shadow-cyan-500/10 hover:shadow-cyan-500/20 transition"
                    data-open={open ? 'true' : 'false'}
                >
                    <header className="collection-header flex flex-col md:flex-row md:items-center md:justify-between gap-4 p-4 md:p-5">
                        <div className="collection-header-left flex items-center gap-4">
                            <div>
                                <h2 title={col.name} className="glow-text text-xl md:text-2xl font-semibold bg-gradient-to-r from-cyan-400 via-fuchsia-400 to-pink-500 bg-clip-text text-transparent">
                                    {col.name}
                                </h2>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/70">
                                    {col.symbol && <span className="collection-symbol px-2 py-0.5 rounded bg-white/5 border border-white/10">{col.symbol}</span>}
                                    {col.type !== 'Unknown' && <span className="collection-type px-2 py-0.5 rounded bg-white/5 border border-white/10">{col.type}</span>}
                                    <button
                                        className="copy-addr ml-1 px-2 py-0.5 rounded border border-white/10 hover:border-cyan-400/40 hover:bg-cyan-400/5 transition"
                                        onClick={() => {
                                            navigator.clipboard?.writeText(col.address);
                                            announceCopy(short(col.address));
                                        }}
                                        title="Copy contract address"
                                        type="button"
                                    >
                                        {short(col.address)}
                                    </button>
                                </div>

                                <div className="header-links mt-2 flex gap-3">
                                    <Link
                                        className="tiny-link text-cyan-300 hover:text-cyan-200 underline-offset-4 hover:underline"
                                        to={`/collections/${col.address}`}
                                        title="View collection"
                                    >
                                        View Collection →
                                    </Link>
                                    {explorerBase && (
                                        <a
                                            className="tiny-link text-fuchsia-300 hover:text-fuchsia-200 underline-offset-4 hover:underline"
                                            href={`${explorerBase.replace(/\/$/, '')}/address/${col.address}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title="View on block explorer"
                                        >
                                            Explorer ↗
                                        </a>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="collection-right flex items-center gap-4">
                            <div className="collection-metrics grid grid-cols-3 gap-3">
                                {st?.loading ? (
                                    <>
                                        <div className="metric shimmer h-10 w-28 rounded-md bg-white/10" />
                                        <div className="metric shimmer h-10 w-28 rounded-md bg-white/10" />
                                        <div className="metric shimmer h-10 w-28 rounded-md bg-white/10" />
                                    </>
                                ) : (
                                    <>
                                        <div className="metric rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm">
                                            <span className="metric-label block text-white/60">Floor</span>
                                            <span className="metric-value font-semibold text-cyan-300">${(st?.floorUSDC ?? 0).toFixed(2)}</span>
                                        </div>
                                        <div className="metric rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm">
                                            <span className="metric-label block text-white/60">Avg</span>
                                            <span className="metric-value font-semibold text-pink-300">${(st?.avgUSDC ?? 0).toFixed(2)}</span>
                                        </div>
                                        <div className="metric rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm">
                                            <span className="metric-label block text-white/60">Items</span>
                                            <span className="metric-value font-semibold text-emerald-300">{st?.count ?? col.items.length}</span>
                                        </div>
                                    </>
                                )}
                            </div>

                            <button
                                className={`toggle-btn ${open ? 'open' : ''} px-4 py-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 hover:border-cyan-400/40 text-sm font-medium transition`}
                                onClick={() => toggleExpand(k)}
                                aria-expanded={open}
                                aria-controls={`section-${k}`}
                                type="button"
                            >
                                {open ? 'Collapse' : 'Expand'}
                            </button>
                        </div>
                    </header>

                    <div id={`section-${k}`} className="listings-grid featured px-3 pb-4 md:px-5">
                        {items.map((listing, i) => (
                            <div
                                className="listing-wrapper relative rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition shadow-sm"
                                style={{ '--item-index': i }}
                                key={listing?.id ?? `${k}-${listing?.tokenId}-${i}`}
                            >
                                <div className="hot-badge absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-orange-500 to-amber-500 px-2 py-1 text-xs font-semibold text-white shadow">
                                    <span className="fire-emoji">🔥</span> {col.symbol || 'Featured'}
                                </div>
                                <ListingCard listing={listing} featured />
                            </div>
                        ))}
                    </div>

                    {!open && col.items.length > 6 && (
                        <div className="collection-footer px-4 pb-5">
                            <button
                                className="hp-btn hp-btn--primary px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-fuchsia-500 text-white font-semibold shadow hover:shadow-lg hover:opacity-95 transition"
                                onClick={() => toggleExpand(k)}
                                type="button"
                            >
                                Show more
                            </button>
                        </div>
                    )}
                </section>
            );
        },
        [grouped, expanded, stats, toggleExpand, explorerBase]
    );

    /* ---------- JSX ---------- */
    return (
        <div className="hot-listings-container organized relative min-h-screen" ref={revealRef}>
            <canvas ref={canvasRef} className="particles-bg absolute inset-0 -z-10" aria-hidden />

            {/* Copy live region for screen readers */}
            <div className="sr-only" role="status" aria-live="polite">
                {copiedMsg}
            </div>

            <div className="page-header tilt-3d mx-auto max-w-7xl px-4 pt-10 pb-4 md:pt-14 md:pb-6">
                <h1 className="mb-2 text-center text-3xl md:text-4xl font-extrabold tracking-tight">
                    <span className="fire-emoji mr-2">🔥</span>
                    <span className="bg-gradient-to-r from-cyan-400 via-fuchsia-400 to-pink-500 bg-clip-text text-transparent">
                        Premium Listings
                    </span>
                </h1>
                <p className="text-center text-sm md:text-base text-white/70">
                    Curated collections of exclusive digital assets from verified creators.
                </p>

                <div className="toolbar mt-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div className="toolbar-left w-full md:max-w-md">
                        <input
                            type="search"
                            placeholder="Search collections or contract addresses…"
                            value={search}
                            onChange={(e) => {
                                setSearch(e.target.value);
                                setPage(1);
                            }}
                            className="toolbar-search w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-500/30 transition"
                            aria-label="Search collections"
                        />
                    </div>
                    <div className="toolbar-right flex flex-wrap items-center gap-3">
                        <div className="toolbar-filters flex flex-wrap items-end gap-3 rounded-xl border border-white/10 bg-black/30 p-3">
                            <label className="filter-label flex flex-col text-xs text-white/70">
                                <span className="mb-1">Type</span>
                                <select
                                    className="toolbar-sort rounded-md border border-white/10 bg-black/40 px-2 py-1 text-sm focus:border-fuchsia-400/50 focus:ring-2 focus:ring-fuchsia-500/30 outline-none transition"
                                    value={filterType}
                                    onChange={(e) => {
                                        setFilterType(e.target.value);
                                        setPage(1);
                                    }}
                                >
                                    <option value="any">Any</option>
                                    <option value="ERC721">ERC721</option>
                                    <option value="ERC1155">ERC1155</option>
                                </select>
                            </label>

                            <label className="filter-label flex flex-col text-xs text-white/70">
                                <span className="mb-1">Min Items</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    value={minItems}
                                    onChange={(e) => {
                                        const v = Math.max(0, Number(e.target.value) || 0);
                                        setMinItems(v);
                                        setPage(1);
                                    }}
                                    className="toolbar-number w-28 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-sm focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-500/30 outline-none transition"
                                />
                            </label>

                            <label className="filter-label flex flex-col text-xs text-white/70">
                                <span className="mb-1">Sort</span>
                                <select
                                    id="sortSel"
                                    className="toolbar-sort rounded-md border border-white/10 bg-black/40 px-2 py-1 text-sm focus:border-pink-400/50 focus:ring-2 focus:ring-pink-500/30 outline-none transition"
                                    value={sort}
                                    onChange={(e) => {
                                        setSort(e.target.value);
                                        setPage(1);
                                    }}
                                >
                                    <option value="count">Most items</option>
                                    <option value="name">Name (A→Z)</option>
                                    <option value="type">Type (ERC721/1155)</option>
                                    <option value="floor_low">Floor (low → high)</option>
                                    <option value="floor_high">Floor (high → low)</option>
                                    <option value="avg_high">Average (high → low)</option>
                                </select>
                            </label>
                        </div>

                        <button
                            className="hp-btn rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 hover:border-cyan-400/40 transition"
                            onClick={() => navigate('/marketplace')}
                            type="button"
                        >
                            Explore Marketplace
                        </button>
                        <button
                            className="hp-btn hp-btn--primary rounded-lg bg-gradient-to-r from-cyan-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white shadow hover:shadow-lg hover:opacity-95 transition"
                            onClick={() => navigate('/sell')}
                            type="button"
                        >
                            List Your NFT
                        </button>
                    </div>
                </div>
            </div>

            <div className="collections-container mx-auto max-w-7xl px-4 pb-10">
                {pageLoading || collectionsLoading ? (
                    <LoadingSkeleton type="card" count={6} className="grid" />
                ) : visibleOrder.length ? (
                    <>
                        <div className="grid grid-cols-1 gap-6">
                            {visibleOrder.map(renderCollection)}
                        </div>
                        {page < totalPages && (
                            <div className="load-more mt-8 flex justify-center">
                                <button
                                    className="hp-btn hp-btn--primary rounded-lg bg-gradient-to-r from-cyan-500 to-fuchsia-500 px-5 py-2.5 text-sm font-semibold text-white shadow hover:shadow-lg hover:opacity-95 transition"
                                    onClick={() => setPage((p) => p + 1)}
                                    type="button"
                                >
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