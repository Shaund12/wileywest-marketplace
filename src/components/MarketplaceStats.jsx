import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { formatTokenAmount, getTokenSymbol } from '../utils/tokenUtils';
import { scopedClass } from '../utils/nftUtils';
import './marketplace.css';

/**
 * Tiny utilities
 */
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const fmtUSD = (v) => (typeof v === 'number' ? (v < 0.01 ? v.toFixed(6) : v.toFixed(2)) : '0.00');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '—');
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Mini sparkline (inline SVG)
 */
function Sparkline({ points = [], height = 36, strokeWidth = 2, className = '' }) {
    const H = height;
    const W = Math.max(points.length * 8, 80); // scale with data
    if (!points.length) {
        return <svg width={W} height={H} className={className} aria-hidden="true" />;
    }
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const dx = W / (points.length - 1 || 1);
    const path = points
        .map((p, i) => {
            const x = i * dx;
            const y = H - ((p - min) / span) * (H - strokeWidth) - strokeWidth / 2;
            return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(' ');
    const last = points[points.length - 1];
    const first = points[0];
    const up = last >= first;

    return (
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-label="Trend sparkline">
            <defs>
                <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={up ? '#16a34a' : '#ef4444'} stopOpacity="0.9" />
                    <stop offset="100%" stopColor={up ? '#16a34a' : '#ef4444'} stopOpacity="0.2" />
                </linearGradient>
            </defs>
            <path d={path} fill="none" stroke="url(#sparkGrad)" strokeWidth={strokeWidth} vectorEffect="non-scaling-stroke" />
        </svg>
    );
}

/**
 * Tiny bar chart (for hourly/daily volume)
 */
function Bars({ data = [], height = 64, className = '', maxBars = 24, labelPrefix = '' }) {
    const H = height;
    const arr = data.slice(0, maxBars);
    const max = Math.max(1, ...arr);
    return (
        <div className={`bars ${className}`} role="img" aria-label="Volume bars">
            {arr.map((v, i) => {
                const h = Math.max((v / max) * 100, 3);
                return (
                    <div key={i} className="bar" title={`${labelPrefix}${i}: $${fmtUSD(v)}`}>
                        <div className="bar-fill" style={{ height: `${h}%` }} />
                    </div>
                );
            })}
        </div>
    );
}

/**
 * Skeletons
 */
function StatSkeleton() {
    return (
        <div className={scopedClass('stat-card', 'MarketplaceStats')}>
            <div className="sk-title" />
            <div className="sk-value" />
            <div className="sk-sub" />
        </div>
    );
}

/**
 * CSV Exporter for transactionHistory
 */
function downloadCSV(filename, rows) {
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function MarketplaceStats() {
    const { marketplaceStats = {}, refreshBlockchainData, salesHistory = [], status = '' } = useMarketplace();

    // UI State
    const [activeTab, setActiveTab] = useState('overview');
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(false);
    const [refreshEvery, setRefreshEvery] = useState(60); // seconds
    const [nextTick, setNextTick] = useState(refreshEvery);
    const tickRef = useRef(null);
    const lastRefreshRef = useRef(0);

    // destructure with safety
    const {
        totalSales = 0,
        actualSoldVolume = 0,
        currentListingVolume = 0,
        // time-based metrics
        volume1h = 0,
        volume6h = 0,
        volume12h = 0,
        volume24h = 0,
        volume7d = 0,
        volume30d = 0,
        volumeAllTime = 0,
        sales1h = 0,
        sales6h = 0,
        sales12h = 0,
        sales24h = 0,
        sales7d = 0,
        sales30d = 0,
        // advanced
        avgPrice = 0,
        highestPrice = 0,
        lowestPrice = 0,
        marketCap = 0,
        liquidityRatio = 0,
        marketVelocity24h = 0,
        marketVelocity7d = 0,
        growthRate24h = 0,
        growthRate7d = 0,
        marketHealthScore = 0,
        turnoverRate = 0,
        uniqueBuyers = 0,
        hourlyVolume = [],
        dailyVolume = [],
        priceHistory = [],
        transactionHistory = [],
        topTokens = [],
        mostActiveSellers = [],
    } = marketplaceStats;

    /**
     * Derived analytics (memoized)
     */
    const recentPrices = useMemo(() => priceHistory?.slice(0, 30) || [], [priceHistory]);
    const trendUp24h = useMemo(() => (sales24h || 0) >= ((sales7d || 0) / 7 || 0), [sales24h, sales7d]);
    const velocityHourlyVs24h = useMemo(() => {
        if (!volume24h) return null;
        return (volume1h / (volume24h / 24)) * 100;
    }, [volume1h, volume24h]);

    const velocityDailyVs7d = useMemo(() => {
        if (!volume7d) return null;
        return (volume24h / (volume7d / 7)) * 100;
    }, [volume24h, volume7d]);

    const velocityWeeklyVs30d = useMemo(() => {
        if (!volume30d) return null;
        return (volume7d / (volume30d / 30)) * 100;
    }, [volume7d, volume30d]);

    const marketPenetration = useMemo(() => {
        const denom = volumeAllTime || actualSoldVolume || 0;
        return denom ? (currentListingVolume / denom) * 100 : null;
    }, [currentListingVolume, volumeAllTime, actualSoldVolume]);

    const recentPriceStats = useMemo(() => {
        if (!recentPrices.length) return { hi: 0, lo: 0, vol: 0 };
        const arr = recentPrices.map((p) => Number(p.price || 0)).filter((n) => !Number.isNaN(n));
        if (!arr.length) return { hi: 0, lo: 0, vol: 0 };
        const hi = Math.max(...arr);
        const lo = Math.min(...arr);
        const vol = lo > 0 ? (hi / lo - 1) * 100 : 0;
        return { hi, lo, vol };
    }, [recentPrices]);

    /**
     * Refresh handlers
     */
    const doRefresh = useCallback(async () => {
        if (!refreshBlockchainData) return;
        setIsRefreshing(true);
        try {
            await refreshBlockchainData();
            lastRefreshRef.current = nowSeconds();
        } catch (e) {
            console.error('Error refreshing blockchain data:', e);
        } finally {
            setIsRefreshing(false);
            setNextTick(refreshEvery);
        }
    }, [refreshBlockchainData, refreshEvery]);

    useEffect(() => {
        if (!autoRefresh) {
            if (tickRef.current) clearInterval(tickRef.current);
            setNextTick(refreshEvery);
            return;
        }
        setNextTick((s) => (s ? s : refreshEvery));
        tickRef.current = setInterval(() => {
            setNextTick((t) => {
                if (t <= 1) {
                    // fire refresh if not already refreshing
                    if (!isRefreshing) doRefresh();
                    return refreshEvery;
                }
                return t - 1;
            });
        }, 1000);
        return () => tickRef.current && clearInterval(tickRef.current);
    }, [autoRefresh, refreshEvery, doRefresh, isRefreshing]);

    /**
     * Tab list with keyboard support
     */
    const tabs = [
        { id: 'overview', label: 'Overview' },
        { id: 'volume', label: 'Volume Analytics' },
        { id: 'advanced', label: 'Advanced Metrics' },
        { id: 'trends', label: 'Market Trends' },
        { id: 'transactions', label: 'Transaction History' },
        { id: 'tokens', label: 'Top Tokens' },
        { id: 'sellers', label: 'Active Sellers' },
    ];

    const onTabKeyDown = (e, idx) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
        setActiveTab(tabs[next].id);
    };

    /**
     * Export transactions to CSV
     */
    const exportTxCsv = () => {
        // Use transactionHistory first, fallback to salesHistory
        const dataToExport = transactionHistory?.length > 0 ? transactionHistory : salesHistory.slice(0, 50);
        if (!dataToExport?.length) return;
        
        const rows = [
            ['Buyer', 'Total Price (raw)', 'Pretty Amount', 'Token', 'Timestamp', 'ISO Date'],
            ...dataToExport.map((tx) => [
                tx.buyer,
                tx.totalPrice,
                formatTokenAmount(tx.totalPrice, tx.paymentToken),
                getTokenSymbol(tx.paymentToken),
                tx.timestamp || '',
                tx.formattedTimestamp || (tx.timestamp ? new Date(tx.timestamp).toISOString() : ''),
            ]),
        ];
        downloadCSV(`blockdust-transactions-${Date.now()}.csv`, rows);
    };

    const copy = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch { }
    };

    const loading = (status && (/Fetching|Scanning|Processing/i).test(status)) || false;
    const showNoDataNotice = salesHistory.length === 0 && !/demo mode/i.test(status || '');

    return (
        <div className={scopedClass('container', 'MarketplaceStats')}>
            {/* Header */}
            <div className={scopedClass('header', 'MarketplaceStats')}>
                <div className={scopedClass('title-wrap', 'MarketplaceStats')}>
                    <h2 className={scopedClass('title', 'MarketplaceStats')}>BlockDust Marketplace Statistics</h2>
                    <div className="subtitle">
                        <span className="pill">live</span>
                        <span className="dot" />
                        <span className="muted">Auto refresh</span>
                        <label className="switch">
                            <input
                                type="checkbox"
                                checked={autoRefresh}
                                onChange={(e) => setAutoRefresh(e.target.checked)}
                                aria-label="Toggle auto refresh"
                            />
                            <span className="slider" />
                        </label>
                        <select
                            className="small-select"
                            value={refreshEvery}
                            onChange={(e) => setRefreshEvery(clamp(Number(e.target.value) || 60, 10, 600))}
                            disabled={!autoRefresh}
                            aria-label="Auto refresh interval"
                        >
                            <option value={15}>15s</option>
                            <option value={30}>30s</option>
                            <option value={60}>60s</option>
                            <option value={120}>2m</option>
                            <option value={300}>5m</option>
                        </select>
                        {autoRefresh && <span className="countdown">in {nextTick}s</span>}
                    </div>
                </div>

                <div className={scopedClass('actions', 'MarketplaceStats')}>
                    <button
                        className={`${scopedClass('refresh-button', 'MarketplaceStats')} ${isRefreshing ? scopedClass('refreshing', 'MarketplaceStats') : ''
                            }`}
                        onClick={doRefresh}
                        disabled={isRefreshing}
                    >
                        {isRefreshing ? '🔄 Refreshing...' : '🔄 Refresh'}
                    </button>
                    {activeTab === 'transactions' && transactionHistory?.length > 0 && (
                        <button className="secondary-button" onClick={exportTxCsv}>⬇️ Export CSV</button>
                    )}
                </div>
            </div>

            {/* Data notices */}
            {showNoDataNotice && (
                <div className="data-status-notice">
                    <p>📊 No transaction data found yet. Scan the full chain to backfill marketplace history.</p>
                    <button className="refresh-data-button" onClick={doRefresh} disabled={isRefreshing}>
                        {isRefreshing ? 'Scanning Blockchain...' : '🔍 Scan All Blockchain History'}
                    </button>
                </div>
            )}

            {status && (/Fetching|Scanning|Processing/i).test(status) && (
                <div className="loading-status-notice">
                    <p>🔄 {status}</p>
                </div>
            )}

            {/* Tabs */}
            <div className={scopedClass('tabs', 'MarketplaceStats')} role="tablist" aria-label="Marketplace Stats Tabs">
                {tabs.map((tab, i) => (
                    <button
                        key={tab.id}
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        tabIndex={activeTab === tab.id ? 0 : -1}
                        className={`${scopedClass('tab-button', 'MarketplaceStats')} ${activeTab === tab.id ? scopedClass('tab-button--active', 'MarketplaceStats') : ''
                            }`}
                        onClick={() => setActiveTab(tab.id)}
                        onKeyDown={(e) => onTabKeyDown(e, i)}
                    >
                        {tab.label}
                        {tab.id === 'transactions' && salesHistory.length > 0 && (
                            <span className={scopedClass('tab-badge', 'MarketplaceStats')}>{salesHistory.length}</span>
                        )}
                        {tab.id === 'volume' && (totalSales > 0) && (
                            <span className={scopedClass('tab-badge', 'MarketplaceStats')}>📊</span>
                        )}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className={scopedClass('content', 'MarketplaceStats')}>
                {/* OVERVIEW */}
                {activeTab === 'overview' && (
                    <div className="overview-stats">
                        <div className={scopedClass('stats-grid', 'MarketplaceStats')}>
                            {loading ? (
                                <>
                                    <StatSkeleton />
                                    <StatSkeleton />
                                    <StatSkeleton />
                                    <StatSkeleton />
                                    <StatSkeleton />
                                    <StatSkeleton />
                                </>
                            ) : (
                                <>
                                    <div className={`${scopedClass('stat-card', 'MarketplaceStats')} ${scopedClass('stat-card--highlight', 'MarketplaceStats')}`}>
                                        <div className="stat-top">
                                            <h3>🔥 1h Volume</h3>
                                            <span className={`delta ${volume1h >= (volume24h / 24 || 0) ? 'up' : 'down'}`}>
                                                {volume24h ? (((volume1h / (volume24h / 24)) - 1) * 100).toFixed(1) : '0.0'}%
                                            </span>
                                        </div>
                                        <p className={scopedClass('stat-value', 'MarketplaceStats')}>${fmtUSD(volume1h)}</p>
                                        <span className={scopedClass('stat-label', 'MarketplaceStats')}>{sales1h} sales last hour</span>
                                        <Sparkline points={[...hourlyVolume.slice(0, 12)].reverse()} />
                                    </div>

                                    <div className={`${scopedClass('stat-card', 'MarketplaceStats')} ${scopedClass('stat-card--highlight', 'MarketplaceStats')}`}>
                                        <div className="stat-top">
                                            <h3>🔥 24h Volume</h3>
                                            <span className={`delta ${trendUp24h ? 'up' : 'down'}`}>
                                                {velocityDailyVs7d ? (velocityDailyVs7d - 100).toFixed(1) : '0.0'}%
                                            </span>
                                        </div>
                                        <p className={scopedClass('stat-value', 'MarketplaceStats')}>${fmtUSD(volume24h)}</p>
                                        <span className={scopedClass('stat-label', 'MarketplaceStats')}>{sales24h} sales in last 24h</span>
                                        <Bars data={hourlyVolume} labelPrefix="" />
                                    </div>

                                    <div className={scopedClass('stat-card', 'MarketplaceStats')}>
                                        <h3>📈 Total Volume</h3>
                                        <p className={scopedClass('stat-value', 'MarketplaceStats')}>${fmtUSD(volumeAllTime || actualSoldVolume)}</p>
                                        <span className={scopedClass('stat-label', 'MarketplaceStats')}>{totalSales} total transactions</span>
                                        <Sparkline points={(dailyVolume || []).slice(0, 30).reverse()} />
                                    </div>

                                    <div className={scopedClass('stat-card', 'MarketplaceStats')}>
                                        <h3>💰 Listings Value</h3>
                                        <p className={scopedClass('stat-value', 'MarketplaceStats')}>${fmtUSD(currentListingVolume)}</p>
                                        <span className={scopedClass('stat-label', 'MarketplaceStats')}>Available to buy</span>
                                        <span className="sub-pill">Penetration: {marketPenetration ? `${marketPenetration.toFixed(1)}%` : 'N/A'}</span>
                                    </div>

                                    <div className={scopedClass('stat-card', 'MarketplaceStats')}>
                                        <h3>📊 Average Sale</h3>
                                        <p className={scopedClass('stat-value', 'MarketplaceStats')}>${fmtUSD(avgPrice)}</p>
                                        <span className={scopedClass('stat-label', 'MarketplaceStats')}>Per transaction</span>
                                        <Sparkline points={recentPrices.map((p) => p.price)} />
                                    </div>

                                    <div className={scopedClass('stat-card', 'MarketplaceStats')}>
                                        <h3>🏆 Market Health</h3>
                                        <p className={scopedClass('stat-value', 'MarketplaceStats')}>{fmtUSD(marketHealthScore)}/100</p>
                                        <span className={`health-badge ${marketHealthScore >= 75 ? 'good' : marketHealthScore >= 50 ? 'ok' : marketHealthScore >= 25 ? 'warn' : 'bad'
                                            }`}>
                                            {marketHealthScore >= 75 ? 'Excellent' : marketHealthScore >= 50 ? 'Good' : marketHealthScore >= 25 ? 'Fair' : 'Poor'}
                                        </span>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Volume by period */}
                        <div className="volume-summary">
                            <h3>📅 Volume by Time Period</h3>
                            <div className="volume-periods">
                                {[
                                    ['1 Hour', volume1h, sales1h],
                                    ['6 Hours', volume6h, sales6h],
                                    ['12 Hours', volume12h, sales12h],
                                    ['24 Hours', volume24h, sales24h],
                                    ['7 Days', volume7d, sales7d],
                                    ['30 Days', volume30d, sales30d],
                                    ['All Time', volumeAllTime || actualSoldVolume, totalSales],
                                ].map(([label, vol, s]) => (
                                    <div key={label} className="period-item">
                                        <span className="period-label">{label}:</span>
                                        <span className="period-value">${fmtUSD(vol || 0)} ({s || 0} sales)</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Quick insights */}
                        <div className="quick-analytics">
                            <h3>🚀 Quick Insights</h3>
                            <div className="insight-items">
                                <div className="insight-item">
                                    <span className="insight-label">👥 Unique Buyers:</span>
                                    <span className="insight-value">{uniqueBuyers || 0}</span>
                                </div>
                                <div className="insight-item">
                                    <span className="insight-label">🏆 Highest Sale:</span>
                                    <span className="insight-value">${fmtUSD(highestPrice || 0)}</span>
                                </div>
                                <div className="insight-item">
                                    <span className="insight-label">💎 Floor Price:</span>
                                    <span className="insight-value">${fmtUSD(lowestPrice || 0)}</span>
                                </div>
                                <div className="insight-item">
                                    <span className="insight-label">⚡ Market Velocity:</span>
                                    <span className="insight-value">{fmtUSD((marketVelocity24h || 0) * 100)}%</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* VOLUME ANALYTICS */}
                {activeTab === 'volume' && (
                    <div className="volume-analytics">
                        <h3>📊 Comprehensive Volume Analytics</h3>

                        <div className="volume-metrics-grid">
                            {[
                                ['⚡ 1 Hour Activity', volume1h, sales1h, 1],
                                ['🔥 6 Hour Activity', volume6h, sales6h, 6],
                                ['🔥 12 Hour Activity', volume12h, sales12h, 12],
                                ['🔥 24 Hour Activity', volume24h, sales24h, 24, true],
                                ['📅 7 Day Activity', volume7d, sales7d, 7 * 24],
                                ['🗓️ 30 Day Activity', volume30d, sales30d, 30 * 24],
                            ].map(([title, vol, s, hours, highlight]) => (
                                <div key={title} className={`volume-metric-card ${highlight ? 'highlight' : ''}`}>
                                    <h4>{title}</h4>
                                    <div className="metric-details">
                                        <div className="metric-row"><span>Volume:</span><span className="metric-value">${fmtUSD(vol || 0)}</span></div>
                                        <div className="metric-row"><span>Sales:</span><span className="metric-value">{s || 0} transactions</span></div>
                                        <div className="metric-row">
                                            <span>Avg Sale:</span>
                                            <span className="metric-value">
                                                ${(s || 0) > 0 ? fmtUSD((vol || 0) / (s || 1)) : '0.00'}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="volume-comparison">
                            <h4>📈 Volume Trends & Performance</h4>
                            <div className="comparison-items">
                                <div className="comparison-item">
                                    <span className="comparison-label">Hourly Velocity (1h vs 24h avg):</span>
                                    <span className="comparison-value">{velocityHourlyVs24h ? `${velocityHourlyVs24h.toFixed(1)}%` : 'N/A'}</span>
                                </div>
                                <div className="comparison-item">
                                    <span className="comparison-label">Daily Velocity (24h vs 7d avg):</span>
                                    <span className="comparison-value">{velocityDailyVs7d ? `${velocityDailyVs7d.toFixed(1)}%` : 'N/A'}</span>
                                </div>
                                <div className="comparison-item">
                                    <span className="comparison-label">Weekly Velocity (7d vs 30d avg):</span>
                                    <span className="comparison-value">{velocityWeeklyVs30d ? `${velocityWeeklyVs30d.toFixed(1)}%` : 'N/A'}</span>
                                </div>
                                <div className="comparison-item">
                                    <span className="comparison-label">Market Penetration (listings vs sold):</span>
                                    <span className="comparison-value">{marketPenetration !== null ? `${marketPenetration.toFixed(1)}%` : 'N/A'}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* ADVANCED */}
                {activeTab === 'advanced' && (
                    <div className="advanced-analytics">
                        <h3>🎯 Advanced Market Analytics</h3>
                        <div className="advanced-metrics-grid">
                            <div className="advanced-metric-card">
                                <h4>💎 Price Analytics</h4>
                                <div className="metric-details">
                                    <div className="metric-row"><span>Average Price:</span><span className="metric-value">${fmtUSD(avgPrice)}</span></div>
                                    <div className="metric-row"><span>Highest Sale:</span><span className="metric-value">${fmtUSD(highestPrice)}</span></div>
                                    <div className="metric-row"><span>Floor Price:</span><span className="metric-value">${fmtUSD(lowestPrice)}</span></div>
                                    <div className="metric-row"><span>Price Range:</span><span className="metric-value">${fmtUSD((highestPrice || 0) - (lowestPrice || 0))}</span></div>
                                </div>
                            </div>

                            <div className="advanced-metric-card">
                                <h4>📊 Market Dynamics</h4>
                                <div className="metric-details">
                                    <div className="metric-row"><span>Market Cap:</span><span className="metric-value">${fmtUSD(marketCap)}</span></div>
                                    <div className="metric-row"><span>Liquidity Ratio:</span><span className="metric-value">{fmtUSD((liquidityRatio || 0) * 100)}%</span></div>
                                    <div className="metric-row"><span>Turnover Rate:</span><span className="metric-value">{fmtUSD(turnoverRate)}%</span></div>
                                    <div className="metric-row"><span>Unique Buyers:</span><span className="metric-value">{uniqueBuyers || 0}</span></div>
                                </div>
                            </div>

                            <div className="advanced-metric-card">
                                <h4>⚡ Market Velocity</h4>
                                <div className="metric-details">
                                    <div className="metric-row"><span>24h Velocity:</span><span className="metric-value">{fmtUSD((marketVelocity24h || 0) * 100)}%</span></div>
                                    <div className="metric-row"><span>7d Velocity:</span><span className="metric-value">{fmtUSD((marketVelocity7d || 0) * 100)}%</span></div>
                                    <div className="metric-row">
                                        <span>Momentum:</span>
                                        <span className="metric-value">
                                            {(marketVelocity24h || 0) > 1.5 ? '🚀 High' :
                                                (marketVelocity24h || 0) > 1 ? '📈 Moderate' :
                                                    (marketVelocity24h || 0) > 0.5 ? '➡️ Stable' : '📉 Low'}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div className="advanced-metric-card highlight">
                                <h4>🏆 Market Health Score</h4>
                                <div className="metric-details">
                                    <div className="metric-row"><span>Overall Health:</span><span className="metric-value">{fmtUSD(marketHealthScore)}/100</span></div>
                                    <div className="metric-row"><span>Rating:</span>
                                        <span className="metric-value">
                                            {marketHealthScore >= 75 ? '🟢 Excellent' :
                                                marketHealthScore >= 50 ? '🟡 Good' :
                                                    marketHealthScore >= 25 ? '🟠 Fair' : '🔴 Poor'}
                                        </span>
                                    </div>
                                    <div className="metric-row"><span>Growth (24h):</span><span className="metric-value">{fmtUSD(growthRate24h)}%</span></div>
                                    <div className="metric-row"><span>Growth (7d):</span><span className="metric-value">{fmtUSD(growthRate7d)}%</span></div>
                                </div>
                            </div>
                        </div>

                        <div className="market-insights">
                            <h4>🔍 Market Insights</h4>
                            <div className="insight-cards">
                                <div className="insight-card">
                                    <h5>📈 Trading Activity</h5>
                                    <p>
                                        {(sales24h || 0) > (sales7d || 0) / 7
                                            ? `Trading activity is ${(((sales24h || 0) / (((sales7d || 0) / 7) || 1)) * 100).toFixed(0)}% above avg`
                                            : `Trading activity is ${(100 - (((sales24h || 0) / (((sales7d || 0) / 7) || 1)) * 100)).toFixed(0)}% below avg`}
                                    </p>
                                </div>
                                <div className="insight-card">
                                    <h5>💰 Volume Trend</h5>
                                    <p>
                                        {(volume24h || 0) > (volume7d || 0) / 7
                                            ? `Volume is ${((volume24h || 0) / (((volume7d || 0) / 7) || 1)).toFixed(1)}x above weekly avg`
                                            : `Volume is ${(((((volume7d || 0) / 7) || 1) / (volume24h || 1))).toFixed(1)}x below weekly avg`}
                                    </p>
                                </div>
                                <div className="insight-card">
                                    <h5>🎯 Market Position</h5>
                                    <p>
                                        {(liquidityRatio || 0) > 0.5
                                            ? 'High liquidity market with strong inventory'
                                            : (liquidityRatio || 0) > 0.2
                                                ? 'Balanced market with moderate liquidity'
                                                : 'High demand market with limited inventory'}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* TRENDS */}
                {activeTab === 'trends' && (
                    <div className="market-trends">
                        <h3>📈 Market Trends & Patterns</h3>

                        <div className="trends-section">
                            <h4>🚀 Growth Analysis</h4>
                            <div className="trends-grid">
                                <div className="trend-card">
                                    <h5>24h Growth Rate</h5>
                                    <div className="trend-value">
                                        {salesHistory.length > 0 ? (
                                            <span className={`growth-indicator ${(growthRate24h || 0) >= 0 ? 'positive' : 'negative'}`}>
                                                {(growthRate24h || 0) >= 0 ? '📈' : '📉'} {fmtUSD(Math.abs(growthRate24h || 0))}%
                                            </span>
                                        ) : <span className="unavailable-metric">📊 Insufficient data</span>}
                                    </div>
                                    <p>{salesHistory.length > 0 ? 'Compared to previous 24h period' : 'Requires transaction history'}</p>
                                </div>

                                <div className="trend-card">
                                    <h5>7d Growth Rate</h5>
                                    <div className="trend-value">
                                        {salesHistory.length > 0 ? (
                                            <span className={`growth-indicator ${(growthRate7d || 0) >= 0 ? 'positive' : 'negative'}`}>
                                                {(growthRate7d || 0) >= 0 ? '📈' : '📉'} {fmtUSD(Math.abs(growthRate7d || 0))}%
                                            </span>
                                        ) : <span className="unavailable-metric">📊 Insufficient data</span>}
                                    </div>
                                    <p>{salesHistory.length > 0 ? 'Compared to previous 7d period' : 'Requires transaction history'}</p>
                                </div>

                                <div className="trend-card">
                                    <h5>Market Momentum</h5>
                                    <div className="trend-value">
                                        {salesHistory.length > 0 ? (
                                            <span className="momentum-indicator">
                                                {(marketVelocity24h || 0) > 1.5 ? '🚀 High' :
                                                    (marketVelocity24h || 0) > 1 ? '📈 Moderate' :
                                                        (marketVelocity24h || 0) > 0.5 ? '➡️ Stable' : '📉 Low'}
                                            </span>
                                        ) : <span className="unavailable-metric">📊 No data available</span>}
                                    </div>
                                    <p>{salesHistory.length > 0 ? 'Current trading momentum' : 'Based on transaction activity'}</p>
                                </div>
                            </div>
                        </div>

                        {hourlyVolume?.length > 0 && (
                            <div className="trends-section">
                                <h4>⏰ 24h Volume Distribution</h4>
                                <Bars data={hourlyVolume} className="volume-bars" labelPrefix="" maxBars={24} />
                                <p>Volume distribution over the last 24 hours</p>
                            </div>
                        )}

                        {recentPrices.length > 0 && (
                            <div className="trends-section">
                                <h4>💰 Recent Price Activity</h4>
                                <div className="price-trends">
                                    <div className="price-stats">
                                        <div className="price-stat"><span className="stat-label">Recent High:</span><span className="stat-value">${fmtUSD(recentPriceStats.hi)}</span></div>
                                        <div className="price-stat"><span className="stat-label">Recent Low:</span><span className="stat-value">${fmtUSD(recentPriceStats.lo)}</span></div>
                                        <div className="price-stat"><span className="stat-label">Price Volatility:</span><span className="stat-value">{fmtUSD(recentPriceStats.vol)}%</span></div>
                                    </div>
                                    <div className="recent-sales">
                                        <h5>📊 Recent Sales Pattern</h5>
                                        {recentPrices.slice(0, 8).map((sale, i) => (
                                            <div key={i} className="recent-sale">
                                                <span className="sale-price">${fmtUSD(sale.price)}</span>
                                                <span className="sale-time">{new Date((sale.timestamp || Date.now())).toLocaleString()}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* TRANSACTIONS */}
                {activeTab === 'transactions' && (
                    <div className="transaction-history">
                        <div className="transactions-header">
                            <h3>Recent Transactions</h3>
                            <div className="row-actions">
                                <button className="secondary-button" onClick={doRefresh} disabled={isRefreshing}>
                                    {isRefreshing ? 'Refreshing…' : 'Refresh'}
                                </button>
                                {(transactionHistory?.length > 0 || salesHistory?.length > 0) && (
                                    <button className="secondary-button" onClick={exportTxCsv}>⬇️ Export CSV</button>
                                )}
                            </div>
                        </div>

                        {/* Use transactionHistory first, fallback to salesHistory if transactionHistory is empty */}
                        {(transactionHistory?.length > 0 || salesHistory?.length > 0) ? (
                            <div className="transactions-table" role="table" aria-label="Transactions">
                                <div className="table-header" role="row">
                                    <span role="columnheader">Buyer</span>
                                    <span role="columnheader">Price</span>
                                    <span role="columnheader">Token</span>
                                    <span role="columnheader">Date</span>
                                    <span role="columnheader">Action</span>
                                </div>
                                {/* Use transactionHistory if available, otherwise use salesHistory with formatting */}
                                {(transactionHistory?.length > 0 ? transactionHistory : salesHistory.slice(0, 50)).map((tx, idx) => (
                                    <div key={idx} className="table-row" role="row">
                                        <span className="buyer-address" role="cell" title={tx.buyer}>
                                            {shortAddr(tx.buyer)}
                                        </span>
                                        <span className="price-amount" role="cell">
                                            {formatTokenAmount(tx.totalPrice, tx.paymentToken)}
                                        </span>
                                        <span className="token-symbol" role="cell">
                                            {getTokenSymbol(tx.paymentToken)}
                                        </span>
                                        <span className="transaction-date" role="cell">
                                            {tx.formattedTimestamp || (tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '—')}
                                        </span>
                                        <span className="row-actions-cell" role="cell">
                                            <button className="icon-btn" title="Copy buyer address" onClick={() => copy(tx.buyer)}>📋</button>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="no-data">
                                <p>🔍 No transactions found</p>
                                <p>Recent purchases may take a few minutes to appear. Try refreshing the data.</p>
                                <button className="refresh-data-button" onClick={doRefresh} disabled={isRefreshing}>
                                    {isRefreshing ? 'Refreshing...' : 'Refresh Transaction Data'}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* TOKENS */}
                {activeTab === 'tokens' && (
                    <div className="top-tokens">
                        <h3>Top Payment Tokens</h3>
                        {topTokens?.length > 0 ? (
                            <div className="tokens-list">
                                {topTokens.map((token, index) => (
                                    <div key={index} className="token-item">
                                        <div className="token-rank">#{index + 1}</div>
                                        <div className="token-info">
                                            <span className="token-symbol">{getTokenSymbol(token.token)}</span>
                                            <span className="token-volume">${fmtUSD(token.volume)}</span>
                                            <span className="token-sales">{token.sales} sales</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="no-data"><p>No token data available yet</p></div>
                        )}
                    </div>
                )}

                {/* SELLERS */}
                {activeTab === 'sellers' && (
                    <div className="active-sellers">
                        <h3>Most Active Sellers</h3>
                        {mostActiveSellers?.length > 0 ? (
                            <div className="sellers-list">
                                {mostActiveSellers.map((seller, index) => (
                                    <div key={index} className="seller-item">
                                        <div className="seller-rank">#{index + 1}</div>
                                        <div className="seller-info">
                                            <span className="seller-address" title={seller.address}>{shortAddr(seller.address)}</span>
                                            <span className="seller-listings">{seller.listingsCount} active listings</span>
                                            <span className="seller-volume">${fmtUSD(seller.totalVolume)}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="no-data"><p>No seller data available yet</p></div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default MarketplaceStats;
