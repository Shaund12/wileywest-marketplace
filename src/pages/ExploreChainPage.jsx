// pages/ExploreChainPage.jsx
//
// Browse every NFT collection on the active chain, sourced from the chain's
// Blockscout explorer via /api/explorer (see backend/api/explorer.js).
//
// Cost model — this page deliberately makes no RPC calls:
//   • Collection list  → 1 cached request for the whole chain.
//   • Token grid       → 1 cached request per 50 tokens, fetched on demand.
//   • Images           → lazy-loaded, so an unopened collection costs nothing.
// The explorer has already resolved tokenURI metadata, so we never fan out to
// IPFS per token the way a chain scan would.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import EmptyState from '../components/EmptyState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { fetchCollections, fetchCollectionTokens } from '../utils/explorerApi';
import { isKnownCollection } from '../utils/knownCollections';
import { activeChain, getActiveChainId, explorerAddress } from '../config/chains.js';
import './ExploreChainPage.css';

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

const formatCount = (n) => {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
};

export default function ExploreChainPage() {
    const chain = activeChain();
    const chainId = getActiveChainId();

    const [collections, setCollections] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    const [typeFilter, setTypeFilter] = useState('all');
    const [selected, setSelected] = useState(null);

    // ── Collection list ────────────────────────────────────────────────
    useEffect(() => {
        const controller = new AbortController();
        let active = true;

        setLoading(true);
        setError(null);
        setSelected(null);

        fetchCollections(chainId, { signal: controller.signal })
            .then(({ collections: list }) => {
                if (active) setCollections(list);
            })
            .catch((err) => {
                if (active && err.name !== 'AbortError') setError(err.message);
            })
            .finally(() => {
                if (active) setLoading(false);
            });

        return () => {
            active = false;
            controller.abort();
        };
    }, [chainId]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return collections.filter((c) => {
            if (typeFilter !== 'all' && c.type !== typeFilter) return false;
            if (!q) return true;
            return (
                c.name.toLowerCase().includes(q) ||
                c.symbol.toLowerCase().includes(q) ||
                c.address.toLowerCase().includes(q)
            );
        });
    }, [collections, query, typeFilter]);

    const types = useMemo(
        () => ['all', ...Array.from(new Set(collections.map((c) => c.type))).sort()],
        [collections],
    );

    if (selected) {
        return (
            <CollectionTokens
                collection={selected}
                chainId={chainId}
                onBack={() => setSelected(null)}
            />
        );
    }

    return (
        <div className="explore-page">
            <header className="explore-head">
                <div>
                    <h1 className="explore-title">
                        <span aria-hidden="true">{chain.icon}</span> Explore {chain.name}
                    </h1>
                    <p className="explore-sub">
                        Every NFT collection on chain, indexed by the {chain.name} explorer.
                    </p>
                </div>
                {!loading && !error && (
                    <span className="explore-count">
                        {filtered.length} of {collections.length}
                    </span>
                )}
            </header>

            <div className="explore-controls">
                <input
                    type="search"
                    className="explore-search"
                    placeholder="Search by name, symbol, or address…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search collections"
                />
                {types.length > 2 && (
                    <div className="explore-types" role="group" aria-label="Filter by token type">
                        {types.map((t) => (
                            <button
                                key={t}
                                type="button"
                                className={`explore-chip ${typeFilter === t ? 'is-active' : ''}`}
                                onClick={() => setTypeFilter(t)}
                            >
                                {t === 'all' ? 'All' : t}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {loading && <LoadingSkeleton />}

            {!loading && error && (
                <EmptyState
                    icon="⚠️"
                    title="Could not reach the explorer"
                    description={error}
                    actionText="Retry"
                    onAction={() => setQuery((q) => q)}
                />
            )}

            {!loading && !error && filtered.length === 0 && (
                <EmptyState
                    icon="🔍"
                    title="No collections found"
                    description={
                        collections.length
                            ? 'Nothing matches that search on this chain.'
                            : `No NFT collections are indexed on ${chain.name} yet.`
                    }
                />
            )}

            {!loading && !error && filtered.length > 0 && (
                <div className="explore-grid">
                    {filtered.map((c) => (
                        <CollectionCard
                            key={c.address}
                            collection={c}
                            chainId={chainId}
                            onOpen={() => setSelected(c)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function CollectionCard({ collection, chainId, onOpen }) {
    const verified = isKnownCollection(collection.address);

    return (
        <article className="explore-card">
            <button type="button" className="explore-card__main" onClick={onOpen}>
                <div className="explore-card__icon" aria-hidden="true">
                    {collection.iconUrl ? (
                        <img src={collection.iconUrl} alt="" loading="lazy" />
                    ) : (
                        <span>{collection.symbol.slice(0, 3).toUpperCase() || 'NFT'}</span>
                    )}
                </div>
                <div className="explore-card__body">
                    <h3 className="explore-card__name">
                        {collection.name}
                        {verified && (
                            <span className="explore-badge" title="Known collection">✓</span>
                        )}
                    </h3>
                    <p className="explore-card__meta">
                        {collection.symbol && <span>{collection.symbol}</span>}
                        <span className="explore-card__type">{collection.type}</span>
                    </p>
                    <dl className="explore-card__stats">
                        <div>
                            <dt>Items</dt>
                            <dd>{formatCount(collection.totalSupply)}</dd>
                        </div>
                        <div>
                            <dt>Holders</dt>
                            <dd>{formatCount(collection.holders)}</dd>
                        </div>
                    </dl>
                </div>
            </button>
            <footer className="explore-card__foot">
                <Link to={`/collections/${collection.address}`} className="explore-link">
                    Marketplace listings
                </Link>
                <a
                    href={explorerAddress(collection.address, chainId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="explore-link explore-link--muted"
                >
                    {shortAddr(collection.address)} ↗
                </a>
            </footer>
        </article>
    );
}

/**
 * Token grid for one collection. Tokens load 50 at a time behind an explicit
 * "Load more" — a collection can hold 50k+ tokens, so this never auto-walks
 * the full set.
 */
function CollectionTokens({ collection, chainId, onBack }) {
    const [tokens, setTokens] = useState([]);
    const [cursor, setCursor] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(null);
    const seen = useRef(new Set());

    const load = useCallback(
        async (nextCursor, { append }) => {
            try {
                const { items, nextCursor: after } = await fetchCollectionTokens(collection.address, {
                    chainId,
                    cursor: nextCursor,
                });

                // Blockscout cursors can overlap at page boundaries; dedupe so
                // React keys stay unique.
                const fresh = items.filter((t) => t.tokenId && !seen.current.has(t.tokenId));
                fresh.forEach((t) => seen.current.add(t.tokenId));

                setTokens((prev) => (append ? [...prev, ...fresh] : fresh));
                setCursor(after);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
                setLoadingMore(false);
            }
        },
        [collection.address, chainId],
    );

    useEffect(() => {
        seen.current = new Set();
        setTokens([]);
        setCursor(null);
        setError(null);
        setLoading(true);
        load(null, { append: false });
    }, [load]);

    const onLoadMore = () => {
        if (loadingMore || cursor == null) return;
        setLoadingMore(true);
        load(cursor, { append: true });
    };

    return (
        <div className="explore-page">
            <header className="explore-head">
                <div>
                    <button type="button" className="explore-back" onClick={onBack}>
                        ← All collections
                    </button>
                    <h1 className="explore-title">{collection.name}</h1>
                    <p className="explore-sub">
                        {formatCount(collection.totalSupply)} items · {formatCount(collection.holders)} holders ·{' '}
                        <a
                            href={explorerAddress(collection.address, chainId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="explore-link explore-link--muted"
                        >
                            {shortAddr(collection.address)} ↗
                        </a>
                    </p>
                </div>
            </header>

            {loading && <LoadingSkeleton />}

            {!loading && error && (
                <EmptyState icon="⚠️" title="Could not load tokens" description={error} />
            )}

            {!loading && !error && tokens.length === 0 && (
                <EmptyState
                    icon="📭"
                    title="No tokens indexed"
                    description="The explorer has not indexed any tokens for this collection yet."
                />
            )}

            {tokens.length > 0 && (
                <>
                    <div className="explore-tokens">
                        {tokens.map((t) => (
                            <Link
                                key={t.tokenId}
                                to={`/nft/${collection.address}/${t.tokenId}`}
                                className="token-card"
                            >
                                <div className="token-card__media">
                                    <img
                                        src={t.imageUrl}
                                        alt={t.name}
                                        loading="lazy"
                                        decoding="async"
                                    />
                                </div>
                                <div className="token-card__body">
                                    <span className="token-card__name">{t.name}</span>
                                    {t.owner && (
                                        <span className="token-card__owner">{shortAddr(t.owner)}</span>
                                    )}
                                </div>
                            </Link>
                        ))}
                    </div>

                    {cursor != null && (
                        <div className="explore-more">
                            <button
                                type="button"
                                className="explore-more__btn"
                                onClick={onLoadMore}
                                disabled={loadingMore}
                            >
                                {loadingMore ? 'Loading…' : 'Load more'}
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
