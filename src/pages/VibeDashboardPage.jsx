import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useWallet } from '../context/WalletContext';
import { ethers } from 'ethers';
import MarketplaceAbi from '../abi/VTRUNFTMarketplace.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import { getTokenDecimals, formatTokenAmount } from '../utils/tokenUtils';
import './AuctionStyles.css';

function VibeDashboardPage() {
    const { provider } = useWallet();
    const marketplaceAddress = import.meta.env.VITE_MARKETPLACE_ADDRESS;
    const [stats, setStats] = useState({
        // VIBE (VTRU) payouts computed from blockchain events directly
        totalVTRUSent: '0',
        vtruSent24h: '0',
        vtruSent7d: '0',
        // Added stats from blockchain events
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
    const [status, setStatus] = useState('');
    const [timeframe, setTimeframe] = useState('7d');
    const [error, setError] = useState(null);

    // Helper function to get vibe amount from breakdown events - always returns VTRU sent to VIBE
    const getVibeAmount = useMemo(() => (event) => {
        const args = event.args;
        
        // Always use the VTRU amounts that were actually sent to the VIBE contract
        // vibeOutWVTRU: VTRU from unwrapped wVTRU sent to VIBE
        // vibeOutNative: VTRU directly sent to VIBE
        const vibeOutWVTRU = parseFloat(ethers.formatEther(args.vibeOutWVTRU || '0')); // Always 18 decimals
        const vibeOutNative = parseFloat(ethers.formatEther(args.vibeOutNative || '0')); // Always 18 decimals
        
        // Return the total VTRU amount that was sent to the VIBE contract
        // This represents the actual VTRU amount regardless of what token was used for payment
        return vibeOutWVTRU + vibeOutNative;
    }, []);

    const loadDashboardData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            // Check for marketplace address configuration
            if (!marketplaceAddress || marketplaceAddress === '0x0000000000000000000000000000000000000000') {
                setError('Marketplace contract address not configured. Please check environment configuration.');
                debugWarn('Marketplace address not configured:', marketplaceAddress);
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

            if (!provider) {
                setError('No blockchain provider available. Please connect your wallet or check network connection.');
                debugWarn('Provider not available, showing no data');
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

            debugLog('🚀 Fetching vibe fee data directly from blockchain events...');
            setStatus('🚀 Connecting to blockchain to fetch vibe fee data...');
            
            // Create marketplace contract instance
            const marketplace = new ethers.Contract(marketplaceAddress, MarketplaceAbi.abi, provider);
            
            // Get current block and determine scan range
            const currentBlock = await provider.getBlockNumber();
            const SCAN_BLOCKS = 50000; // Last 50k blocks for performance
            const fromBlock = Math.max(currentBlock - SCAN_BLOCKS, 0);
            
            debugLog(`📊 Scanning blocks ${fromBlock} to ${currentBlock} for vibe fee events (${SCAN_BLOCKS} blocks)`);
            setStatus(`📊 Scanning recent ${SCAN_BLOCKS.toLocaleString()} blocks for vibe fee data...`);
            
            // Fetch SaleBreakdown events (when NFTs are purchased)
            const saleBreakdownEvents = await marketplace.queryFilter(
                marketplace.filters.SaleBreakdown(),
                fromBlock,
                currentBlock
            );
            
            // Fetch AuctionBreakdown events (when auctions are settled)  
            const auctionBreakdownEvents = await marketplace.queryFilter(
                marketplace.filters.AuctionBreakdown(),
                fromBlock,  
                currentBlock
            );
            
            const allBreakdownEvents = [...saleBreakdownEvents, ...auctionBreakdownEvents];
            debugLog(`📈 Found ${saleBreakdownEvents.length} sale breakdowns and ${auctionBreakdownEvents.length} auction breakdowns`);
            setStatus(`📈 Processing ${allBreakdownEvents.length} vibe fee events...`);
            
            if (allBreakdownEvents.length === 0) {
                debugWarn('No breakdown events found in recent blocks');
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

            // Process events and extract data with timestamps
            const processedEvents = [];
            for (const event of allBreakdownEvents) {
                try {
                    const block = await event.getBlock();
                    const args = event.args;
                    
                    // Get the payment token and its decimals for proper formatting
                    const paymentToken = args.paymentToken;
                    const decimals = getTokenDecimals(paymentToken);
                    
                    const eventData = {
                        // Event metadata
                        type: event.eventName || (saleBreakdownEvents.includes(event) ? 'sale' : 'auction'),
                        blockNumber: event.blockNumber,
                        transactionHash: event.transactionHash,
                        timestamp: block.timestamp * 1000, // Convert to milliseconds
                        
                        // Payment token info
                        paymentToken: paymentToken,
                        paymentTokenDecimals: decimals,
                        
                        // Vibe data from event args with correct decimal formatting
                        vibePortionInPayment: parseFloat(ethers.formatUnits(args.vibePortionInPayment || '0', decimals)),
                        vibeOutWVTRU: parseFloat(ethers.formatEther(args.vibeOutWVTRU || '0')), // WVTRU is always 18 decimals
                        vibeOutNative: parseFloat(ethers.formatEther(args.vibeOutNative || '0')), // Native VTRU is always 18 decimals
                        vibeShareBps: parseInt(args.vibeShareBps?.toString() || '0'),
                        
                        // Platform and royalty data with correct decimal formatting
                        platformFeeTotal: parseFloat(ethers.formatUnits(args.platformFeeTotal || '0', decimals)),
                        royaltyAmount: parseFloat(ethers.formatUnits(args.royaltyAmount || '0', decimals)),
                        royaltyReceiver: args.royaltyReceiver,
                        
                        // Transaction details with correct decimal formatting
                        nftContract: args.nftContract,
                        tokenId: args.tokenId?.toString(),
                        totalPrice: parseFloat(ethers.formatUnits(args.totalPrice || args.finalPrice || '0', decimals)),
                        quantity: parseInt(args.quantity?.toString() || '1')
                    };
                    
                    processedEvents.push(eventData);
                } catch (err) {
                    debugWarn('Error processing event:', err);
                }
            }
            
            debugLog(`✅ Processed ${processedEvents.length} events successfully`);
            
            // Debug: Log token breakdown and VTRU amounts sent to VIBE for troubleshooting
            if (processedEvents.length > 0) {
                const tokenBreakdown = processedEvents.reduce((acc, event) => {
                    const token = event.paymentToken || 'Unknown';
                    const decimals = event.paymentTokenDecimals || 'Unknown';
                    const vtruSentToVibe = event.vibeOutWVTRU + event.vibeOutNative; // Always track VTRU sent to VIBE
                    const paymentAmount = event.vibePortionInPayment || 0; // Original payment amount
                    if (!acc[token]) {
                        acc[token] = { count: 0, totalVTRUSentToVibe: 0, totalPaymentAmount: 0, decimals };
                    }
                    acc[token].count++;
                    acc[token].totalVTRUSentToVibe += vtruSentToVibe;
                    acc[token].totalPaymentAmount += paymentAmount;
                    return acc;
                }, {});
                
                debugLog('🔍 Payment token breakdown (tracking VTRU sent to VIBE):', tokenBreakdown);
            }

            // Time windows for calculations
            const now = Date.now();
            const oneDayAgo = now - (24 * 60 * 60 * 1000);
            const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

            // Calculate aggregated stats - always use VTRU amounts sent to VIBE
            const totalVTRUSentNum = processedEvents.reduce((sum, event) => {
                return sum + (event.vibeOutWVTRU + event.vibeOutNative);
            }, 0);

            const vtruSent24hNum = processedEvents
                .filter(event => event.timestamp >= oneDayAgo)
                .reduce((sum, event) => {
                    return sum + (event.vibeOutWVTRU + event.vibeOutNative);
                }, 0);

            const vtruSent7dNum = processedEvents
                .filter(event => event.timestamp >= sevenDaysAgo)
                .reduce((sum, event) => {
                    return sum + (event.vibeOutWVTRU + event.vibeOutNative);
                }, 0);

            const totalTransactions = processedEvents.length;
            const totalPlatformFeesNum = processedEvents.reduce((sum, event) => sum + event.platformFeeTotal, 0);
            const totalRoyaltiesNum = processedEvents.reduce((sum, event) => sum + event.royaltyAmount, 0);
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

            // Generate chart data (daily aggregation)
            const chartDataMap = new Map();
            const timeframeBoundary = sevenDaysAgo; // Default to 7 days
            
            processedEvents
                .filter(event => event.timestamp >= timeframeBoundary)
                .forEach(event => {
                    const date = new Date(event.timestamp).toISOString().split('T')[0];
                    if (!chartDataMap.has(date)) {
                        chartDataMap.set(date, { vtruSent: 0, transactions: 0 });
                    }
                    const entry = chartDataMap.get(date);
                    entry.vtruSent += (event.vibeOutWVTRU + event.vibeOutNative);
                    entry.transactions += 1;
                });

            const chartDataArray = Array.from(chartDataMap.entries())
                .map(([date, data]) => ({ date, ...data }))
                .sort((a, b) => a.date.localeCompare(b.date));
            setChartData(chartDataArray);

            // Generate leaderboards
            const platformFeeMap = new Map();
            const royaltyMap = new Map();
            const royaltyRecipientMap = new Map();

            processedEvents.forEach(event => {
                // Collections by platform fees
                const nftContract = event.nftContract || 'Unknown';
                if (nftContract && nftContract !== 'Unknown') {
                    platformFeeMap.set(nftContract, (platformFeeMap.get(nftContract) || 0) + event.platformFeeTotal);
                    royaltyMap.set(nftContract, (royaltyMap.get(nftContract) || 0) + event.royaltyAmount);
                }

                // Royalty recipients
                const recipient = event.royaltyReceiver;
                if (recipient && recipient !== ethers.ZeroAddress && event.royaltyAmount > 0) {
                    royaltyRecipientMap.set(recipient, (royaltyRecipientMap.get(recipient) || 0) + event.royaltyAmount);
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

            // Generate recent events feed
            const recentEvents = processedEvents
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 10)
                .map(event => {
                    const vibeAmount = event.vibeOutWVTRU + event.vibeOutNative;
                    return {
                        time: formatTimeAgo(event.timestamp),
                        description: `VIBE payout ${vibeAmount.toFixed(4)} VTRU from ${event.type} transaction`,
                        hash: event.transactionHash,
                        type: 'vibe_payout'
                    };
                });

            setRecentEvents(recentEvents);
            setStatus('✅ Vibe fee data loaded successfully from blockchain!');
            
        } catch (error) {
            criticalError('Error loading vibe dashboard data from blockchain:', error);
            
            // Provide more specific error messages based on error type
            let errorMessage = 'Failed to load vibe fee data from blockchain.';
            let troubleshootingTip = '';
            
            if (error.message && error.message.includes('Failed to fetch')) {
                errorMessage = 'Network connection failed. Please check your internet connection and try again. The blockchain RPC endpoint may be temporarily unavailable.';
                troubleshootingTip = 'If this persists, the marketplace may have recent transactions that cannot be displayed due to network connectivity issues.';
            } else if (error.message && error.message.includes('network')) {
                errorMessage = 'Blockchain network error. Please check if you are connected to the correct network (Vitruveo) and try again.';
                troubleshootingTip = 'Make sure your wallet is connected to the Vitruveo network (Chain ID: 1490).';
            } else if (error.message && error.message.includes('UNPREDICTABLE_GAS_LIMIT')) {
                errorMessage = 'Smart contract interaction failed. The marketplace contract may be experiencing issues.';
                troubleshootingTip = 'This could indicate the contract address is incorrect or the contract is not responding.';
            } else if (error.code === 'NETWORK_ERROR') {
                errorMessage = 'Blockchain network is unreachable. Please try again later or check your network connection.';
                troubleshootingTip = 'Recent sales and VIBE payouts may exist but cannot be retrieved at this time.';
            } else {
                errorMessage = `Failed to load vibe fee data: ${error.message || 'Unknown error'}. Please try again later.`;
                troubleshootingTip = 'If this error persists, please report it with the error details above.';
            }
            
            // Log troubleshooting information
            if (troubleshootingTip) {
                debugLog('Troubleshooting tip:', troubleshootingTip);
            }
            
            setError(errorMessage);
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
            setTimeout(() => setStatus(''), 3000); // Clear status after 3 seconds
        }
    }, [provider, marketplaceAddress, timeframe, getVibeAmount]); // Updated dependencies

    // Add useEffect with proper dependencies and error boundaries
    useEffect(() => {
        let cancelled = false;
        
        const loadData = async () => {
            if (!cancelled && provider && marketplaceAddress) {
                await loadDashboardData();
            }
        };
        
        loadData();
        
        return () => {
            cancelled = true;
        };
    }, [provider, marketplaceAddress, timeframe]); // Depend on primitive values instead of memoized function

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
                <p>Real-time analytics from blockchain events (direct from smart contract)</p>
                {marketplaceAddress && marketplaceAddress !== '0x0000000000000000000000000000000000000000' && (
                    <p style={{ fontSize: '0.9em', opacity: 0.7, marginTop: '0.5rem' }}>
                        Contract: {marketplaceAddress.slice(0, 8)}...{marketplaceAddress.slice(-6)}
                    </p>
                )}
                <div style={{ marginTop: '1rem' }}>
                    <button 
                        onClick={loadDashboardData} 
                        disabled={loading}
                        style={{
                            padding: '0.5rem 1rem',
                            background: loading ? '#666' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            fontSize: '0.9rem'
                        }}
                    >
                        {loading ? '🔄 Loading...' : '🔄 Refresh Data'}
                    </button>
                </div>
                {status && (
                    <div style={{ 
                        marginTop: '1rem', 
                        padding: '0.5rem', 
                        background: 'rgba(102, 126, 234, 0.1)', 
                        border: '1px solid rgba(102, 126, 234, 0.3)', 
                        borderRadius: '6px',
                        fontSize: '0.9rem'
                    }}>
                        {status}
                    </div>
                )}
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
                                    {!provider && (
                                        <p style={{ fontSize: '0.9em', opacity: 0.7 }}>
                                            Connect wallet to see real-time event data from blockchain
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