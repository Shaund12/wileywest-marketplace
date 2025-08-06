import React, { useState } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { formatTokenAmount, getTokenSymbol } from '../utils/tokenUtils';

function MarketplaceStats() {
    const { marketplaceStats, refreshBlockchainData, salesHistory, status } = useMarketplace();
    const [activeTab, setActiveTab] = useState('overview');
    const [isRefreshing, setIsRefreshing] = useState(false);

    const {
        totalSales,
        actualSoldVolume,
        currentListingVolume,
        // Enhanced time-based metrics
        volume1h,
        volume6h,
        volume12h,
        volume24h,
        volume7d,
        volume30d,
        volumeAllTime,
        sales1h,
        sales6h,
        sales12h,
        sales24h,
        sales7d,
        sales30d,
        // Advanced analytics
        avgPrice,
        highestPrice,
        lowestPrice,
        marketCap,
        liquidityRatio,
        marketVelocity24h,
        marketVelocity7d,
        growthRate24h,
        growthRate7d,
        marketHealthScore,
        turnoverRate,
        uniqueBuyers,
        hourlyVolume,
        dailyVolume,
        priceHistory,
        transactionHistory,
        topTokens,
        mostActiveSellers
    } = marketplaceStats;

    const tabs = [
        { id: 'overview', label: 'Overview' },
        { id: 'volume', label: 'Volume Analytics' },
        { id: 'advanced', label: 'Advanced Metrics' },
        { id: 'trends', label: 'Market Trends' },
        { id: 'transactions', label: 'Transaction History' },
        { id: 'tokens', label: 'Top Tokens' },
        { id: 'sellers', label: 'Active Sellers' }
    ];

    const formatAddress = (address) => {
        if (!address) return 'Unknown';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    };

    const formatPrice = (value) => {
        if (typeof value === 'number') {
            return value < 0.01 ? value.toFixed(6) : value.toFixed(2);
        }
        return '0.00';
    };

    const handleRefresh = async () => {
        if (refreshBlockchainData) {
            setIsRefreshing(true);
            try {
                await refreshBlockchainData();
                console.log("Marketplace stats refreshed from blockchain");
            } catch (error) {
                console.error("Error refreshing blockchain data:", error);
            } finally {
                setIsRefreshing(false);
            }
        }
    };

    return (
        <div className="marketplace-stats-container">
            <div className="stats-header">
                <h2>Marketplace Statistics</h2>
                <button 
                    className={`refresh-button ${isRefreshing ? 'refreshing' : ''}`}
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                >
                    {isRefreshing ? '🔄 Refreshing...' : '🔄 Refresh'}
                </button>
            </div>
            
            {/* Show data status */}
            {salesHistory.length === 0 && !status.includes('demo mode') && (
                <div className="data-status-notice">
                    <p>📊 No transaction data found. Try refreshing to fetch the latest blockchain events from the complete marketplace history.</p>
                    <button className="refresh-data-button" onClick={handleRefresh} disabled={isRefreshing}>
                        {isRefreshing ? 'Scanning Blockchain...' : '🔍 Scan All Blockchain History'}
                    </button>
                </div>
            )}
            
            {/* Show loading status */}
            {status && (status.includes('Fetching') || status.includes('Scanning') || status.includes('Processing')) && (
                <div className="loading-status-notice">
                    <p>🔄 {status}</p>
                </div>
            )}
            
            {/* Tab Navigation */}
            <div className="stats-tabs">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        {tab.label}
                        {tab.id === 'transactions' && salesHistory.length > 0 && (
                            <span className="tab-badge">{salesHistory.length}</span>
                        )}
                        {tab.id === 'volume' && totalSales > 0 && (
                            <span className="tab-badge">📊</span>
                        )}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="stats-content">
                {activeTab === 'overview' && (
                    <div className="overview-stats">
                        <div className="stats-grid">
                            <div className="stat-card highlight">
                                <h3>🔥 1h Volume</h3>
                                <p className="stat-value">${formatPrice(volume1h || 0)}</p>
                                <span className="stat-label">{sales1h || 0} sales last hour</span>
                            </div>
                            <div className="stat-card highlight">
                                <h3>🔥 24h Volume</h3>
                                <p className="stat-value">${formatPrice(volume24h || 0)}</p>
                                <span className="stat-label">{sales24h || 0} sales in last 24 hours</span>
                            </div>
                            <div className="stat-card">
                                <h3>📈 Total Volume (All Time)</h3>
                                <p className="stat-value">${formatPrice(volumeAllTime || actualSoldVolume || 0)}</p>
                                <span className="stat-label">{totalSales} total transactions</span>
                            </div>
                            <div className="stat-card">
                                <h3>💰 Current Listings</h3>
                                <p className="stat-value">${formatPrice(currentListingVolume)}</p>
                                <span className="stat-label">Available for purchase</span>
                            </div>
                            <div className="stat-card">
                                <h3>📊 Average Sale</h3>
                                <p className="stat-value">
                                    ${formatPrice(avgPrice || 0)}
                                </p>
                                <span className="stat-label">Per transaction</span>
                            </div>
                            <div className="stat-card">
                                <h3>🏆 Market Health</h3>
                                <p className="stat-value">{formatPrice(marketHealthScore || 0)}/100</p>
                                <span className="stat-label">
                                    {marketHealthScore >= 75 ? '🟢 Excellent' : 
                                     marketHealthScore >= 50 ? '🟡 Good' : 
                                     marketHealthScore >= 25 ? '🟠 Fair' : '🔴 Poor'}
                                </span>
                            </div>
                        </div>
                        
                        {/* Enhanced Volume Summary */}
                        <div className="volume-summary">
                            <h3>📅 Volume by Time Period</h3>
                            <div className="volume-periods">
                                <div className="period-item">
                                    <span className="period-label">1 Hour:</span>
                                    <span className="period-value">${formatPrice(volume1h || 0)} ({sales1h || 0} sales)</span>
                                </div>
                                <div className="period-item">
                                    <span className="period-label">6 Hours:</span>
                                    <span className="period-value">${formatPrice(volume6h || 0)} ({sales6h || 0} sales)</span>
                                </div>
                                <div className="period-item">
                                    <span className="period-label">12 Hours:</span>
                                    <span className="period-value">${formatPrice(volume12h || 0)} ({sales12h || 0} sales)</span>
                                </div>
                                <div className="period-item">
                                    <span className="period-label">24 Hours:</span>
                                    <span className="period-value">${formatPrice(volume24h || 0)} ({sales24h || 0} sales)</span>
                                </div>
                                <div className="period-item">
                                    <span className="period-label">7 Days:</span>
                                    <span className="period-value">${formatPrice(volume7d || 0)} ({sales7d || 0} sales)</span>
                                </div>
                                <div className="period-item">
                                    <span className="period-label">30 Days:</span>
                                    <span className="period-value">${formatPrice(volume30d || 0)} ({sales30d || 0} sales)</span>
                                </div>
                                <div className="period-item">
                                    <span className="period-label">All Time:</span>
                                    <span className="period-value">${formatPrice(volumeAllTime || actualSoldVolume || 0)} ({totalSales} sales)</span>
                                </div>
                            </div>
                        </div>
                        
                        {/* Quick Analytics Summary */}
                        <div className="quick-analytics">
                            <h3>🚀 Quick Insights</h3>
                            <div className="insight-items">
                                <div className="insight-item">
                                    <span className="insight-label">👥 Unique Buyers:</span>
                                    <span className="insight-value">{uniqueBuyers || 0}</span>
                                </div>
                                <div className="insight-item">
                                    <span className="insight-label">🏆 Highest Sale:</span>
                                    <span className="insight-value">${formatPrice(highestPrice || 0)}</span>
                                </div>
                                <div className="insight-item">
                                    <span className="insight-label">💎 Floor Price:</span>
                                    <span className="insight-value">${formatPrice(lowestPrice || 0)}</span>
                                </div>
                                <div className="insight-item">
                                    <span className="insight-label">⚡ Market Velocity:</span>
                                    <span className="insight-value">{formatPrice((marketVelocity24h || 0) * 100)}%</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'volume' && (
                    <div className="volume-analytics">
                        <h3>📊 Comprehensive Volume Analytics</h3>
                        
                        <div className="volume-metrics-grid">
                            <div className="volume-metric-card">
                                <h4>⚡ 1 Hour Activity</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Volume:</span>
                                        <span className="metric-value">${formatPrice(volume1h || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Sales:</span>
                                        <span className="metric-value">{sales1h || 0} transactions</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Avg Sale:</span>
                                        <span className="metric-value">
                                            ${(sales1h || 0) > 0 ? formatPrice((volume1h || 0) / (sales1h || 1)) : '0.00'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="volume-metric-card">
                                <h4>🔥 6 Hour Activity</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Volume:</span>
                                        <span className="metric-value">${formatPrice(volume6h || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Sales:</span>
                                        <span className="metric-value">{sales6h || 0} transactions</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Avg Sale:</span>
                                        <span className="metric-value">
                                            ${(sales6h || 0) > 0 ? formatPrice((volume6h || 0) / (sales6h || 1)) : '0.00'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="volume-metric-card">
                                <h4>🔥 12 Hour Activity</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Volume:</span>
                                        <span className="metric-value">${formatPrice(volume12h || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Sales:</span>
                                        <span className="metric-value">{sales12h || 0} transactions</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Avg Sale:</span>
                                        <span className="metric-value">
                                            ${(sales12h || 0) > 0 ? formatPrice((volume12h || 0) / (sales12h || 1)) : '0.00'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="volume-metric-card highlight">
                                <h4>🔥 24 Hour Activity</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Volume:</span>
                                        <span className="metric-value">${formatPrice(volume24h || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Sales:</span>
                                        <span className="metric-value">{sales24h || 0} transactions</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Avg Sale:</span>
                                        <span className="metric-value">
                                            ${(sales24h || 0) > 0 ? formatPrice((volume24h || 0) / (sales24h || 1)) : '0.00'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="volume-metric-card">
                                <h4>📅 7 Day Activity</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Volume:</span>
                                        <span className="metric-value">${formatPrice(volume7d || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Sales:</span>
                                        <span className="metric-value">{sales7d || 0} transactions</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Avg Sale:</span>
                                        <span className="metric-value">
                                            ${(sales7d || 0) > 0 ? formatPrice((volume7d || 0) / (sales7d || 1)) : '0.00'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="volume-metric-card">
                                <h4>🗓️ 30 Day Activity</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Volume:</span>
                                        <span className="metric-value">${formatPrice(volume30d || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Sales:</span>
                                        <span className="metric-value">{sales30d || 0} transactions</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Avg Sale:</span>
                                        <span className="metric-value">
                                            ${(sales30d || 0) > 0 ? formatPrice((volume30d || 0) / (sales30d || 1)) : '0.00'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        {/* Enhanced Volume Comparison */}
                        <div className="volume-comparison">
                            <h4>📈 Volume Trends & Performance</h4>
                            <div className="comparison-items">
                                <div className="comparison-item">
                                    <span className="comparison-label">Hourly Velocity (1h vs 24h avg):</span>
                                    <span className="comparison-value">
                                        {volume24h > 0 ? 
                                            `${((volume1h || 0) / ((volume24h || 0) / 24) * 100).toFixed(1)}%` : 
                                            'N/A'
                                        }
                                    </span>
                                </div>
                                <div className="comparison-item">
                                    <span className="comparison-label">Daily Velocity (24h vs 7d avg):</span>
                                    <span className="comparison-value">
                                        {volume7d > 0 ? 
                                            `${((volume24h || 0) / ((volume7d || 0) / 7) * 100).toFixed(1)}%` : 
                                            'N/A'
                                        }
                                    </span>
                                </div>
                                <div className="comparison-item">
                                    <span className="comparison-label">Weekly Velocity (7d vs 30d avg):</span>
                                    <span className="comparison-value">
                                        {volume30d > 0 ? 
                                            `${((volume7d || 0) / ((volume30d || 0) / 30) * 100).toFixed(1)}%` : 
                                            'N/A'
                                        }
                                    </span>
                                </div>
                                <div className="comparison-item">
                                    <span className="comparison-label">Market Penetration (listings vs sold):</span>
                                    <span className="comparison-value">
                                        {(volumeAllTime || actualSoldVolume) > 0 ? 
                                            `${(currentListingVolume / (volumeAllTime || actualSoldVolume || 1) * 100).toFixed(1)}%` : 
                                            'N/A'
                                        }
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'advanced' && (
                    <div className="advanced-analytics">
                        <h3>🎯 Advanced Market Analytics</h3>
                        
                        <div className="advanced-metrics-grid">
                            <div className="advanced-metric-card">
                                <h4>💎 Price Analytics</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Average Price:</span>
                                        <span className="metric-value">${formatPrice(avgPrice || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Highest Sale:</span>
                                        <span className="metric-value">${formatPrice(highestPrice || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Floor Price:</span>
                                        <span className="metric-value">${formatPrice(lowestPrice || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Price Range:</span>
                                        <span className="metric-value">
                                            ${formatPrice((highestPrice || 0) - (lowestPrice || 0))}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="advanced-metric-card">
                                <h4>📊 Market Dynamics</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Market Cap:</span>
                                        <span className="metric-value">${formatPrice(marketCap || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Liquidity Ratio:</span>
                                        <span className="metric-value">{formatPrice((liquidityRatio || 0) * 100)}%</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Turnover Rate:</span>
                                        <span className="metric-value">{formatPrice(turnoverRate || 0)}%</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Unique Buyers:</span>
                                        <span className="metric-value">{uniqueBuyers || 0}</span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="advanced-metric-card">
                                <h4>⚡ Market Velocity</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>24h Velocity:</span>
                                        <span className="metric-value">{formatPrice((marketVelocity24h || 0) * 100)}%</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>7d Velocity:</span>
                                        <span className="metric-value">{formatPrice((marketVelocity7d || 0) * 100)}%</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Market Momentum:</span>
                                        <span className="metric-value">
                                            {(marketVelocity24h || 0) > 1 ? '🚀 Accelerating' :
                                             (marketVelocity24h || 0) > 0.5 ? '📈 Growing' :
                                             (marketVelocity24h || 0) > 0.1 ? '➡️ Stable' : '📉 Declining'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="advanced-metric-card highlight">
                                <h4>🏆 Market Health Score</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Overall Health:</span>
                                        <span className="metric-value">{formatPrice(marketHealthScore || 0)}/100</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Health Rating:</span>
                                        <span className="metric-value">
                                            {marketHealthScore >= 75 ? '🟢 Excellent' : 
                                             marketHealthScore >= 50 ? '🟡 Good' : 
                                             marketHealthScore >= 25 ? '🟠 Fair' : '🔴 Poor'}
                                        </span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Growth Rate (24h):</span>
                                        <span className="metric-value">{formatPrice(growthRate24h || 0)}%</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Growth Rate (7d):</span>
                                        <span className="metric-value">{formatPrice(growthRate7d || 0)}%</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        {/* Market Insights */}
                        <div className="market-insights">
                            <h4>🔍 Market Insights</h4>
                            <div className="insight-cards">
                                <div className="insight-card">
                                    <h5>📈 Trading Activity</h5>
                                    <p>
                                        {(sales24h || 0) > (sales7d || 0) / 7 ? 
                                            `Trading activity is ${((sales24h || 0) / ((sales7d || 0) / 7 || 1) * 100).toFixed(0)}% above average` :
                                            `Trading activity is ${(100 - (sales24h || 0) / ((sales7d || 0) / 7 || 1) * 100).toFixed(0)}% below average`
                                        }
                                    </p>
                                </div>
                                <div className="insight-card">
                                    <h5>💰 Volume Trend</h5>
                                    <p>
                                        {(volume24h || 0) > (volume7d || 0) / 7 ? 
                                            `Volume is trending ${((volume24h || 0) / ((volume7d || 0) / 7 || 1)).toFixed(1)}x above the weekly average` :
                                            `Volume is ${(((volume7d || 0) / 7 || 1) / (volume24h || 1)).toFixed(1)}x below the weekly average`
                                        }
                                    </p>
                                </div>
                                <div className="insight-card">
                                    <h5>🎯 Market Position</h5>
                                    <p>
                                        {(liquidityRatio || 0) > 0.5 ? 
                                            'High liquidity market with strong available inventory' :
                                            (liquidityRatio || 0) > 0.2 ?
                                            'Balanced market with moderate liquidity' :
                                            'High demand market with limited available inventory'
                                        }
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'trends' && (
                    <div className="market-trends">
                        <h3>📈 Market Trends & Patterns</h3>
                        
                        {/* Growth Rates */}
                        <div className="trends-section">
                            <h4>🚀 Growth Analysis</h4>
                            <div className="trends-grid">
                                <div className="trend-card">
                                    <h5>24h Growth Rate</h5>
                                    <div className="trend-value">
                                        <span className={`growth-indicator ${(growthRate24h || 0) >= 0 ? 'positive' : 'negative'}`}>
                                            {(growthRate24h || 0) >= 0 ? '📈' : '📉'} {formatPrice(Math.abs(growthRate24h || 0))}%
                                        </span>
                                    </div>
                                    <p>Compared to previous 24h period</p>
                                </div>
                                
                                <div className="trend-card">
                                    <h5>7d Growth Rate</h5>
                                    <div className="trend-value">
                                        <span className={`growth-indicator ${(growthRate7d || 0) >= 0 ? 'positive' : 'negative'}`}>
                                            {(growthRate7d || 0) >= 0 ? '📈' : '📉'} {formatPrice(Math.abs(growthRate7d || 0))}%
                                        </span>
                                    </div>
                                    <p>Compared to previous 7d period</p>
                                </div>
                                
                                <div className="trend-card">
                                    <h5>Market Momentum</h5>
                                    <div className="trend-value">
                                        <span className="momentum-indicator">
                                            {(marketVelocity24h || 0) > 1.5 ? '🚀 High' :
                                             (marketVelocity24h || 0) > 1 ? '📈 Moderate' :
                                             (marketVelocity24h || 0) > 0.5 ? '➡️ Stable' : '📉 Low'}
                                        </span>
                                    </div>
                                    <p>Current trading momentum</p>
                                </div>
                            </div>
                        </div>
                        
                        {/* Volume Distribution */}
                        {hourlyVolume && hourlyVolume.length > 0 && (
                            <div className="trends-section">
                                <h4>⏰ 24h Volume Distribution</h4>
                                <div className="volume-distribution">
                                    <div className="volume-bars">
                                        {hourlyVolume.slice(0, 24).map((vol, index) => (
                                            <div key={index} className="volume-bar">
                                                <div 
                                                    className="bar-fill" 
                                                    style={{ 
                                                        height: `${Math.max((vol / Math.max(...hourlyVolume) * 100), 2)}%` 
                                                    }}
                                                    title={`${index}h ago: $${formatPrice(vol)}`}
                                                ></div>
                                                <span className="bar-label">{index}h</span>
                                            </div>
                                        ))}
                                    </div>
                                    <p>Volume distribution over the last 24 hours</p>
                                </div>
                            </div>
                        )}
                        
                        {/* Price Trends */}
                        {priceHistory && priceHistory.length > 0 && (
                            <div className="trends-section">
                                <h4>💰 Recent Price Activity</h4>
                                <div className="price-trends">
                                    <div className="price-stats">
                                        <div className="price-stat">
                                            <span className="stat-label">Recent High:</span>
                                            <span className="stat-value">${formatPrice(Math.max(...priceHistory.slice(0, 10).map(p => p.price)))}</span>
                                        </div>
                                        <div className="price-stat">
                                            <span className="stat-label">Recent Low:</span>
                                            <span className="stat-value">${formatPrice(Math.min(...priceHistory.slice(0, 10).map(p => p.price)))}</span>
                                        </div>
                                        <div className="price-stat">
                                            <span className="stat-label">Price Volatility:</span>
                                            <span className="stat-value">
                                                {priceHistory.length > 1 ? 
                                                    `${((Math.max(...priceHistory.slice(0, 10).map(p => p.price)) / Math.min(...priceHistory.slice(0, 10).map(p => p.price)) - 1) * 100).toFixed(1)}%` :
                                                    'N/A'
                                                }
                                            </span>
                                        </div>
                                    </div>
                                    <div className="recent-sales">
                                        <h5>📊 Recent Sales Pattern</h5>
                                        {priceHistory.slice(0, 5).map((sale, index) => (
                                            <div key={index} className="recent-sale">
                                                <span className="sale-price">${formatPrice(sale.price)}</span>
                                                <span className="sale-time">{new Date(sale.timestamp).toLocaleString()}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                    <div className="transaction-history">
                        <h3>Recent Transactions</h3>
                        {transactionHistory.length > 0 ? (
                            <div className="transactions-table">
                                <div className="table-header">
                                    <span>Buyer</span>
                                    <span>Price</span>
                                    <span>Token</span>
                                    <span>Date</span>
                                </div>
                                {transactionHistory.map((tx, index) => (
                                    <div key={index} className="table-row">
                                        <span className="buyer-address">{formatAddress(tx.buyer)}</span>
                                        <span className="price-amount">
                                            {formatTokenAmount(tx.totalPrice, tx.paymentToken)}
                                        </span>
                                        <span className="token-symbol">
                                            {getTokenSymbol(tx.paymentToken)}
                                        </span>
                                        <span className="transaction-date">{tx.formattedTimestamp}</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="no-data">
                                <p>🔍 No transactions found</p>
                                <p>Recent purchases may take a few minutes to appear. Try refreshing the data.</p>
                                <button className="refresh-data-button" onClick={handleRefresh} disabled={isRefreshing}>
                                    {isRefreshing ? 'Refreshing...' : 'Refresh Transaction Data'}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'tokens' && (
                    <div className="top-tokens">
                        <h3>Top Payment Tokens</h3>
                        {topTokens.length > 0 ? (
                            <div className="tokens-list">
                                {topTokens.map((token, index) => (
                                    <div key={index} className="token-item">
                                        <div className="token-rank">#{index + 1}</div>
                                        <div className="token-info">
                                            <span className="token-symbol">{getTokenSymbol(token.token)}</span>
                                            <span className="token-volume">${formatPrice(token.volume)} volume</span>
                                            <span className="token-sales">{token.sales} sales</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="no-data">
                                <p>No token data available yet</p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'sellers' && (
                    <div className="active-sellers">
                        <h3>Most Active Sellers</h3>
                        {mostActiveSellers.length > 0 ? (
                            <div className="sellers-list">
                                {mostActiveSellers.map((seller, index) => (
                                    <div key={index} className="seller-item">
                                        <div className="seller-rank">#{index + 1}</div>
                                        <div className="seller-info">
                                            <span className="seller-address">{formatAddress(seller.address)}</span>
                                            <span className="seller-listings">{seller.listingsCount} active listings</span>
                                            <span className="seller-volume">${formatPrice(seller.totalVolume)} total</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="no-data">
                                <p>No seller data available yet</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default MarketplaceStats;