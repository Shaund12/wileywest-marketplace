import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { ethers } from 'ethers';
import MarketplaceAbi from '../abi/VTRUNFTMarketplace.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import { getTokenDecimals } from '../utils/tokenUtils';
import MarketplaceStats from '../components/MarketplaceStats';
import { motion } from 'framer-motion';

function VibeDashboardPage() {
    const { provider } = useWallet();
    const { marketplaceStats = {}, refreshBlockchainData, salesHistory = [], status = '' } = useMarketplace();
    const marketplaceAddress = import.meta.env.VITE_MARKETPLACE_ADDRESS;
    const [stats, setStats] = useState({
        totalVTRUSent: '0',
        vtruSent24h: '0',
        vtruSent7d: '0',
        totalTransactions: 0,
        totalPlatformFees: '0',
        totalRoyalties: '0',
        avgPayout: '0'
    });
    const [chartData, setChartData] = useState([]);
    const [leaderboards, setLeaderboards] = useState({ collections: [], royalties: [] });
    const [recentEvents, setRecentEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [timeframe, setTimeframe] = useState('7d');
    const [error, setError] = useState(null);

    const loadDashboardData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

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
                setLoading(false);
                return;
            }

            if (!provider) {
                setError('Network unavailable: Cannot connect to blockchain. Please check your connection or try again later.');
                debugWarn('Provider not available, cannot load blockchain data');
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

            debugLog('🚀 Fetching vibe fee data directly from blockchain events...');
            const marketplace = new ethers.Contract(marketplaceAddress, MarketplaceAbi.abi, provider);

            const currentBlock = await provider.getBlockNumber();
            const GENESIS_BLOCK = 11635620; // Contract genesis block for all-time VIBE stats
            const fromBlock = GENESIS_BLOCK;

            debugLog(`📊 Scanning blocks ${fromBlock} to ${currentBlock} for all-time vibe fee events (${currentBlock - fromBlock + 1} blocks from genesis)`);

            const saleBreakdownEvents = await marketplace.queryFilter(
                marketplace.filters.SaleBreakdown(),
                fromBlock,
                currentBlock
            );

            const auctionBreakdownEvents = await marketplace.queryFilter(
                marketplace.filters.AuctionBreakdown(),
                fromBlock,
                currentBlock
            );

            const allBreakdownEvents = [...saleBreakdownEvents, ...auctionBreakdownEvents];
            debugLog(`📈 Found ${saleBreakdownEvents.length} sale breakdowns and ${auctionBreakdownEvents.length} auction breakdowns`);

            if (allBreakdownEvents.length === 0) {
                debugWarn(`No breakdown events found from genesis block ${GENESIS_BLOCK} to current block ${currentBlock}`);
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

            debugLog(`🔍 Raw breakdown events found: ${allBreakdownEvents.length}`);
            for (let i = 0; i < Math.min(3, allBreakdownEvents.length); i++) {
                const event = allBreakdownEvents[i];
                debugLog(`Raw event ${i}: tx=${event.transactionHash}, vibeOutWVTRU=${event.args.vibeOutWVTRU?.toString()}, vibeOutNative=${event.args.vibeOutNative?.toString()}, vibePortionInPayment=${event.args.vibePortionInPayment?.toString()}`);
            }

            debugLog(`🔄 Processing ${allBreakdownEvents.length} events - ONLY counting wVTRU burns/unwraps...`);
            const vibePayoutEvents = [];

            for (const event of allBreakdownEvents) {
                try {
                    const args = event.args;

                    const vibeOutWVTRU = parseFloat(ethers.formatEther(args.vibeOutWVTRU || '0'));
                    const vibeOutNative = parseFloat(ethers.formatEther(args.vibeOutNative || '0'));

                    const totalVibeOut = vibeOutNative || vibeOutWVTRU;

                    const paymentToken = args.paymentToken;
                    const decimals = getTokenDecimals(paymentToken);
                    const vibePortionInPayment = parseFloat(ethers.formatUnits(args.vibePortionInPayment || '0', decimals));

                    if (totalVibeOut > 0) {
                        if (paymentToken === '0x3ccc3F22462cAe34766820894D04a40381201ef9') {
                            if (vibeOutWVTRU > 0) {
                                debugLog(`✅ wVTRU BURN/UNWRAP found: tx=${event.transactionHash}, burned=${vibeOutWVTRU} VTRU to VIBE`);
                            } else {
                                debugLog(`🚫 Ignoring wVTRU event with no burn: tx=${event.transactionHash}, vibeOutWVTRU=0`);
                                continue;
                            }
                        } else {
                            debugLog(`✅ Non-wVTRU VIBE payout: tx=${event.transactionHash}, vibeOut=${totalVibeOut} VTRU`);
                        }

                        const block = await event.getBlock();

                        vibePayoutEvents.push({
                            event,
                            block,
                            args,
                            vibeOutWVTRU,
                            vibeOutNative,
                            totalVibeOut,
                            paymentToken,
                            decimals,
                            vibePortionInPayment
                        });
                    } else {
                        debugLog(`⏭️ Skipping event with no VIBE payout: tx=${event.transactionHash}, totalVibeOut=0`);
                    }
                } catch (err) {
                    debugWarn('Error filtering event:', event.transactionHash, err);
                }
            }

            debugLog(`📊 Filtered to ${vibePayoutEvents.length} actual VIBE payout events (from ${allBreakdownEvents.length} total)`);

            const eventGroups = new Map();
            for (const eventData of vibePayoutEvents) {
                const txHash = eventData.event.transactionHash;
                if (!eventGroups.has(txHash) || eventData.totalVibeOut > eventGroups.get(txHash).totalVibeOut) {
                    eventGroups.set(txHash, eventData);
                    debugLog(`🔄 Best VIBE event for tx ${txHash}: ${eventData.totalVibeOut} VTRU`);
                }
            }

            const processedEvents = [];
            for (const [txHash, eventData] of eventGroups) {
                try {
                    const { event, block, args, vibeOutWVTRU, vibeOutNative, totalVibeOut, paymentToken, decimals, vibePortionInPayment } = eventData;

                    const finalVibeAmount = totalVibeOut;
                    const processedEvent = {
                        type: event.eventName || (saleBreakdownEvents.includes(event) ? 'sale' : 'auction'),
                        blockNumber: event.blockNumber,
                        transactionHash: event.transactionHash,
                        timestamp: block.timestamp * 1000,
                        paymentToken,
                        paymentTokenDecimals: decimals,
                        vibePortionInPayment,
                        vibeOutWVTRU,
                        vibeOutNative,
                        vibeShareBps: parseInt(args.vibeShareBps?.toString() || '0'),
                        platformFeeTotal: parseFloat(ethers.formatUnits(args.platformFeeTotal || '0', decimals)),
                        royaltyAmount: parseFloat(ethers.formatUnits(args.royaltyAmount || '0', decimals)),
                        royaltyReceiver: args.royaltyReceiver,
                        nftContract: args.nftContract,
                        tokenId: args.tokenId?.toString(),
                        totalPrice: parseFloat(ethers.formatUnits(args.totalPrice || args.finalPrice || '0', decimals)),
                        quantity: parseInt(args.quantity?.toString() || '1'),
                        calculatedVibeAmount: finalVibeAmount,
                        amountSource: 'vtru'
                    };

                    processedEvents.push(processedEvent);
                    debugLog(`✅ Processed tx ${txHash}: ${finalVibeAmount} VTRU sent to VIBE`);
                } catch (err) {
                    debugWarn('Error processing VIBE transaction:', txHash, err);
                }
            }

            if (processedEvents.length > 0) {
                const sourceBreakdown = processedEvents.reduce((acc, event) => {
                    const tokenName = event.paymentToken === '0x0000000000000000000000000000000000000000' ? 'Native VTRU'
                        : event.paymentToken === '0x3ccc3F22462cAe34766820894D04a40381201ef9' ? 'wVTRU'
                            : event.paymentToken === '0x1D607d8c617A09c638309bE2Ceb9b4afF42236dA' ? 'VUSD' : 'Other';
                    if (!acc[tokenName]) acc[tokenName] = { count: 0, totalAmount: 0, token: event.paymentToken };
                    acc[tokenName].count++;
                    acc[tokenName].totalAmount += event.calculatedVibeAmount;
                    return acc;
                }, {});
                debugLog('🔍 VIBE payouts breakdown by payment token:', sourceBreakdown);
            }

            const now = Date.now();
            const oneDayAgo = now - (24 * 60 * 60 * 1000);
            const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

            const totalVTRUSentNum = processedEvents.reduce((sum, e) => sum + e.calculatedVibeAmount, 0);
            const vtruSent24hNum = processedEvents.filter(e => e.timestamp >= oneDayAgo).reduce((sum, e) => sum + e.calculatedVibeAmount, 0);
            const vtruSent7dNum = processedEvents.filter(e => e.timestamp >= sevenDaysAgo).reduce((sum, e) => sum + e.calculatedVibeAmount, 0);
            const totalTransactions = processedEvents.length;
            const totalPlatformFeesNum = processedEvents.reduce((sum, e) => sum + e.platformFeeTotal, 0);
            const totalRoyaltiesNum = processedEvents.reduce((sum, e) => sum + e.royaltyAmount, 0);
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

            const chartDataMap = new Map();
            const timeframeBoundary = sevenDaysAgo;
            processedEvents
                .filter(e => e.timestamp >= timeframeBoundary)
                .forEach(e => {
                    const date = new Date(e.timestamp).toISOString().split('T')[0];
                    if (!chartDataMap.has(date)) chartDataMap.set(date, { vtruSent: 0, transactions: 0 });
                    const entry = chartDataMap.get(date);
                    entry.vtruSent += e.calculatedVibeAmount;
                    entry.transactions += 1;
                });

            const chartDataArray = Array.from(chartDataMap.entries())
                .map(([date, data]) => ({ date, ...data }))
                .sort((a, b) => a.date.localeCompare(b.date));
            setChartData(chartDataArray);

            const platformFeeMap = new Map();
            const royaltyMap = new Map();
            const royaltyRecipientMap = new Map();

            processedEvents.forEach(e => {
                const nftContract = e.nftContract || 'Unknown';
                if (nftContract && nftContract !== 'Unknown') {
                    platformFeeMap.set(nftContract, (platformFeeMap.get(nftContract) || 0) + e.platformFeeTotal);
                    royaltyMap.set(nftContract, (royaltyMap.get(nftContract) || 0) + e.royaltyAmount);
                }
                const recipient = e.royaltyReceiver;
                if (recipient && recipient !== ethers.ZeroAddress && e.royaltyAmount > 0) {
                    royaltyRecipientMap.set(recipient, (royaltyRecipientMap.get(recipient) || 0) + e.royaltyAmount);
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

            const recentEvents = processedEvents
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 10)
                .map(event => {
                    const vibeAmount = event.calculatedVibeAmount;
                    return {
                        time: formatTimeAgo(event.timestamp),
                        description: `VIBE payout ${vibeAmount.toFixed(4)} VTRU from ${event.type} transaction`,
                        hash: event.transactionHash,
                        type: 'vibe_payout'
                    };
                });

            setRecentEvents(recentEvents);
        } catch (error) {
            criticalError('Error loading vibe dashboard data from blockchain:', error);
            let errorMessage = 'Failed to load vibe fee data from blockchain.';
            if (error.message?.includes('Failed to fetch')) {
                errorMessage = 'Network connection failed. Please check your internet connection and try again.';
            } else if (error.message?.includes('network')) {
                errorMessage = 'Blockchain network error. Check if you are on the correct network (Vitruveo).';
            } else if (error.message?.includes('UNPREDICTABLE_GAS_LIMIT')) {
                errorMessage = 'Smart contract interaction failed.';
            } else if (error.code === 'NETWORK_ERROR') {
                errorMessage = 'Blockchain network is unreachable. Please try again later.';
            } else {
                errorMessage = `Failed to load vibe fee data: ${error.message || 'Unknown error'}.`;
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
        }
    }, [provider, marketplaceAddress, timeframe]);

    useEffect(() => {
        let cancelled = false;
        const loadData = async () => {
            if (!cancelled) {
                await loadDashboardData();
            }
        };
        loadData();
        return () => { cancelled = true; };
    }, [loadDashboardData]);

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

    const tfBtn = (key, label) => (
        <button
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${timeframe === key
                ? 'bg-indigo-600 text-white shadow'
                : 'bg-white/5 text-gray-300 hover:bg-white/10'
                }`}
            onClick={() => setTimeframe(key)}
        >
            {label}
        </button>
    );

    return (
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <div className="flex flex-col gap-3 mb-6">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div>
                        <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
                            VIBE Dashboard
                        </h2>
                        <p className="text-sm text-gray-400">
                            Real-time analytics from blockchain events (direct from smart contract)
                        </p>
                        {marketplaceAddress && marketplaceAddress !== '0x0000000000000000000000000000000000000000' && (
                            <p className="text-xs text-gray-500 mt-1">
                                Contract: {marketplaceAddress.slice(0, 8)}...{marketplaceAddress.slice(-6)}
                            </p>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={loadDashboardData}
                            disabled={loading}
                            className={`px-4 py-2 rounded-md text-sm font-semibold transition
                                ${loading ? 'bg-gray-600 cursor-not-allowed' : 'bg-gradient-to-r from-indigo-500 to-purple-600 hover:opacity-95'}
                                text-white shadow`}
                        >
                            {loading ? '🔄 Loading...' : '🔄 Refresh Data'}
                        </button>
                        {typeof refreshBlockchainData === 'function' && (
                            <button
                                onClick={() => refreshBlockchainData({ fullScan: true }).catch(() => { })}
                                className="px-4 py-2 rounded-md text-sm font-semibold bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 transition"
                            >
                                Full Chain Scan
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {error && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 px-4 py-3 mb-6">
                    <p>{error}</p>
                </div>
            )}

            {loading ? (
                <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-10 text-center text-gray-300">
                    Loading dashboard data...
                </div>
            ) : (
                <>
                    <section className="mb-6">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            {[
                                { label: 'Total VTRU → VIBE', value: formatVTRU(stats.totalVTRUSent), sub: 'All time', color: 'from-emerald-500/20 to-cyan-500/20' },
                                { label: 'Last 24 Hours', value: formatVTRU(stats.vtruSent24h), sub: 'vs prior day', color: 'from-indigo-500/20 to-purple-500/20' },
                                { label: 'Last 7 Days', value: formatVTRU(stats.vtruSent7d), sub: 'vs prior week', color: 'from-amber-500/20 to-pink-500/20' },
                                { label: 'Payout Transactions', value: stats.totalTransactions, sub: 'sales + auctions', color: 'from-fuchsia-500/20 to-blue-500/20' }
                            ].map((kpi, i) => (
                                <div key={i} className="rounded-xl border border-white/10 bg-gradient-to-br p-4 backdrop-blur-sm text-white"
                                    style={{ backgroundImage: undefined }}
                                >
                                    <div className={`rounded-lg bg-gradient-to-br ${kpi.color} p-3 mb-3 border border-white/10`} />
                                    <div className="text-sm text-gray-400">{kpi.label}</div>
                                    <div className="text-2xl font-extrabold mt-1">{kpi.value}</div>
                                    <div className="text-xs text-gray-500 mt-1">{kpi.sub}</div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section className="mb-8">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {[
                                { label: 'Platform Fees Paid', value: formatVTRU(stats.totalPlatformFees), sub: 'sum of platform_fee' },
                                { label: 'Royalties Paid', value: formatVTRU(stats.totalRoyalties), sub: 'sum of royalty' },
                                { label: 'Avg VIBE Payout', value: formatVTRU(stats.avgPayout), sub: 'per transaction' }
                            ].map((kpi, i) => (
                                <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                                    <div className="text-sm text-gray-400">{kpi.label}</div>
                                    <div className="text-2xl font-extrabold mt-1">{kpi.value}</div>
                                    <div className="text-xs text-gray-500 mt-1">{kpi.sub}</div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section className="mb-8">
                        <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                            <div className="flex items-center justify-between gap-3 mb-4">
                                <h3 className="text-lg font-bold">VTRU → VIBE Over Time</h3>
                                <div className="flex items-center gap-2">
                                    {tfBtn('7d', '7 Days')}
                                    {tfBtn('30d', '30 Days')}
                                    {tfBtn('90d', '90 Days')}
                                </div>
                            </div>
                            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                                {chartData.length > 0 ? (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                        {chartData.slice(-Math.max(7, chartData.length)).map((point, idx) => (
                                            <div key={idx} className="rounded-md bg-white/5 border border-white/10 p-3 flex items-center justify-between">
                                                <span className="text-sm text-gray-400">{point.date}</span>
                                                <div className="flex items-center gap-4">
                                                    <span className="text-emerald-400 font-semibold">{point.vtruSent.toFixed(2)} VTRU</span>
                                                    <span className="text-xs text-gray-400">{point.transactions} tx</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-center text-gray-400 py-10">No payout data available for selected timeframe</div>
                                )}
                            </div>
                        </div>
                    </section>

                    <section className="mb-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                            <h3 className="text-lg font-bold mb-3">Top Collections by Platform Fees</h3>
                            <div className="space-y-2">
                                {leaderboards.collections.length > 0 ? (
                                    leaderboards.collections.map((c, i) => (
                                        <div key={i} className="flex items-center justify-between rounded-md bg-white/5 border border-white/10 p-3">
                                            <div className="flex items-center gap-3">
                                                <span className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 font-bold grid place-items-center">#{i + 1}</span>
                                                <span className="font-semibold">{c.name}</span>
                                            </div>
                                            <span className="text-emerald-400 font-bold">{formatVTRU(c.platformFees)}</span>
                                        </div>
                                    ))
                                ) : (
                                    <div className="text-gray-400">No collection fee data available</div>
                                )}
                            </div>
                        </div>

                        <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                            <h3 className="text-lg font-bold mb-3">Top Royalty Recipients</h3>
                            <div className="space-y-2">
                                {leaderboards.royalties.length > 0 ? (
                                    leaderboards.royalties.map((r, i) => (
                                        <div key={i} className="flex items-center justify-between rounded-md bg-white/5 border border-white/10 p-3">
                                            <div className="flex items-center gap-3">
                                                <span className="w-8 h-8 rounded-full bg-amber-500/20 text-amber-300 font-bold grid place-items-center">#{i + 1}</span>
                                                <span className="font-semibold">{r.collection}</span>
                                            </div>
                                            <span className="text-emerald-400 font-bold">{formatVTRU(r.amount)}</span>
                                        </div>
                                    ))
                                ) : (
                                    <div className="text-gray-400">No royalty payment data available</div>
                                )}
                            </div>
                        </div>
                    </section>

                    <motion.section
                        className="mb-10"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, delay: 0.2 }}
                    >
                        <div className="mb-4">
                            <h3 className="text-xl font-bold text-white mb-1">📊 Marketplace Overview</h3>
                            <p className="text-sm text-gray-400">Current marketplace statistics and activity</p>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                            <div className="rounded-xl border border-white/10 bg-gradient-to-br from-indigo-500/15 to-pink-500/15 p-5 text-center">
                                <h3 className="text-3xl font-extrabold text-indigo-400">
                                    {marketplaceStats.totalListings || 0}
                                </h3>
                                <p className="font-semibold text-white mt-1">Active Listings</p>
                                <small className="text-gray-400">(Excluding canceled)</small>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-gradient-to-br from-emerald-500/15 to-cyan-500/15 p-5 text-center">
                                <h3 className="text-3xl font-extrabold text-emerald-400">
                                    {marketplaceStats.hasUSDCRates ? `$${Number(marketplaceStats.currentListingVolume || 0).toFixed(2)}` : (marketplaceStats.currentListingVolume || '0')}
                                </h3>
                                <p className="font-semibold text-white mt-1">Current Listing Volume</p>
                                <small className="text-gray-400">{marketplaceStats.hasUSDCRates ? 'USDC' : 'Native tokens'}</small>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-gradient-to-br from-amber-500/15 to-rose-500/15 p-5 text-center">
                                <h3 className="text-3xl font-extrabold text-amber-300">
                                    {marketplaceStats.hasUSDCRates ? `$${Number(marketplaceStats.actualSoldVolume || 0).toFixed(2)}` : (marketplaceStats.actualSoldVolume || '0')}
                                </h3>
                                <p className="font-semibold text-white mt-1">Actual Sold Volume</p>
                                <small className="text-gray-400">{marketplaceStats.hasUSDCRates ? 'USDC' : 'Native tokens'}</small>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-gradient-to-br from-fuchsia-500/15 to-blue-500/15 p-5 text-center">
                                <h3 className="text-3xl font-extrabold text-fuchsia-300">
                                    {marketplaceStats.hasUSDCRates ? `$${marketplaceStats.floorPrice || '0.00'}` : (marketplaceStats.floorPrice || '0')}
                                </h3>
                                <p className="font-semibold text-white mt-1">Floor Price</p>
                                <small className="text-gray-400">{marketplaceStats.hasUSDCRates ? 'USDC' : 'Estimated'}</small>
                            </div>
                        </div>

                        <MarketplaceStats />
                    </motion.section>

                    <section>
                        <h3 className="text-lg font-bold text-white mb-3">Recent Marketplace Payouts</h3>
                        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                            {recentEvents.length > 0 ? (
                                <div className="divide-y divide-white/10">
                                    {recentEvents.map((event, idx) => (
                                        <div key={idx} className="py-3 flex items-center justify-between text-sm">
                                            <span className="text-gray-400">{event.time}</span>
                                            <span className="text-white">{event.description}</span>
                                            <span className="text-indigo-300">
                                                {event.hash ? (
                                                    <a
                                                        href={`https://explorer.vitruveo.xyz/tx/${event.hash}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="hover:underline"
                                                    >
                                                        {`${event.hash.slice(0, 6)}...${event.hash.slice(-4)}`}
                                                    </a>
                                                ) : 'N/A'}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-gray-400 text-center py-8">
                                    <p>No recent payout events available</p>
                                    {!provider && <p className="text-xs mt-1">Connect wallet to see real-time blockchain data</p>}
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