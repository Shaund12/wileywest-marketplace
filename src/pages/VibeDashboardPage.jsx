import React, { useState, useEffect } from 'react';
import { useSupabase } from '../context/SupabaseContext';
import { debugWarn, criticalError } from '../utils/debugUtils';
import './AuctionStyles.css';

function VibeDashboardPage() {
    const { supabase, isConnected } = useSupabase();
    const [stats, setStats] = useState({
        // VIBE (VTRU) payouts computed from marketplace breakdowns only
        totalVTRUSent: '0',
        vtruSent24h: '0',
        vtruSent7d: '0',
        // Added stats (no fee processor): all derived from marketplace events
        totalTransactions: 0,
        totalPlatformFees: '0',
        totalRoyalties: '0',
        avgPayout: '0'
    });
    const [chartData, setChartData] = useState([]);
    const [leaderboards, setLeaderboards] = useState({
        collections: [],
        royalties: []
    });
    const [recentEvents, setRecentEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [timeframe, setTimeframe] = useState('7d');

    useEffect(() => {
        loadDashboardData();
    }, [timeframe]);

    const toMs = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : 0);
    const getVibeAmount = (row) => {
        // Prefer explicit vibe_amount if present, else sum WVTRU + native
        const v = parseFloat(row?.vibe_amount ?? '0') || 0;
        if (v > 0) return v;
        const w = parseFloat(row?.vibe_out_wvtru ?? row?.vibeOutWVTRU ?? '0') || 0;
        const n = parseFloat(row?.vibe_out_native ?? row?.vibeOutNative ?? '0') || 0;
        return w + n;
    };

    const loadDashboardData = async () => {
        try {
            setLoading(true);

            if (!isConnected || !supabase) {
                debugWarn('Supabase not connected, showing no data');
                setStats({
                    totalVTRUSent: '0',
                    vtruSent24h: '0',
                    vtruSent7d: '0',
                    totalTransactions: 0,
                    totalPlatformFees: '0',
                    totalRoyalties: '0',
                    avgPayout: '0'
                });
                setChartData([]);
                setLeaderboards({ collections: [], royalties: [] });
                setRecentEvents([]);
                return;
            }

            // Time windows
            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            let timeframeBoundary;
            switch (timeframe) {
                case '30d': timeframeBoundary = thirtyDaysAgo; break;
                case '90d': timeframeBoundary = ninetyDaysAgo; break;
                default: timeframeBoundary = sevenDaysAgo;
            }

            // Pull ONLY marketplace-derived data (no fee processor tables)
            const { data: saleBreakdowns, error: saleError } = await supabase
                .from('sale_breakdowns')
                .select('listing_id, platform_fee, royalty, vibe_amount, vibe_out_wvtru, vibe_out_native, timestamp, transaction_hash');

            const { data: auctionBreakdowns, error: auctionError } = await supabase
                .from('auction_breakdowns')
                .select('auction_id, platform_fee, royalty, vibe_amount, vibe_out_wvtru, vibe_out_native, timestamp, transaction_hash');

            if (saleError) criticalError('Error fetching sale breakdowns:', saleError);
            if (auctionError) criticalError('Error fetching auction breakdowns:', auctionError);

            const { data: royaltyPayments, error: royaltyError } = await supabase
                .from('royalty_payments')
                .select('recipient, amount, timestamp, transaction_hash')
                .order('timestamp', { ascending: false });

            if (royaltyError) criticalError('Error fetching royalty payments:', royaltyError);

            const saleData = saleBreakdowns || [];
            const auctionData = auctionBreakdowns || [];
            const royaltyData = royaltyPayments || [];
            const allBreakdowns = [
                ...saleData.map(b => ({ ...b, kind: 'sale', id: b.listing_id })),
                ...auctionData.map(b => ({ ...b, kind: 'auction', id: b.auction_id }))
            ];

            // Aggregate stats
            const totalVTRUSentNum = allBreakdowns.reduce((sum, b) => sum + getVibeAmount(b), 0);
            const vtruSent24hNum = allBreakdowns
                .filter(b => toMs(b.timestamp) >= oneDayAgo.getTime())
                .reduce((sum, b) => sum + getVibeAmount(b), 0);
            const vtruSent7dNum = allBreakdowns
                .filter(b => toMs(b.timestamp) >= sevenDaysAgo.getTime())
                .reduce((sum, b) => sum + getVibeAmount(b), 0);

            const totalTransactions = allBreakdowns.length;
            const totalPlatformFeesNum = allBreakdowns.reduce((s, b) => s + (parseFloat(b.platform_fee || '0') || 0), 0);
            const totalRoyaltiesNum = allBreakdowns.reduce((s, b) => s + (parseFloat(b.royalty || '0') || 0), 0);
            const avgPayoutNum = totalTransactions > 0 ? totalVTRUSentNum / totalTransactions : 0;

            setStats({
                totalVTRUSent: totalVTRUSentNum.toFixed(4),
                vtruSent24h: vtruSent24hNum.toFixed(4),
                vtruSent7d: vtruSent7dNum.toFixed(4),
                totalTransactions,
                totalPlatformFees: totalPlatformFeesNum.toFixed(4),
                totalRoyalties: totalRoyaltiesNum.toFixed(4),
                avgPayout: avgPayoutNum.toFixed(4)
            });

            // Chart (by day) from marketplace breakdowns
            const chartDataMap = new Map();
            const timeframeRows = allBreakdowns.filter(b => toMs(b.timestamp) >= timeframeBoundary.getTime());
            timeframeRows.forEach(b => {
                const date = new Date(toMs(b.timestamp)).toISOString().split('T')[0];
                if (!chartDataMap.has(date)) {
                    chartDataMap.set(date, { vtruSent: 0, transactions: 0 });
                }
                const entry = chartDataMap.get(date);
                entry.vtruSent += getVibeAmount(b);
                entry.transactions += 1;
            });
            const chartDataArray = Array.from(chartDataMap.entries())
                .map(([date, data]) => ({ date, ...data }))
                .sort((a, b) => a.date.localeCompare(b.date));
            setChartData(chartDataArray);

            // Leaderboards (simple aggregates keyed by listing/auction id)
            const platformFeeMap = new Map();
            const royaltyMap = new Map();
            allBreakdowns.forEach(b => {
                const key = String(b.id || 'Unknown');
                const pf = parseFloat(b.platform_fee || '0') || 0;
                const ry = parseFloat(b.royalty || '0') || 0;
                platformFeeMap.set(key, (platformFeeMap.get(key) || 0) + pf);
                royaltyMap.set(key, (royaltyMap.get(key) || 0) + ry);
            });

            const topCollections = Array.from(platformFeeMap.entries())
                .map(([id, fee]) => ({
                    name: `Collection ${id.slice(0, 8)}...`,
                    address: id,
                    platformFees: fee.toFixed(4),
                    royalties: (royaltyMap.get(id) || 0).toFixed(4)
                }))
                .sort((a, b) => parseFloat(b.platformFees) - parseFloat(a.platformFees))
                .slice(0, 5);

            const topRoyalties = Array.from(royaltyMap.entries())
                .map(([id, amt]) => ({
                    collection: `Collection ${id.slice(0, 8)}...`,
                    recipient: id,
                    amount: amt.toFixed(4)
                }))
                .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
                .slice(0, 5);

            setLeaderboards({ collections: topCollections, royalties: topRoyalties });

            // Recent events: VIBE payouts (from breakdowns) + royalty payments
            const payoutEvents = allBreakdowns.map(row => {
                const ts = toMs(row.timestamp);
                const amt = getVibeAmount(row);
                return {
                    ts,
                    time: formatTimeAgo(ts),
                    description: `VIBE payout ${amt.toFixed(2)} VTRU from ${row.kind} ${String(row.id || '—').slice(0, 10)}...`,
                    hash: row.transaction_hash,
                    type: 'vibe_payout'
                };
            });

            const royaltyEvents = (royaltyData || []).map(r => {
                const ts = toMs(r.timestamp);
                return {
                    ts,
                    time: formatTimeAgo(ts),
                    description: `Royalty payment: ${parseFloat(r.amount || '0').toFixed(2)} VTRU`,
                    hash: r.transaction_hash,
                    type: 'royalty'
                };
            });

            const allEvents = [...payoutEvents, ...royaltyEvents]
                .sort((a, b) => b.ts - a.ts)
                .slice(0, 10)
                .map(({ ts, ...rest }) => rest);

            setRecentEvents(allEvents);
        } catch (error) {
            criticalError('Error loading dashboard data:', error);
            setStats({
                totalVTRUSent: '0',
                vtruSent24h: '0',
                vtruSent7d: '0',
                totalTransactions: 0,
                totalPlatformFees: '0',
                totalRoyalties: '0',
                avgPayout: '0'
            });
            setChartData([]);
            setLeaderboards({ collections: [], royalties: [] });
            setRecentEvents([]);
        } finally {
            setLoading(false);
        }
    };

    const formatTimeAgo = (timestamp) => {
        const now = Date.now();
        const diffMs = now - timestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} min ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        const diffDays = Math.floor(diffHours / 24);
        return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    };

    const formatVTRU = (amount) => `${amount} VTRU`;

    return (
        <div className="hp" style={{ maxWidth: 1400, margin: '3rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>VIBE Dashboard</h2>
                <p>Real-time analytics from Marketplace payouts (no fee-processor)</p>
            </div>

            {loading ? (
                <div className="loading-message">
                    <p>Loading dashboard data...</p>
                </div>
            ) : (
                <>
                    {/* Primary KPIs */}
                    <section className="kpi-section">
                        <div className="kpi-grid">
                            <div className="kpi-card">
                                <div className="kpi-label">Total VTRU → VIBE</div>
                                <div className="kpi-value">{formatVTRU(stats.totalVTRUSent)}</div>
                                <div className="kpi-subtitle">All time</div>
                            </div>
                            <div className="kpi-card">
                                <div className="kpi-label">Last 24 Hours</div>
                                <div className="kpi-value">{formatVTRU(stats.vtruSent24h)}</div>
                                <div className="kpi-subtitle">vs prior day</div>
                            </div>
                            <div className="kpi-card">
                                <div className="kpi-label">Last 7 Days</div>
                                <div className="kpi-value">{formatVTRU(stats.vtruSent7d)}</div>
                                <div className="kpi-subtitle">vs prior week</div>
                            </div>
                            <div className="kpi-card">
                                <div className="kpi-label">Payout Transactions</div>
                                <div className="kpi-value">{stats.totalTransactions}</div>
                                <div className="kpi-subtitle">sales + auctions</div>
                            </div>
                        </div>
                    </section>

                    {/* Secondary KPIs */}
                    <section className="kpi-section" style={{ marginTop: '1rem' }}>
                        <div className="kpi-grid">
                            <div className="kpi-card">
                                <div className="kpi-label">Platform Fees Paid</div>
                                <div className="kpi-value">{formatVTRU(stats.totalPlatformFees)}</div>
                                <div className="kpi-subtitle">sum of platform_fee</div>
                            </div>
                            <div className="kpi-card">
                                <div className="kpi-label">Royalties Paid</div>
                                <div className="kpi-value">{formatVTRU(stats.totalRoyalties)}</div>
                                <div className="kpi-subtitle">sum of royalty</div>
                            </div>
                            <div className="kpi-card">
                                <div className="kpi-label">Avg VIBE Payout</div>
                                <div className="kpi-value">{formatVTRU(stats.avgPayout)}</div>
                                <div className="kpi-subtitle">per transaction</div>
                            </div>
                        </div>
                    </section>

                    {/* Charts */}
                    <section className="charts-section">
                        <div className="chart-container">
                            <div className="chart-header">
                                <h3>VTRU → VIBE Over Time</h3>
                                <div className="timeframe-selector">
                                    <button className={timeframe === '7d' ? 'active' : ''} onClick={() => setTimeframe('7d')}>7 Days</button>
                                    <button className={timeframe === '30d' ? 'active' : ''} onClick={() => setTimeframe('30d')}>30 Days</button>
                                    <button className={timeframe === '90d' ? 'active' : ''} onClick={() => setTimeframe('90d')}>90 Days</button>
                                </div>
                            </div>
                            <div className="simple-chart">
                                <div className="chart-data">
                                    {chartData.length > 0 ? (
                                        chartData.slice(-Math.max(7, chartData.length)).map((point, index) => (
                                            <div key={index} className="chart-point">
                                                <span className="date">{point.date}</span>
                                                <span className="value">{point.vtruSent.toFixed(2)} VTRU</span>
                                                <span className="transactions">{point.transactions} tx</span>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="no-data-message">
                                            <p>No payout data available for selected timeframe</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Leaderboards */}
                    <section className="leaderboards-section">
                        <div className="leaderboard-container">
                            <h3>Top Collections by Platform Fees</h3>
                            <div className="leaderboard">
                                {leaderboards.collections.length > 0 ? (
                                    leaderboards.collections.map((collection, index) => (
                                        <div key={index} className="leaderboard-item">
                                            <span className="rank">#{index + 1}</span>
                                            <span className="name">{collection.name}</span>
                                            <span className="value">{formatVTRU(collection.platformFees)}</span>
                                        </div>
                                    ))
                                ) : (
                                    <div className="no-data-message">
                                        <p>No collection fee data available</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="leaderboard-container">
                            <h3>Top Royalty Recipients</h3>
                            <div className="leaderboard">
                                {leaderboards.royalties.length > 0 ? (
                                    leaderboards.royalties.map((royalty, index) => (
                                        <div key={index} className="leaderboard-item">
                                            <span className="rank">#{index + 1}</span>
                                            <span className="name">{royalty.collection}</span>
                                            <span className="value">{formatVTRU(royalty.amount)}</span>
                                        </div>
                                    ))
                                ) : (
                                    <div className="no-data-message">
                                        <p>No royalty payment data available</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* Events Feed */}
                    <section className="events-section">
                        <h3>Recent Marketplace Payouts</h3>
                        <div className="events-feed">
                            {recentEvents.length > 0 ? (
                                recentEvents.map((event, index) => (
                                    <div key={index} className="event-item">
                                        <span className="event-time">{event.time}</span>
                                        <span className="event-description">{event.description}</span>
                                        <span className="event-tx">
                                            <a
                                                href={`https://explorer.vitruveo.xyz/tx/${event.hash}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                {event.hash ? `${event.hash.slice(0, 6)}...${event.hash.slice(-4)}` : 'N/A'}
                                            </a>
                                        </span>
                                    </div>
                                ))
                            ) : (
                                <div className="no-data-message">
                                    <p>No recent payout events available</p>
                                    {!isConnected && (
                                        <p style={{ fontSize: '0.9em', opacity: 0.7 }}>
                                            Connect to Supabase to see real-time event data
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}

export default VibeDashboardPage;