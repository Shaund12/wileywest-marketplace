import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAuctionsEnabled } from '../utils/featureFlags';

function VibeDashboardPage() {
    const navigate = useNavigate();
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
    const [loading, setLoading] = useState(true);
    const [timeframe, setTimeframe] = useState('7d');

    useEffect(() => {
        if (!isAuctionsEnabled()) {
            navigate('/marketplace');
            return;
        }

        loadDashboardData();
    }, [navigate, timeframe]);

    const loadDashboardData = async () => {
        try {
            setLoading(true);
            
            // TODO: Load real data from Supabase/indexer
            // For now, using mock data
            
            setStats({
                totalVTRUSent: '1,250.75',
                vtruSent24h: '45.2',
                vtruSent7d: '312.8',
                totalFeeConversions: 89,
                totalTransactions: 156
            });

            // Mock chart data for VTRU → VIBE over time
            const now = Date.now();
            const mockChartData = Array.from({ length: 30 }, (_, i) => ({
                date: new Date(now - (29 - i) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                vtruSent: Math.random() * 50 + 10,
                transactions: Math.floor(Math.random() * 10 + 1)
            }));
            setChartData(mockChartData);

            // Mock fee source data
            setFeeSourceData([
                { token: 'USDC', amount: '450.2', percentage: 35 },
                { token: 'VUSD', amount: '320.1', percentage: 25 },
                { token: 'SEVO', amount: '280.5', percentage: 22 },
                { token: 'VTRO', amount: '199.95', percentage: 18 }
            ]);

            // Mock leaderboards
            setLeaderboards({
                collections: [
                    { name: 'Cosmic Dreams', address: '0xabc...123', platformFees: '125.5', royalties: '89.2' },
                    { name: 'Digital Warriors', address: '0xdef...456', platformFees: '98.3', royalties: '67.1' },
                    { name: 'Cyber Punks', address: '0x123...789', platformFees: '76.8', royalties: '45.6' }
                ],
                royalties: [
                    { collection: 'Cosmic Dreams', recipient: '0xabc...123', amount: '89.2' },
                    { collection: 'Digital Warriors', recipient: '0xdef...456', amount: '67.1' },
                    { collection: 'Cyber Punks', recipient: '0x123...789', amount: '45.6' }
                ]
            });

        } catch (error) {
            console.error('Error loading dashboard data:', error);
        } finally {
            setLoading(false);
        }
    };

    const formatVTRU = (amount) => {
        return `${amount} VTRU`;
    };

    if (!isAuctionsEnabled()) {
        return null;
    }

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
                                {/* Simple text-based chart representation */}
                                <div className="chart-data">
                                    {chartData.slice(-7).map((point, index) => (
                                        <div key={index} className="chart-point">
                                            <span className="date">{point.date}</span>
                                            <span className="value">{point.vtruSent.toFixed(2)} VTRU</span>
                                            <span className="transactions">{point.transactions} tx</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="chart-container">
                            <h3>Fee Sources by Token</h3>
                            <div className="fee-sources">
                                {feeSourceData.map((source, index) => (
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
                                ))}
                            </div>
                        </div>
                    </section>

                    {/* Leaderboards */}
                    <section className="leaderboards-section">
                        <div className="leaderboard-container">
                            <h3>Top Collections by Platform Fees</h3>
                            <div className="leaderboard">
                                {leaderboards.collections.map((collection, index) => (
                                    <div key={index} className="leaderboard-item">
                                        <span className="rank">#{index + 1}</span>
                                        <span className="name">{collection.name}</span>
                                        <span className="value">{formatVTRU(collection.platformFees)}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="leaderboard-container">
                            <h3>Top Royalty Recipients</h3>
                            <div className="leaderboard">
                                {leaderboards.royalties.map((royalty, index) => (
                                    <div key={index} className="leaderboard-item">
                                        <span className="rank">#{index + 1}</span>
                                        <span className="name">{royalty.collection}</span>
                                        <span className="value">{formatVTRU(royalty.amount)}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </section>

                    {/* Events Feed */}
                    <section className="events-section">
                        <h3>Recent Fee Conversion Events</h3>
                        <div className="events-feed">
                            <div className="event-item">
                                <span className="event-time">2 min ago</span>
                                <span className="event-description">
                                    Converted 25.5 USDC → 24.8 VTRU → VIBE
                                </span>
                                <span className="event-tx">
                                    <a href="#" target="_blank" rel="noopener noreferrer">
                                        0x1234...5678
                                    </a>
                                </span>
                            </div>
                            <div className="event-item">
                                <span className="event-time">5 min ago</span>
                                <span className="event-description">
                                    Converted 18.2 VUSD → 17.9 VTRU → VIBE
                                </span>
                                <span className="event-tx">
                                    <a href="#" target="_blank" rel="noopener noreferrer">
                                        0x9876...5432
                                    </a>
                                </span>
                            </div>
                            <div className="event-item">
                                <span className="event-time">8 min ago</span>
                                <span className="event-description">
                                    Royalty payment: 12.5 VTRU to Cosmic Dreams creator
                                </span>
                                <span className="event-tx">
                                    <a href="#" target="_blank" rel="noopener noreferrer">
                                        0xabcd...efgh
                                    </a>
                                </span>
                            </div>
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}

export default VibeDashboardPage;