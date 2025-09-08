import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSupabase } from '../context/SupabaseContext';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
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
    const [error, setError] = useState(null);

    const toMs = useMemo(() => (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : 0), []);

    // Updated to match the contract event fields - memoized to prevent dependency changes
    const getVibeAmount = useMemo(() => (row) => {
        // Check for the direct fields from the contract event
        const vibePortionInPayment = parseFloat(row?.vibe_portion_in_payment ?? row?.vibePortionInPayment ?? '0') || 0;
        if (vibePortionInPayment > 0) return vibePortionInPayment;

        // Fall back to the output metrics that track what was actually sent
        const wvtru = parseFloat(row?.vibe_out_wvtru ?? row?.vibeOutWVTRU ?? '0') || 0;
        const native = parseFloat(row?.vibe_out_native ?? row?.vibeOutNative ?? '0') || 0;

        // If either exists, use them
        if (wvtru > 0 || native > 0) return wvtru + native;

        // Legacy field for backward compatibility
        return parseFloat(row?.vibe_amount ?? '0') || 0;
    }, []);

    const loadDashboardData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

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

            // Try all table options that might contain our data
            const possibleTables = [
                'sale_breakdowns',
                'auction_breakdowns',
                'SaleBreakdown',
                'AuctionBreakdown',
                'nft_sales',
                'marketplace_events'
            ];

            // Try each table and collect any valid data
            let allBreakdowns = [];

            for (const tableName of possibleTables) {
                try {
                    debugLog(`Attempting to fetch data from table: ${tableName}`);
                    const { data, error } = await supabase
                        .from(tableName)
                        .select('*')
                        .limit(1000);

                    // Skip if table doesn't exist or has no data
                    if (error) {
                        if (error.code === '404' || error.code === 'PGRST116') {
                            debugLog(`Table ${tableName} not found`);
                        } else {
                            debugWarn(`Error fetching from ${tableName}:`, error);
                        }
                        continue;
                    }

                    if (data && data.length > 0) {
                        debugLog(`Found ${data.length} records in ${tableName}`);

                        // Normalize the data to handle different field naming conventions
                        const normalized = data.map(row => ({
                            ...row,
                            // Normalize common field names that may vary
                            kind: tableName.includes('sale') ? 'sale' : 'auction',
                            id: row.listing_id || row.listingId || row.auction_id || row.auctionId || row.id,
                            nft_contract: row.nft_contract || row.nftContract || row.contract_address,
                            timestamp: row.timestamp || row.created_at || row.createdAt || row.block_timestamp,
                            transaction_hash: row.transaction_hash || row.transactionHash || row.tx_hash
                        }));

                        allBreakdowns = [...allBreakdowns, ...normalized];
                    }
                } catch (e) {
                    debugWarn(`Exception when fetching from ${tableName}:`, e);
                    // Continue to next table on error
                }
            }

            // If we found no data, show empty state
            if (allBreakdowns.length === 0) {
                debugWarn('No marketplace data found in any table');
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
                setLoading(false);
                return;
            }

            debugLog(`Processing ${allBreakdowns.length} total marketplace events`);

            // Aggregate stats
            const totalVTRUSentNum = allBreakdowns.reduce((sum, b) => sum + getVibeAmount(b), 0);
            const vtruSent24hNum = allBreakdowns
                .filter(b => toMs(b.timestamp) >= oneDayAgo.getTime())
                .reduce((sum, b) => sum + getVibeAmount(b), 0);
            const vtruSent7dNum = allBreakdowns
                .filter(b => toMs(b.timestamp) >= sevenDaysAgo.getTime())
                .reduce((sum, b) => sum + getVibeAmount(b), 0);

            const totalTransactions = allBreakdowns.length;

            // Use the correct field names from smart contract events
            const totalPlatformFeesNum = allBreakdowns.reduce((s, b) => {
                const fee = parseFloat(b.platform_fee_total || b.platformFeeTotal || b.platform_fee || '0') || 0;
                return s + fee;
            }, 0);

            const totalRoyaltiesNum = allBreakdowns.reduce((s, b) => {
                const royalty = parseFloat(b.royalty_amount || b.royaltyAmount || b.royalty || '0') || 0;
                return s + royalty;
            }, 0);

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
            const timeframeRows = allBreakdowns.filter(b => {
                const ts = toMs(b.timestamp);
                return !isNaN(ts) && ts >= timeframeBoundary.getTime();
            });

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

            // Leaderboards by NFT contract (collection)
            const platformFeeMap = new Map();
            const royaltyMap = new Map();

            // Track collections by nftContract instead of listing ID
            allBreakdowns.forEach(b => {
                const nftContract = b.nft_contract || b.nftContract || 'Unknown';
                if (!nftContract || nftContract === 'Unknown') return;

                const key = String(nftContract);

                const pf = parseFloat(b.platform_fee_total || b.platformFeeTotal || b.platform_fee || '0') || 0;
                const ry = parseFloat(b.royalty_amount || b.royaltyAmount || b.royalty || '0') || 0;

                platformFeeMap.set(key, (platformFeeMap.get(key) || 0) + pf);
                royaltyMap.set(key, (royaltyMap.get(key) || 0) + ry);
            });

            // Group by royalty recipient for royalty leaderboard
            const royaltyRecipientMap = new Map();
            allBreakdowns.forEach(b => {
                const recipient = b.royalty_receiver || b.royaltyReceiver || '';
                if (!recipient || recipient === '0x0000000000000000000000000000000000000000') return;

                const amount = parseFloat(b.royalty_amount || b.royaltyAmount || b.royalty || '0') || 0;
                if (amount > 0) {
                    royaltyRecipientMap.set(recipient, (royaltyRecipientMap.get(recipient) || 0) + amount);
                }
            });

            const topCollections = Array.from(platformFeeMap.entries())
                .map(([address, fee]) => ({
                    name: `Collection ${address.slice(0, 8)}...`,
                    address,
                    platformFees: fee.toFixed(4),
                    royalties: (royaltyMap.get(address) || 0).toFixed(4)
                }))
                .sort((a, b) => parseFloat(b.platformFees) - parseFloat(a.platformFees))
                .slice(0, 5);

            const topRoyalties = Array.from(royaltyRecipientMap.entries())
                .map(([recipient, amount]) => ({
                    collection: `Recipient ${recipient.slice(0, 8)}...`,
                    recipient,
                    amount: amount.toFixed(4)
                }))
                .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
                .slice(0, 5);

            setLeaderboards({ collections: topCollections, royalties: topRoyalties });

            // Recent events: VIBE payouts (from breakdowns) + royalty payments
            const payoutEvents = allBreakdowns.map(row => {
                const ts = toMs(row.timestamp);
                const amt = getVibeAmount(row);
                if (isNaN(ts) || amt <= 0) return null;

                return {
                    ts,
                    time: formatTimeAgo(ts),
                    description: `VIBE payout ${amt.toFixed(2)} VTRU from ${row.kind || 'transaction'} ${String(row.id || '—').slice(0, 10)}...`,
                    hash: row.transaction_hash || row.transactionHash || row.tx_hash,
                    type: 'vibe_payout'
                };
            }).filter(Boolean); // Filter out nulls

            // Try to fetch royalty payments, but don't fail if the table doesn't exist
            let royaltyEvents = [];
            try {
                const { data: royaltyPayments, error: royaltyError } = await supabase
                    .from('royalty_payments')
                    .select('recipient, amount, timestamp, transaction_hash')
                    .order('timestamp', { ascending: false })
                    .limit(50);

                if (!royaltyError && royaltyPayments?.length) {
                    royaltyEvents = royaltyPayments.map(r => {
                        const ts = toMs(r.timestamp);
                        if (isNaN(ts)) return null;

                        return {
                            ts,
                            time: formatTimeAgo(ts),
                            description: `Royalty payment: ${parseFloat(r.amount || '0').toFixed(2)} VTRU`,
                            hash: r.transaction_hash || r.transactionHash || r.tx_hash,
                            type: 'royalty'
                        };
                    }).filter(Boolean);
                }
            } catch (e) {
                debugWarn('Error fetching royalty payments:', e);
            }

            const allEvents = [...payoutEvents, ...royaltyEvents]
                .sort((a, b) => b.ts - a.ts)
                .slice(0, 10)
                .map(({ ts, ...rest }) => rest);

            setRecentEvents(allEvents);
        } catch (error) {
            criticalError('Error loading dashboard data:', error);
            setError('Failed to load dashboard data. Please try again later.');
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
    }, [isConnected, supabase, timeframe, toMs, getVibeAmount]); // Fixed dependencies

    // Add useEffect with proper dependencies and error boundaries
    useEffect(() => {
        let cancelled = false;
        
        const loadData = async () => {
            if (!cancelled) {
                await loadDashboardData();
            }
        };
        
        loadData();
        
        return () => {
            cancelled = true;
        };
    }, [loadDashboardData]); // Only depend on loadDashboardData which is properly memoized

    const formatTimeAgo = useCallback((timestamp) => {
        if (!timestamp || isNaN(timestamp)) return 'Unknown';

        const now = Date.now();
        const diffMs = now - timestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} min ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        const diffDays = Math.floor(diffHours / 24);
        return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    }, []);

    const formatVTRU = useCallback((amount) => `${amount} VTRU`, []);

    return (
        <div className="hp" style={{ maxWidth: 1400, margin: '3rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>VIBE Dashboard</h2>
                <p>Real-time analytics from Marketplace payouts (no fee-processor)</p>
            </div>

            {error && (
                <div className="error-message" style={{ 
                    padding: '1rem', 
                    margin: '1rem 0', 
                    background: 'rgba(255, 51, 102, 0.1)', 
                    border: '1px solid rgba(255, 51, 102, 0.3)', 
                    borderRadius: '8px',
                    color: '#ff3366'
                }}>
                    <p>{error}</p>
                </div>
            )}

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
                                            {event.hash ? (
                                                <a
                                                    href={`https://explorer.vitruveo.xyz/tx/${event.hash}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    {`${event.hash.slice(0, 6)}...${event.hash.slice(-4)}`}
                                                </a>
                                            ) : 'N/A'}
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