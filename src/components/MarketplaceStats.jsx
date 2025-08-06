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
        // Time-based metrics
        volume24h,
        volume7d,
        volume30d,
        volumeAllTime,
        sales24h,
        sales7d,
        sales30d,
        transactionHistory,
        topTokens,
        mostActiveSellers
    } = marketplaceStats;

    const tabs = [
        { id: 'overview', label: 'Overview' },
        { id: 'volume', label: 'Volume Analytics' },
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
                                    ${totalSales > 0 ? formatPrice((volumeAllTime || actualSoldVolume) / totalSales) : '0.00'}
                                </p>
                                <span className="stat-label">Per transaction</span>
                            </div>
                        </div>
                        
                        {/* Quick Volume Summary */}
                        <div className="volume-summary">
                            <h3>📅 Volume by Time Period</h3>
                            <div className="volume-periods">
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
                    </div>
                )}

                {activeTab === 'volume' && (
                    <div className="volume-analytics">
                        <h3>📊 Comprehensive Volume Analytics</h3>
                        
                        <div className="volume-metrics-grid">
                            <div className="volume-metric-card">
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
                            
                            <div className="volume-metric-card highlight">
                                <h4>🏆 All Time Activity</h4>
                                <div className="metric-details">
                                    <div className="metric-row">
                                        <span>Volume:</span>
                                        <span className="metric-value">${formatPrice(volumeAllTime || actualSoldVolume || 0)}</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Sales:</span>
                                        <span className="metric-value">{totalSales} transactions</span>
                                    </div>
                                    <div className="metric-row">
                                        <span>Avg Sale:</span>
                                        <span className="metric-value">
                                            ${totalSales > 0 ? formatPrice((volumeAllTime || actualSoldVolume || 0) / totalSales) : '0.00'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        {/* Volume Comparison */}
                        <div className="volume-comparison">
                            <h4>📈 Volume Trends</h4>
                            <div className="comparison-items">
                                <div className="comparison-item">
                                    <span className="comparison-label">Market Velocity (24h vs 7d avg):</span>
                                    <span className="comparison-value">
                                        {volume7d > 0 ? 
                                            `${((volume24h || 0) / ((volume7d || 0) / 7) * 100).toFixed(1)}%` : 
                                            'N/A'
                                        }
                                    </span>
                                </div>
                                <div className="comparison-item">
                                    <span className="comparison-label">Monthly Progress:</span>
                                    <span className="comparison-value">
                                        {volume30d > 0 ? 
                                            `${((volume7d || 0) / (volume30d || 0) * 100).toFixed(1)}%` : 
                                            'N/A'
                                        }
                                    </span>
                                </div>
                                <div className="comparison-item">
                                    <span className="comparison-label">Current Listings vs Sold Volume:</span>
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

                {activeTab === 'transactions' && (
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