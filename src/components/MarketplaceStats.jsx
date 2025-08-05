import React, { useState } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { formatTokenAmount, getTokenSymbol } from '../utils/tokenUtils';

function MarketplaceStats() {
    const { marketplaceStats } = useMarketplace();
    const [activeTab, setActiveTab] = useState('overview');

    const {
        totalSales,
        actualSoldVolume,
        currentListingVolume,
        transactionHistory,
        topTokens,
        mostActiveSellers
    } = marketplaceStats;

    const tabs = [
        { id: 'overview', label: 'Overview' },
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

    return (
        <div className="marketplace-stats-container">
            <h2>Marketplace Statistics</h2>
            
            {/* Tab Navigation */}
            <div className="stats-tabs">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="stats-content">
                {activeTab === 'overview' && (
                    <div className="overview-stats">
                        <div className="stats-grid">
                            <div className="stat-card">
                                <h3>Total Sales</h3>
                                <p className="stat-value">{totalSales}</p>
                                <span className="stat-label">Completed Transactions</span>
                            </div>
                            <div className="stat-card">
                                <h3>Actual Sold Volume</h3>
                                <p className="stat-value">${formatPrice(actualSoldVolume)}</p>
                                <span className="stat-label">USDC Value</span>
                            </div>
                            <div className="stat-card">
                                <h3>Current Listing Volume</h3>
                                <p className="stat-value">${formatPrice(currentListingVolume)}</p>
                                <span className="stat-label">Active Listings (USDC)</span>
                            </div>
                            <div className="stat-card">
                                <h3>Average Sale Price</h3>
                                <p className="stat-value">
                                    ${totalSales > 0 ? formatPrice(actualSoldVolume / totalSales) : '0.00'}
                                </p>
                                <span className="stat-label">Per Transaction</span>
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
                                <p>No transactions recorded yet</p>
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