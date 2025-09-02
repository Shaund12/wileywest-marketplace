import React, { useState, useEffect } from 'react';
import { useSupabase } from '../context/SupabaseContext';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import './AuctionStyles.css';

function VibeDashboardPage() {
    const { supabase, isConnected } = useSupabase();
    const [stats, setStats] = useState({
        totalVTRUSent: '0',
        vtruSent24h: '0',
        vtruSent7d: '0',
        totalFeeConversions: 0,
        totalTransactions: 0
    });
    const [chartData, setChartData] = useState([]);
    const [feeSourceData, setFeeSourceData] = useState([]);
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

    const loadDashboardData = async () => {
        try {
            setLoading(true);
            
            if (!isConnected || !supabase) {
                debugWarn('Supabase not connected, showing no data');
                setStats({
                    totalVTRUSent: '0',
                    vtruSent24h: '0',
                    vtruSent7d: '0',
                    totalFeeConversions: 0,
                    totalTransactions: 0
                });
                setChartData([]);
                setFeeSourceData([]);
                setLeaderboards({ collections: [], royalties: [] });
                setRecentEvents([]);
                return;
            }

            // Calculate time boundaries
            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

            // Get timeframe boundaries based on current selection
            let timeframeBoundary;
            switch (timeframe) {
                case '30d':
                    timeframeBoundary = thirtyDaysAgo;
                    break;
                case '90d':
                    timeframeBoundary = ninetyDaysAgo;
                    break;
                default:
                    timeframeBoundary = sevenDaysAgo;
            }

            // Fetch VIBE flows (VTRU → VIBE conversions)
            const { data: vibeFlows, error: vibeError } = await supabase
                .from('vibe_flows')
                .select('amount_native_sent, timestamp, transaction_hash, block_number')
                .order('timestamp', { ascending: false });

            if (vibeError) {
                criticalError('Error fetching vibe flows:', vibeError);
            }

            // Fetch fee conversions (ERC20 → wVTRU)
            const { data: feeConversions, error: feeError } = await supabase
                .from('fee_conversions')
                .select('token_in, amount_in, wvtru_out, timestamp, transaction_hash')
                .order('timestamp', { ascending: false });

            if (feeError) {
                criticalError('Error fetching fee conversions:', feeError);
            }

            // Fetch breakdown data for collections
            const { data: auctionBreakdowns, error: auctionError } = await supabase
                .from('auction_breakdowns')
                .select('auction_id, platform_fee, royalty, vibe_amount, timestamp, transaction_hash');

            const { data: saleBreakdowns, error: saleError } = await supabase
                .from('sale_breakdowns')
                .select('listing_id, platform_fee, royalty, vibe_amount, timestamp, transaction_hash');

            if (auctionError) criticalError('Error fetching auction breakdowns:', auctionError);
            if (saleError) criticalError('Error fetching sale breakdowns:', saleError);

            // Fetch royalty payments
            const { data: royaltyPayments, error: royaltyError } = await supabase
                .from('royalty_payments')
                .select('recipient, amount, timestamp, transaction_hash')
                .order('timestamp', { ascending: false });

            if (royaltyError) {
                criticalError('Error fetching royalty payments:', royaltyError);
            }

            // Process the data
            const vibeFlowsData = vibeFlows || [];
            const feeConversionData = feeConversions || [];
            const auctionBreakdownData = auctionBreakdowns || [];
            const saleBreakdownData = saleBreakdowns || [];
            const royaltyData = royaltyPayments || [];

            // Calculate totals
            const totalVTRUSent = vibeFlowsData.reduce((sum, flow) => {
                return sum + parseFloat(flow.amount_native_sent || '0');
            }, 0);

            const vtruSent24h = vibeFlowsData
                .filter(flow => flow.timestamp * 1000 >= oneDayAgo.getTime())
                .reduce((sum, flow) => sum + parseFloat(flow.amount_native_sent || '0'), 0);

            const vtruSent7d = vibeFlowsData
                .filter(flow => flow.timestamp * 1000 >= sevenDaysAgo.getTime())
                .reduce((sum, flow) => sum + parseFloat(flow.amount_native_sent || '0'), 0);

            // Calculate conversion stats
            const totalFeeConversions = feeConversionData.length;
            const totalTransactions = vibeFlowsData.length + feeConversionData.length;

            setStats({
                totalVTRUSent: totalVTRUSent.toFixed(4),
                vtruSent24h: vtruSent24h.toFixed(4),
                vtruSent7d: vtruSent7d.toFixed(4),
                totalFeeConversions,
                totalTransactions
            });

            // Generate chart data for the timeframe
            const chartDataMap = new Map();
            const timeframeFlows = vibeFlowsData.filter(flow => 
                flow.timestamp * 1000 >= timeframeBoundary.getTime()
            );

            // Group by day
            timeframeFlows.forEach(flow => {
                const date = new Date(flow.timestamp * 1000).toISOString().split('T')[0];
                if (!chartDataMap.has(date)) {
                    chartDataMap.set(date, { vtruSent: 0, transactions: 0 });
                }
                const existing = chartDataMap.get(date);
                existing.vtruSent += parseFloat(flow.amount_native_sent || '0');
                existing.transactions += 1;
            });

            const chartDataArray = Array.from(chartDataMap.entries())
                .map(([date, data]) => ({ date, ...data }))
                .sort((a, b) => a.date.localeCompare(b.date));

            setChartData(chartDataArray);

            // Process fee source data by token
            const tokenMap = new Map();
            feeConversionData.forEach(conversion => {
                const token = conversion.token_in || 'Unknown';
                if (!tokenMap.has(token)) {
                    tokenMap.set(token, { amount: 0, count: 0 });
                }
                const existing = tokenMap.get(token);
                existing.amount += parseFloat(conversion.wvtru_out || '0');
                existing.count += 1;
            });

            const totalTokenAmount = Array.from(tokenMap.values())
                .reduce((sum, token) => sum + token.amount, 0);

            const feeSourceArray = Array.from(tokenMap.entries())
                .map(([token, data]) => ({
                    token: token.replace(/^0x[a-fA-F0-9]{40}$/, addr => `${addr.slice(0, 6)}...${addr.slice(-4)}`),
                    amount: data.amount.toFixed(4),
                    percentage: totalTokenAmount > 0 ? Math.round((data.amount / totalTokenAmount) * 100) : 0
                }))
                .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
                .slice(0, 10); // Top 10

            setFeeSourceData(feeSourceArray);

            // Process leaderboards (simplified - would need collection metadata for proper names)
            const platformFeeMap = new Map();
            const royaltyMap = new Map();

            [...auctionBreakdownData, ...saleBreakdownData].forEach(breakdown => {
                const id = breakdown.auction_id || breakdown.listing_id || 'Unknown';
                const platformFee = parseFloat(breakdown.platform_fee || '0');
                const royalty = parseFloat(breakdown.royalty || '0');

                if (!platformFeeMap.has(id)) {
                    platformFeeMap.set(id, 0);
                }
                platformFeeMap.set(id, platformFeeMap.get(id) + platformFee);

                if (royalty > 0) {
                    if (!royaltyMap.has(id)) {
                        royaltyMap.set(id, 0);
                    }
                    royaltyMap.set(id, royaltyMap.get(id) + royalty);
                }
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
                .map(([id, royalty]) => ({
                    collection: `Collection ${id.slice(0, 8)}...`,
                    recipient: id,
                    amount: royalty.toFixed(4)
                }))
                .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
                .slice(0, 5);

            setLeaderboards({
                collections: topCollections,
                royalties: topRoyalties
            });

            // Recent events (combine all types and sort by timestamp)
            const allEvents = [
                ...vibeFlowsData.slice(0, 10).map(flow => ({
                    time: formatTimeAgo(flow.timestamp * 1000),
                    description: `Converted ${parseFloat(flow.amount_native_sent).toFixed(2)} VTRU → VIBE`,
                    hash: flow.transaction_hash,
                    type: 'vibe_conversion'
                })),
                ...feeConversionData.slice(0, 10).map(conversion => ({
                    time: formatTimeAgo(conversion.timestamp * 1000),
                    description: `Converted ${parseFloat(conversion.amount_in || '0').toFixed(2)} tokens → ${parseFloat(conversion.wvtru_out || '0').toFixed(2)} VTRU`,
                    hash: conversion.transaction_hash,
                    type: 'fee_conversion'
                })),
                ...royaltyData.slice(0, 10).map(payment => ({
                    time: formatTimeAgo(payment.timestamp * 1000),
                    description: `Royalty payment: ${parseFloat(payment.amount).toFixed(2)} VTRU`,
                    hash: payment.transaction_hash,
                    type: 'royalty'
                }))
            ].sort((a, b) => {
                // Sort by recency (extract timestamp from time description)
                const getMinutesAgo = (timeStr) => {
                    if (timeStr.includes('min ago')) return parseInt(timeStr);
                    if (timeStr.includes('hour ago')) return parseInt(timeStr) * 60;
                    if (timeStr.includes('day ago')) return parseInt(timeStr) * 24 * 60;
                    return 999999;
                };
                return getMinutesAgo(a.time) - getMinutesAgo(b.time);
            }).slice(0, 10);

            setRecentEvents(allEvents);

        } catch (error) {
            criticalError('Error loading dashboard data:', error);
            // Set empty data on error
            setStats({
                totalVTRUSent: '0',
                vtruSent24h: '0',
                vtruSent7d: '0',
                totalFeeConversions: 0,
                totalTransactions: 0
            });
            setChartData([]);
            setFeeSourceData([]);
            setLeaderboards({ collections: [], royalties: [] });
            setRecentEvents([]);
        } finally {
            setLoading(false);
        }
    };

    // Helper function to format time ago
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

    const formatVTRU = (amount) => {
        return `${amount} VTRU`;
    };

    return (
        <div className="hp" style={{ maxWidth: 1400, margin: '3rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>VIBE Dashboard</h2>
                <p>Real-time analytics for VTRU → VIBE fee conversions</p>
            </div>

            {loading ? (
                <div className="loading-message">
                    <p>Loading dashboard data...</p>
                </div>
            ) : (
                <>
                    {/* KPI Cards */}
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
                                <div className="kpi-subtitle">+12% from yesterday</div>
                            </div>
                            <div className="kpi-card">
                                <div className="kpi-label">Last 7 Days</div>
                                <div className="kpi-value">{formatVTRU(stats.vtruSent7d)}</div>
                                <div className="kpi-subtitle">+8% from last week</div>
                            </div>
                            <div className="kpi-card">
                                <div className="kpi-label">Fee Conversions</div>
                                <div className="kpi-value">{stats.totalFeeConversions}</div>
                                <div className="kpi-subtitle">Successful swaps</div>
                            </div>
                        </div>
                    </section>

                    {/* Charts Section */}
                    <section className="charts-section">
                        <div className="chart-container">
                            <div className="chart-header">
                                <h3>VTRU → VIBE Over Time</h3>
                                <div className="timeframe-selector">
                                    <button 
                                        className={timeframe === '7d' ? 'active' : ''}
                                        onClick={() => setTimeframe('7d')}
                                    >
                                        7 Days
                                    </button>
                                    <button 
                                        className={timeframe === '30d' ? 'active' : ''}
                                        onClick={() => setTimeframe('30d')}
                                    >
                                        30 Days
                                    </button>
                                    <button 
                                        className={timeframe === '90d' ? 'active' : ''}
                                        onClick={() => setTimeframe('90d')}
                                    >
                                        90 Days
                                    </button>
                                </div>
                            </div>
                            <div className="simple-chart">
                                {/* Real data-based chart representation */}
                                <div className="chart-data">
                                    {chartData.length > 0 ? (
                                        chartData.slice(-7).map((point, index) => (
                                            <div key={index} className="chart-point">
                                                <span className="date">{point.date}</span>
                                                <span className="value">{point.vtruSent.toFixed(2)} VTRU</span>
                                                <span className="transactions">{point.transactions} tx</span>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="no-data-message">
                                            <p>No VTRU → VIBE conversion data available for selected timeframe</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="chart-container">
                            <h3>Fee Sources by Token</h3>
                            <div className="fee-sources">
                                {feeSourceData.length > 0 ? (
                                    feeSourceData.map((source, index) => (
                                        <div key={index} className="fee-source-item">
                                            <div className="token-info">
                                                <span className="token-name">{source.token}</span>
                                                <span className="token-amount">{source.amount} VTRU</span>
                                            </div>
                                            <div className="percentage-bar">
                                                <div 
                                                    className="percentage-fill" 
                                                    style={{ width: `${source.percentage}%` }}
                                                ></div>
                                            </div>
                                            <span className="percentage-text">{source.percentage}%</span>
                                        </div>
                                    ))
                                ) : (
                                    <div className="no-data-message">
                                        <p>No fee conversion data available</p>
                                    </div>
                                )}
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
                        <h3>Recent Fee Conversion Events</h3>
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
                                    <p>No recent fee conversion events available</p>
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