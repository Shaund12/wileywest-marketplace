import React, { createContext, useState, useContext, useEffect, useRef, useCallback } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './WalletContext';
import { useSupabase } from './SupabaseContext';
import { convertToUSDCValue } from '../utils/tokenUtils';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import {
    MARKETPLACE_CONFIG,
    standardizeBigInt,
    normalizeNFTMetadata,
    resolveCollectionName,
    createContentSignature,
    isCacheValid,
    scopedClass
} from '../utils/nftUtils';
import {
    fetchJSON,
    resolveIPFSWithFallbacks,
    isCORSError,
    isNetworkError,
    retryWithBackoff
} from '../utils/networkUtils';

const MarketplaceContext = createContext();

// Simple concurrency helper
async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = index++;
            if (i >= items.length) break;
            try {
                results[i] = await mapper(items[i], i);
            } catch {
                results[i] = undefined;
            }
        }
    });
    await Promise.all(workers);
    return results;
}

export function MarketplaceProvider({ children, marketplaceAddress, abi }) {
    const { wallet, signer, provider } = useWallet();
    const {
        cacheListings,
        getCachedListings,
        cacheSalesHistory,
        getCachedSalesHistory,
        subscribeToListings,
        isConnected: supabaseConnected
    } = useSupabase();
    const [marketplace, setMarketplace] = useState(null);
    const [listings, setListings] = useState([]);
    const [hotListings, setHotListings] = useState([]);
    const [status, _setStatus] = useState('');
    const [persistentStatus, setPersistentStatus] = useState('');
    const [statusType, setStatusType] = useState('info');
    const [isInitialized, setIsInitialized] = useState(false);
    const isConnectedRef = useRef(false);
    const cacheUpdateInterval = useRef(null);

    // New state for tracking sales and statistics
    const [salesHistory, setSalesHistory] = useState([]);
    const [canceledListings, setCanceledListings] = useState(new Set());
    const [marketplaceStats, setMarketplaceStats] = useState({
        totalSales: 0,
        actualSoldVolume: 0,
        currentListingVolume: 0,
        volume1h: 0,
        volume6h: 0,
        volume12h: 0,
        volume24h: 0,
        volume7d: 0,
        volume30d: 0,
        volumeAllTime: 0,
        sales1h: 0,
        sales6h: 0,
        sales12h: 0,
        sales24h: 0,
        sales7d: 0,
        sales30d: 0,
        avgPrice: 0,
        highestPrice: 0,
        lowestPrice: 0,
        marketCap: 0,
        liquidityRatio: 0,
        marketVelocity24h: 0,
        marketVelocity7d: 0,
        growthRate24h: 0,
        growthRate7d: 0,
        marketHealthScore: 0,
        turnoverRate: 0,
        uniqueBuyers: 0,
        hourlyVolume: [],
        dailyVolume: [],
        priceHistory: [],
        transactionHistory: [],
        topTokens: [],
        mostActiveSellers: []
    });

    // Status helpers
    const setStatusWithType = (message, type = 'info', persistent = false) => {
        _setStatus(message);
        setStatusType(type);
        if (persistent) setPersistentStatus(message);
    };
    const setStatus = setStatusWithType;
    const clearStatus = () => { _setStatus(''); setStatusType('info'); };
    const clearPersistentStatus = () => setPersistentStatus('');

    // Load sales history from Supabase cache first, fallback to localStorage
    const hasLoadedInitialData = useRef(false);

    useEffect(() => {
        if (hasLoadedInitialData.current && supabaseConnected === hasLoadedInitialData.supabaseState) {
            return;
        }

        const loadPersistedData = async () => {
            try {
                if (supabaseConnected && getCachedSalesHistory) {
                    debugLog("Loading sales history from Supabase cache...");
                    const cachedSales = await getCachedSalesHistory();

                    if (cachedSales && cachedSales.length > 0) {
                        debugLog(`Loaded ${cachedSales.length} sales from Supabase cache`);
                        setSalesHistory(cachedSales);
                    } else {
                        debugLog("No Supabase cache found, falling back to localStorage");
                        loadFromLocalStorage();
                    }
                } else {
                    loadFromLocalStorage();
                }

                const savedCanceledListings = localStorage.getItem('marketplace_canceled_listings');
                if (savedCanceledListings) {
                    const parsedCanceled = JSON.parse(savedCanceledListings);
                    setCanceledListings(new Set(parsedCanceled));
                }

                hasLoadedInitialData.current = true;
                hasLoadedInitialData.supabaseState = supabaseConnected;
            } catch (error) {
                criticalError("Error loading persisted marketplace data:", error);
                loadFromLocalStorage();
                hasLoadedInitialData.current = true;
                hasLoadedInitialData.supabaseState = supabaseConnected;
            }
        };

        const loadFromLocalStorage = () => {
            try {
                const savedSalesHistory = localStorage.getItem('marketplace_sales_history');
                if (savedSalesHistory) {
                    const parsedHistory = JSON.parse(savedSalesHistory);
                    debugLog("Loaded persisted sales history from localStorage:", parsedHistory.length, "transactions");
                    setSalesHistory(parsedHistory);
                }
            } catch (error) {
                criticalError("Error loading from localStorage:", error);
            }
        };

        loadPersistedData();
    }, [supabaseConnected]);

    // Enhanced cache persistence with content-based invalidation
    const [lastCacheSignature, setLastCacheSignature] = useState(null);
    useEffect(() => {
        if (salesHistory.length > 0) {
            const cacheSales = async () => {
                try {
                    localStorage.setItem('marketplace_sales_history', JSON.stringify(salesHistory));
                    debugLog("Persisted sales history to localStorage:", salesHistory.length, "transactions");

                    const currentSignature = createContentSignature({ salesHistory });
                    if (lastCacheSignature !== currentSignature) {
                        setLastCacheSignature(currentSignature);
                        debugLog("Sales history content changed, signature updated");
                    }

                    const MAX_SAFE_SALES_CACHE = 500;
                    const shouldCacheSales = supabaseConnected && salesHistory.length > 0 &&
                        salesHistory.length <= MAX_SAFE_SALES_CACHE &&
                        lastCacheSignature !== currentSignature;

                    if (shouldCacheSales && cacheSalesHistory) {
                        try {
                            debugLog(`💾 Smart caching ${salesHistory.length} sales (within safe limit)...`);
                            await cacheSalesHistory(salesHistory);
                            debugLog(`✅ Successfully cached sales history`);
                        } catch (cacheError) {
                            debugWarn("❌ Failed to cache sales history:", cacheError);
                        }
                    } else if (salesHistory.length > MAX_SAFE_SALES_CACHE) {
                        debugLog(`📋 Skipping sales cache - count (${salesHistory.length}) exceeds safe limit (${MAX_SAFE_SALES_CACHE})`);
                    } else if (lastCacheSignature === currentSignature) {
                        debugLog("📋 No sales cache update needed - data unchanged");
                    } else if (!supabaseConnected) {
                        debugLog("📋 Skipping sales cache - Supabase not connected");
                    }

                } catch (error) {
                    criticalError("Error persisting sales history:", error);
                }
            };
            cacheSales();
        }
    }, [salesHistory, supabaseConnected]);

    // Persist canceled listings to localStorage whenever they change
    useEffect(() => {
        if (canceledListings.size > 0) {
            try {
                const canceledArray = Array.from(canceledListings);
                localStorage.setItem('marketplace_canceled_listings', JSON.stringify(canceledArray));
            } catch (error) {
                criticalError("Error persisting canceled listings:", error);
            }
        }
    }, [canceledListings]);

    // Initialize marketplace contract
    useEffect(() => {
        const initializeMarketplace = async () => {
            if (marketplaceAddress && provider) {
                try {
                    const resolvedAbi = await resolveMarketplaceAbi(abi);
                    const contract = new ethers.Contract(marketplaceAddress, resolvedAbi, provider);

                    if (!hasAbiFn(resolvedAbi, 'buy')) {
                        throw new Error('Resolved ABI still missing buy()');
                    }

                    setMarketplace(contract);
                    setIsInitialized(true);

                    try {
                        await provider.getNetwork();
                        // Enable event listeners for live updates
                        setupEventListeners(contract);
                    } catch (networkError) {
                        debugWarn("Network connectivity issue - event listeners not set up:", networkError.message);
                        setStatus("Network connectivity issue - running in offline mode. Sales tracking unavailable.");
                    }
                } catch (error) {
                    criticalError("Error initializing marketplace contract:", error);
                    setStatus("Failed to initialize marketplace contract (ABI mismatch)");
                }
            }
        };

        initializeMarketplace();
    }, [marketplaceAddress, abi, provider]);

    // Manual refresh cleanup
    useEffect(() => {
        return () => {
            if (cacheUpdateInterval.current) {
                clearInterval(cacheUpdateInterval.current);
            }
        };
    }, [marketplace]);

    // Update contract with signer when wallet connects
    useEffect(() => {
        if (signer && marketplace && !isConnectedRef.current) {
            isConnectedRef.current = true;
            const connectedContract = marketplace.connect(signer);
            setMarketplace(connectedContract);
        } else if (!signer) {
            isConnectedRef.current = false;
        }
    }, [signer, marketplace]);

    // Optimized past events scan (unchanged)
    const [processedBlocksCache, setProcessedBlocksCache] = useState(new Set());
    const [lastScannedBlock, setLastScannedBlock] = useState(0);

    const fetchPastSalesEvents = async (contract) => {
        if (!contract || !provider) return;

        try {
            setStatus("🚀 Starting optimized blockchain scan with parallel processing...");
            debugLog("🚀 Starting optimized blockchain scan with parallel processing...");

            try {
                await provider.getNetwork();
            } catch {
                debugWarn("Network connectivity issue - skipping past events fetch");
                setStatus("");
                return;
            }

            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(currentBlock - 50000, lastScannedBlock);

            debugLog(`🔍 CONSERVATIVE BLOCKCHAIN SCAN: Recent blocks only from ${fromBlock} to ${currentBlock}`);
            debugLog(`⚡ Limiting scan to recent 50k blocks to prevent mass data collection`);
            setStatus(`⚡ Conservative scan: recent blocks ${fromBlock} to ${currentBlock} only...`);

            let purchasedEvents = [];
            let canceledEvents = [];

            const CHUNK_SIZE = 5000;
            const chunks = [];
            for (let chunkStart = fromBlock; chunkStart <= currentBlock; chunkStart += CHUNK_SIZE) {
                const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, currentBlock);
                chunks.push({ start: chunkStart, end: chunkEnd });
            }

            for (let i = 0; i < chunks.length; i++) {
                const { start, end } = chunks[i];
                setStatus(`⚡ Processing chunk ${i + 1}/${chunks.length} (conservative mode)...`);
                try {
                    const chunkPurchased = await contract.queryFilter(contract.filters.NFTPurchased(), start, end);
                    const chunkCanceled = await contract.queryFilter(contract.filters.ListingCanceled(), start, end);
                    purchasedEvents = purchasedEvents.concat(chunkPurchased);
                    canceledEvents = canceledEvents.concat(chunkCanceled);
                    await processPartialSalesData(chunkPurchased);
                } catch (chunkError) {
                    debugWarn(`⚠️ Error in chunk ${start}-${end}:`, chunkError);
                }
                if (i + 1 < chunks.length) await new Promise(r => setTimeout(r, 500));
            }

            setLastScannedBlock(currentBlock);

            const pastSales = [];
            const BATCH_SIZE = 20;
            for (let i = 0; i < purchasedEvents.length; i += BATCH_SIZE) {
                const batch = purchasedEvents.slice(i, i + BATCH_SIZE);
                setStatus(`📋 Processing transactions ${i + 1}-${Math.min(i + BATCH_SIZE, purchasedEvents.length)}/${purchasedEvents.length}...`);
                const batchResults = await Promise.all(batch.map(async (event, batchIndex) => {
                    try {
                        const block = await event.getBlock();
                        return {
                            listingId: event.args.listingId.toString(),
                            buyer: event.args.buyer,
                            quantity: event.args.quantity.toString(),
                            totalPrice: event.args.totalPrice.toString(),
                            paymentToken: event.args.paymentToken,
                            timestamp: block.timestamp * 1000,
                            type: 'sale',
                            blockNumber: event.blockNumber,
                            transactionHash: event.transactionHash
                        };
                    } catch {
                        return {
                            listingId: event.args.listingId.toString(),
                            buyer: event.args.buyer,
                            quantity: event.args.quantity.toString(),
                            totalPrice: event.args.totalPrice.toString(),
                            paymentToken: event.args.paymentToken,
                            timestamp: Date.now(),
                            type: 'sale',
                            blockNumber: event.blockNumber,
                            transactionHash: event.transactionHash
                        };
                    }
                }));
                pastSales.push(...batchResults);
            }

            const pastCanceled = new Set();
            canceledEvents.forEach(event => {
                try {
                    pastCanceled.add(event.args.listingId.toString());
                } catch { /* ignore */ }
            });

            setSalesHistory(prev => {
                const existingHashes = new Set(prev.map(sale => sale.transactionHash));
                const newSales = pastSales.filter(sale => !existingHashes.has(sale.transactionHash));
                return [...prev, ...newSales].sort((a, b) => b.timestamp - a.timestamp);
            });

            setCanceledListings(prev => new Set([...prev, ...pastCanceled]));

            setStatus(`✅ Optimized scan complete! Found ${pastSales.length} transactions and ${pastCanceled.size} cancellations using parallel processing.`);
            setTimeout(() => setStatus(""), 8000);
        } catch (error) {
            criticalError("❌ Error in optimized blockchain scan:", error);
            setStatus(`❌ Error in optimized scan: ${error.message}. Check console for details.`);
            setTimeout(() => setStatus(""), 10000);
        }
    };

    const processPartialSalesData = async (newEvents) => {
        if (!newEvents.length) return;
        try {
            const partialSales = await Promise.all(newEvents.map(async (event) => {
                try {
                    const block = await event.getBlock();
                    return {
                        listingId: event.args.listingId.toString(),
                        buyer: event.args.buyer,
                        quantity: event.args.quantity.toString(),
                        totalPrice: event.args.totalPrice.toString(),
                        paymentToken: event.args.paymentToken,
                        timestamp: block.timestamp * 1000,
                        type: 'sale',
                        blockNumber: event.blockNumber,
                        transactionHash: event.transactionHash
                    };
                } catch {
                    return {
                        listingId: event.args.listingId.toString(),
                        buyer: event.args.buyer,
                        quantity: event.args.quantity.toString(),
                        totalPrice: event.args.totalPrice.toString(),
                        paymentToken: event.args.paymentToken,
                        timestamp: Date.now(),
                        type: 'sale',
                        blockNumber: event.blockNumber,
                        transactionHash: event.transactionHash
                    };
                }
            }));

            setSalesHistory(prev => {
                const existingHashes = new Set(prev.map(sale => sale.transactionHash));
                const newSales = partialSales.filter(sale => !existingHashes.has(sale.transactionHash));
                return [...prev, ...newSales].sort((a, b) => b.timestamp - a.timestamp);
            });
        } catch (error) {
            debugWarn("Error processing partial sales data:", error);
        }
    };

    // Event listeners: update state + Supabase cache
    const setupEventListeners = (contract) => {
        try {
            contract.on("NFTPurchased", async (listingIdBn, buyer, quantity, totalPrice, paymentToken, event) => {
                try {
                    const listingId = listingIdBn.toString();
                    debugLog("NFT Purchased event:", { listingId, buyer });
                    setListings(prev => prev.filter(l => String(l.id) !== listingId));

                    // Supabase cache update (mark inactive)
                    if (supabaseConnected && cacheListings) {
                        try {
                            await cacheListings([{ id: Number(listingId), active: false }], canceledListings || new Set());
                        } catch (e) {
                            debugWarn('Supabase cache update after purchase failed:', e?.message || e);
                        }
                    }
                } catch (e) {
                    debugWarn('NFTPurchased handler failed:', e);
                }
            });

            contract.on("ListingCanceled", async (listingIdBn) => {
                try {
                    const listingId = listingIdBn.toString();
                    debugLog("Listing Canceled event:", { listingId });
                    setListings(prev => prev.filter(l => String(l.id) !== listingId));
                    setCanceledListings(prev => new Set([...prev, listingId]));

                    if (supabaseConnected && cacheListings) {
                        try {
                            await cacheListings([{ id: Number(listingId), active: false }], new Set([...canceledListings, listingId]));
                        } catch (e) {
                            debugWarn('Supabase cache update after cancel failed:', e?.message || e);
                        }
                    }
                } catch (e) {
                    debugWarn('ListingCanceled handler failed:', e);
                }
            });

            contract.on("ListingCreated", (listingId, seller, nftContract, tokenId, quantity, pricePerUnit, paymentToken, isERC1155) => {
                debugLog("New listing created:", { listingId: listingId.toString(), seller, nftContract });
                // Light background refresh to include the new listing
                setTimeout(() => fetchListings(true), 1500);
            });

            debugLog("Event listeners set up successfully");
        } catch (error) {
            criticalError("Error setting up event listeners:", error);
        }
    };

    // Stats calculation (unchanged)
    const calculateMarketplaceStats = useCallback(async () => {
        if (!provider) return;

        try {
            try {
                await provider.getNetwork();
            } catch (networkError) {
                debugWarn("Network issue - calculating stats with fallback values");
                const now = Date.now();
                const hour = 60 * 60 * 1000;
                const day = 24 * hour;
                const week = 7 * day;
                const month = 30 * day;

                let totalNativeVolume = 0;
                let volume1h = 0, volume6h = 0, volume12h = 0;
                let volume24h = 0, volume7d = 0, volume30d = 0;
                let sales1h = 0, sales6h = 0, sales12h = 0;
                let sales24h = 0, sales7d = 0, sales30d = 0;

                let priceSum = 0, priceCount = 0;
                let highestPrice = 0, lowestPrice = Infinity;
                const priceHistory = [];

                const uniqueBuyers = new Set();
                const hourlyVolume = new Array(24).fill(0);
                const dailyVolume = new Array(30).fill(0);

                for (const sale of salesHistory) {
                    try {
                        const nativeValue = parseFloat(ethers.formatEther(sale.totalPrice));
                        totalNativeVolume += nativeValue;
                        priceSum += nativeValue;
                        priceCount++;
                        if (nativeValue > highestPrice) highestPrice = nativeValue;
                        if (nativeValue < lowestPrice) lowestPrice = nativeValue;
                        priceHistory.push({ price: nativeValue, timestamp: sale.timestamp });
                        uniqueBuyers.add(sale.buyer);

                        const saleAge = now - sale.timestamp;
                        const saleHour = Math.floor(saleAge / hour);
                        const saleDay = Math.floor(saleAge / day);

                        if (saleHour < 24) hourlyVolume[saleHour] += nativeValue;
                        if (saleDay < 30) dailyVolume[saleDay] += nativeValue;

                        if (saleAge <= hour) { volume1h += nativeValue; sales1h++; }
                        if (saleAge <= 6 * hour) { volume6h += nativeValue; sales6h++; }
                        if (saleAge <= 12 * hour) { volume12h += nativeValue; sales12h++; }
                        if (saleAge <= day) { volume24h += nativeValue; sales24h++; }
                        if (saleAge <= week) { volume7d += nativeValue; sales7d++; }
                        if (saleAge <= month) { volume30d += nativeValue; sales30d++; }
                    } catch { /* ignore */ }
                }

                let currentListingVolumeNative = 0;
                const activeListings = listings.filter(listing =>
                    listing.active && !canceledListings.has(listing.id.toString())
                );
                for (const listing of activeListings) {
                    try {
                        const nativeValue = parseFloat(ethers.formatEther(listing.pricePerUnit));
                        currentListingVolumeNative += nativeValue;
                    } catch { /* ignore */ }
                }

                const avgPrice = priceCount > 0 ? priceSum / priceCount : 0;
                const marketCap = totalNativeVolume;
                const liquidityRatio = currentListingVolumeNative / (totalNativeVolume || 1);
                const marketVelocity24h = volume7d > 0 ? (volume24h / (volume7d / 7)) : 0;
                const marketVelocity7d = volume30d > 0 ? (volume7d / (volume30d / 30)) : 0;
                const growthRate24h = volume7d > volume24h ? ((volume24h - (volume7d - volume24h) / 6) / ((volume7d - volume24h) / 6 || 1)) * 100 : 0;
                const growthRate7d = volume30d > volume7d ? ((volume7d - (volume30d - volume7d) / 3) / ((volume30d - volume7d) / 3 || 1)) * 100 : 0;
                const volumeScore = Math.min((volume24h / Math.max(volume7d / 7, 0.01)) * 25, 25);
                const activityScore = Math.min((sales24h / Math.max(sales7d / 7, 0.01)) * 25, 25);
                const liquidityScore = Math.min(liquidityRatio * 25, 25);
                const diversityScore = Math.min(uniqueBuyers.size * 5, 25);
                const marketHealthScore = volumeScore + activityScore + liquidityScore + diversityScore;

                const transactionHistory = salesHistory.map(sale => ({
                    ...sale,
                    formattedTimestamp: new Date(sale.timestamp).toLocaleString()
                })).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);

                setMarketplaceStats({
                    totalSales: salesHistory.length,
                    actualSoldVolume: totalNativeVolume,
                    currentListingVolume: currentListingVolumeNative,
                    volume1h, volume6h, volume12h,
                    volume24h, volume7d, volume30d,
                    volumeAllTime: totalNativeVolume,
                    sales1h, sales6h, sales12h,
                    sales24h, sales7d, sales30d,
                    avgPrice, highestPrice, lowestPrice: lowestPrice === Infinity ? 0 : lowestPrice,
                    marketCap, liquidityRatio, marketVelocity24h, marketVelocity7d,
                    growthRate24h, growthRate7d, marketHealthScore,
                    uniqueBuyers: uniqueBuyers.size,
                    hourlyVolume, dailyVolume, priceHistory,
                    transactionHistory,
                    topTokens: [{ token: ethers.ZeroAddress, volume: totalNativeVolume, sales: salesHistory.length }],
                    mostActiveSellers: []
                });
                return;
            }

            // Full USDC path (unchanged)
            const now = Date.now();
            const hour = 60 * 60 * 1000;
            const day = 24 * hour;
            const week = 7 * day;
            const month = 30 * day;

            let actualSoldVolumeUSDC = 0;
            let volume1hUSDC = 0, volume6hUSDC = 0, volume12hUSDC = 0;
            let volume24hUSDC = 0, volume7dUSDC = 0, volume30dUSDC = 0;
            let sales1h = 0, sales6h = 0, sales12h = 0;
            let sales24h = 0, sales7d = 0, sales30d = 0;

            let priceSum = 0, priceCount = 0;
            let highestPrice = 0, lowestPrice = Infinity;
            const priceHistory = [];
            const uniqueBuyers = new Set();
            const hourlyVolume = new Array(24).fill(0);
            const dailyVolume = new Array(30).fill(0);

            const topTokensMap = {};
            const sellerStatsMap = {};

            for (const sale of salesHistory) {
                try {
                    const usdcValue = await convertToUSDCValue(sale.totalPrice, sale.paymentToken, provider);
                    actualSoldVolumeUSDC += usdcValue;
                    priceSum += usdcValue; priceCount++;
                    if (usdcValue > highestPrice) highestPrice = usdcValue;
                    if (usdcValue < lowestPrice) lowestPrice = usdcValue;
                    priceHistory.push({ price: usdcValue, timestamp: sale.timestamp });
                    uniqueBuyers.add(sale.buyer);

                    const saleAge = now - sale.timestamp;
                    const saleHour = Math.floor(saleAge / hour);
                    const saleDay = Math.floor(saleAge / day);

                    if (saleHour < 24) hourlyVolume[saleHour] += usdcValue;
                    if (saleDay < 30) dailyVolume[saleDay] += usdcValue;

                    if (saleAge <= hour) { volume1hUSDC += usdcValue; sales1h++; }
                    if (saleAge <= 6 * hour) { volume6hUSDC += usdcValue; sales6h++; }
                    if (saleAge <= 12 * hour) { volume12hUSDC += usdcValue; sales12h++; }
                    if (saleAge <= day) { volume24hUSDC += usdcValue; sales24h++; }
                    if (saleAge <= week) { volume7dUSDC += usdcValue; sales7d++; }
                    if (saleAge <= month) { volume30dUSDC += usdcValue; sales30d++; }

                    const tokenKey = sale.paymentToken || 'VTRU';
                    if (!topTokensMap[tokenKey]) topTokensMap[tokenKey] = { volume: 0, sales: 0, token: tokenKey };
                    topTokensMap[tokenKey].volume += usdcValue;
                    topTokensMap[tokenKey].sales += 1;
                } catch { /* ignore */ }
            }

            let currentListingVolumeUSDC = 0;
            const activeListings = listings.filter(listing =>
                listing.active && !canceledListings.has(listing.id.toString())
            );

            for (const listing of activeListings) {
                try {
                    const usdcValue = await convertToUSDCValue(listing.pricePerUnit, listing.paymentToken, provider);
                    currentListingVolumeUSDC += usdcValue;

                    if (!sellerStatsMap[listing.seller]) {
                        sellerStatsMap[listing.seller] = { address: listing.seller, listingsCount: 0, totalVolume: 0 };
                    }
                    sellerStatsMap[listing.seller].listingsCount += 1;
                    sellerStatsMap[listing.seller].totalVolume += usdcValue;
                } catch { /* ignore */ }
            }

            const transactionHistory = salesHistory.map(sale => ({
                ...sale,
                formattedTimestamp: new Date(sale.timestamp).toLocaleString()
            })).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);

            const topTokens = Object.values(topTokensMap)
                .sort((a, b) => b.volume - a.volume)
                .slice(0, 10);

            const mostActiveSellers = Object.values(sellerStatsMap)
                .sort((a, b) => b.listingsCount - a.listingsCount)
                .slice(0, 10);

            const avgPrice = priceCount > 0 ? priceSum / priceCount : 0;
            const marketCap = actualSoldVolumeUSDC;
            const liquidityRatio = currentListingVolumeUSDC / (actualSoldVolumeUSDC || 1);
            const marketVelocity24h = volume7dUSDC > 0 ? (volume24hUSDC / (volume7dUSDC / 7)) : 0;
            const marketVelocity7d = volume30dUSDC > 0 ? (volume7dUSDC / (volume30dUSDC / 30)) : 0;
            const growthRate24h = volume7dUSDC > volume24hUSDC ? ((volume24hUSDC - (volume7dUSDC - volume24hUSDC) / 6) / ((volume7dUSDC - volume24hUSDC) / 6 || 1)) * 100 : 0;
            const growthRate7d = volume30dUSDC > volume7dUSDC ? ((volume7dUSDC - (volume30dUSDC - volume7dUSDC) / 3) / ((volume30dUSDC - volume7dUSDC) / 3 || 1)) * 100 : 0;
            const volumeScore = Math.min((volume24hUSDC / Math.max(volume7dUSDC / 7, 0.01)) * 25, 25);
            const activityScore = Math.min((sales24h / Math.max(sales7d / 7, 0.01)) * 25, 25);
            const liquidityScore = Math.min(liquidityRatio * 25, 25);
            const diversityScore = Math.min(uniqueBuyers.size * 5, 25);
            const marketHealthScore = volumeScore + activityScore + liquidityScore + diversityScore;
            const turnoverRate = actualSoldVolumeUSDC > 0 ? (volume30dUSDC / actualSoldVolumeUSDC) * 100 : 0;

            setMarketplaceStats({
                totalSales: salesHistory.length,
                actualSoldVolume: actualSoldVolumeUSDC,
                currentListingVolume: currentListingVolumeUSDC,
                volume1h: volume1hUSDC,
                volume6h: volume6hUSDC,
                volume12h: volume12hUSDC,
                volume24h: volume24hUSDC,
                volume7d: volume7dUSDC,
                volume30d: volume30dUSDC,
                volumeAllTime: actualSoldVolumeUSDC,
                sales1h, sales6h, sales12h, sales24h, sales7d, sales30d,
                avgPrice,
                highestPrice,
                lowestPrice: lowestPrice === Infinity ? 0 : lowestPrice,
                marketCap,
                liquidityRatio,
                marketVelocity24h,
                marketVelocity7d,
                growthRate24h,
                growthRate7d,
                marketHealthScore,
                turnoverRate,
                uniqueBuyers: uniqueBuyers.size,
                hourlyVolume,
                dailyVolume,
                priceHistory,
                transactionHistory,
                topTokens,
                mostActiveSellers
            });

        } catch (error) {
            criticalError("Error calculating marketplace stats:", error);
        }
    }, [salesHistory, listings, canceledListings, provider]);

    useEffect(() => {
        calculateMarketplaceStats();
    }, [calculateMarketplaceStats]);

    // Track last cache update time to prevent excessive calls
    const [isLoading, setIsLoading] = useState(false);
    const lastCacheUpdateRef = useRef(0);
    const CACHE_UPDATE_COOLDOWN = 30000;

    // New: Supabase-first fast load, then background on-chain refresh
    const fetchListings = async (forceRefresh = false) => {
        if (!marketplace) {
            debugWarn("Marketplace contract not initialized yet");
            return;
        }
        if (isLoading) {
            debugLog("Fetch already in progress, skipping concurrent request");
            return;
        }

        setIsLoading(true);
        setStatus('Loading listings...');
        debugLog(`fetchListings called with forceRefresh=${forceRefresh}, supabaseConnected=${supabaseConnected}`);

        try {
            let cached = [];
            if (supabaseConnected && getCachedListings) {
                try {
                    cached = await getCachedListings();
                    if (Array.isArray(cached) && cached.length) {
                        debugLog(`⚡ Showing ${cached.length} cached listings (Supabase)`);
                        setListings(cached);
                        setHotListings(cached.slice(0, 5));
                        setStatus('Showing cached listings while refreshing...');
                    }
                } catch (e) {
                    debugWarn("Failed to load listings from Supabase cache:", e?.message || e);
                }
            }

            // Always refresh from chain in background
            await fetchListingsFromBlockchain(true, cached);
            lastCacheUpdateRef.current = Date.now();
            setTimeout(() => setStatus(''), 2000);
        } catch (error) {
            criticalError("Error in fetchListings:", error);
            // Fallback handled above; if no cache either:
            setStatus('Failed to fetch listings');
        } finally {
            setIsLoading(false);
        }
    };

    // Replaced: fast, concurrent scan using events + listings() reads; metadata from cache only
    const fetchListingsFromBlockchain = async (isBackgroundUpdate = false, existingListings = []) => {
        if (!provider || !marketplace) return;

        if (!isBackgroundUpdate) {
            setStatus('Fetching latest listings from blockchain...');
        } else {
            setStatus('Checking for new listings...');
        }

        try {
            try {
                await provider.getNetwork();
            } catch (networkError) {
                debugWarn("Network connectivity issue:", networkError.message);
                if (existingListings.length > 0) {
                    setStatus("Network issue - showing cached listings");
                    setTimeout(() => setStatus(''), 3000);
                    return;
                } else {
                    setListings([]);
                    setHotListings([]);
                    setStatus("Network connectivity issue - please try again later");
                    setTimeout(() => setStatus(''), 5000);
                    return;
                }
            }

            const currentBlock = await provider.getBlockNumber();
            const WINDOW = 200_000;
            const fromBlock = Math.max(0, currentBlock - WINDOW);

            // Pull events to discover active IDs
            const [created, canceled, purchased] = await Promise.all([
                marketplace.queryFilter(marketplace.filters.ListingCreated(), fromBlock, currentBlock),
                marketplace.queryFilter(marketplace.filters.ListingCanceled(), fromBlock, currentBlock),
                marketplace.queryFilter(marketplace.filters.NFTPurchased(), fromBlock, currentBlock)
            ]);

            const ids = new Set(created.map(e => e.args?.listingId?.toString() || e.args?.[0]?.toString()).filter(Boolean));
            const cachedById = new Map();
            for (const c of existingListings || []) {
                if (c?.id != null) {
                    ids.add(String(c.id));
                    cachedById.set(String(c.id), c);
                }
            }

            const idList = Array.from(ids);
            setStatus(`Reading ${idList.length} listings from contract...`);

            const CONCURRENCY = 24;
            const rows = await mapLimit(idList, CONCURRENCY, async (id) => {
                try {
                    const l = await marketplace.listings(id);
                    if (!l || !l.seller || String(l.seller) === ethers.ZeroAddress) return null;

                    // Merge cached metadata only
                    const cached = cachedById.get(String(id));
                    const image =
                        cached?.image ||
                        cached?.imageUrl ||
                        cached?.metadata?.image ||
                        cached?.metadata?.image_url ||
                        '';
                    const name =
                        cached?.name ||
                        cached?.metadata?.name ||
                        `NFT #${String(l.tokenId)}`;

                    return {
                        id: Number(id),
                        seller: l.seller || ethers.ZeroAddress,
                        nftContract: (l.nftContract || ethers.ZeroAddress),
                        tokenId: l.tokenId?.toString?.() || '0',
                        quantity: standardizeBigInt(l.quantity || '0'),
                        pricePerUnit: standardizeBigInt(l.pricePerUnit || '0'),
                        paymentToken: l.paymentToken || ethers.ZeroAddress,
                        isERC1155: !!l.isERC1155,
                        active: !!l.active,
                        image,
                        imageUrl: image,
                        name,
                        title: name,
                        metadata: cached?.metadata || null
                    };
                } catch {
                    return null;
                }
            });

            const canceledIds = new Set(canceled.map(e => e.args?.listingId?.toString() || e.args?.[0]?.toString()).filter(Boolean));
            const purchasedIds = new Set(purchased.map(e => e.args?.listingId?.toString() || e.args?.[0]?.toString()).filter(Boolean));

            const merged = (rows.filter(Boolean)).map(row => {
                const idStr = String(row.id);
                if (canceledIds.has(idStr) || purchasedIds.has(idStr)) {
                    return { ...row, active: false };
                }
                return row;
            });

            const active = merged.filter(l => l.active);

            setListings(active);
            setHotListings(active.slice(0, 5));
            setStatus(`Loaded ${active.length} active listings`);

            // Upsert cache (safe size)
            const MAX_SAFE_CACHE_SIZE = 400;
            const shouldCache = supabaseConnected && active.length > 0 && active.length <= MAX_SAFE_CACHE_SIZE;
            if (shouldCache && cacheListings) {
                try {
                    debugLog(`💾 Caching ${active.length} listings to Supabase...`);
                    await cacheListings(active, canceledListings || new Set());
                } catch (e) {
                    debugWarn('Supabase cache upsert failed:', e?.message || e);
                }
            }

            setTimeout(() => setStatus(''), isBackgroundUpdate ? 1200 : 2200);
        } catch (error) {
            criticalError("Error in fetchListingsFromBlockchain:", error);

            if (isBackgroundUpdate && existingListings.length > 0) {
                setStatus('Update failed - showing cached listings');
                setTimeout(() => setStatus(''), 3000);
            } else {
                setStatus('Failed to fetch listings - network connectivity issue');
            }
        }
    };

    // ERC20 ABIs
    const ERC20_ABI = [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)'
    ];

    const ERC721_APPROVAL_ABI = [
        'function isApprovedForAll(address owner, address operator) view returns (bool)',
        'function getApproved(uint256 tokenId) view returns (address)',
        'function setApprovalForAll(address operator, bool approved)'
    ];

    const ERC1155_APPROVAL_ABI = [
        'function isApprovedForAll(address owner, address operator) view returns (bool)',
        'function setApprovalForAll(address operator, bool approved)'
    ];

    // ===== Buffer-aware ERC20 allowance helper =====
    async function ensureAllowanceWithBuffer({
        tokenAddress,
        owner,
        spender,
        needed,
        signer,
        setStatus,
        bufferBps = 1000n,
    }) {
        const erc20 = new ethers.Contract(tokenAddress, [
            'function symbol() view returns (string)',
            'function decimals() view returns (uint8)',
            'function allowance(address,address) view returns (uint256)',
            'function approve(address,uint256) returns (bool)'
        ], signer);

        const [symbol, allowanceRaw] = await Promise.all([
            erc20.symbol().catch(() => 'TOKEN'),
            erc20.allowance(owner, spender),
        ]);

        const allowance = BigInt(allowanceRaw.toString());
        const extra = (needed * bufferBps) / 10_000n;
        const neededWithBuffer = needed + extra;

        if (allowance >= neededWithBuffer) {
            return { symbol, approved: true, allowance, neededWithBuffer };
        }

        const ask = async (amount, label) => {
            setStatus?.(`Approving ${symbol}${label ? ` (${label})` : ''}...`);
            const tx = await erc20.approve(spender, amount);
            setStatus?.(`Confirming ${symbol} approval...`);
            await tx.wait();
        };

        try {
            await ask(ethers.MaxUint256, 'max');
            return { symbol, approved: true, allowance: ethers.MaxUint256, neededWithBuffer };
        } catch (e1) {
            const m = (e1?.reason || e1?.message || '').toLowerCase();

            if (m.includes('allowance') || m.includes('must be zero') || m.includes('non-zero')) {
                try {
                    await ask(0, 'reset to 0');
                    await ask(ethers.MaxUint256, 'max');
                    return { symbol, approved: true, allowance: ethers.MaxUint256, neededWithBuffer };
                } catch (e2) {
                    try {
                        await ask(neededWithBuffer, `exact ${symbol}`);
                        return { symbol, approved: true, allowance: neededWithBuffer, neededWithBuffer };
                    } catch (e3) {
                        throw new Error(`Failed to approve ${symbol}: ${e3?.message || e3}`);
                    }
                }
            }

            try {
                await ask(neededWithBuffer, `exact ${symbol}`);
                return { symbol, approved: true, allowance: neededWithBuffer, neededWithBuffer };
            } catch (e4) {
                throw new Error(`Failed to approve ${symbol}: ${e4?.message || e4}`);
            }
        }
    }

    // ===== buyListing =====
    const buyListing = async (id, _uiPricePerUnit, _uiPaymentToken, quantity = 1) => {
        if (!signer) { setStatus('Error: Wallet not connected. Please connect your wallet first'); return; }
        if (!marketplace) { setStatus('Error: Marketplace contract not initialized'); return; }

        try {
            console.log("Marketplace contract:", marketplaceAddress);
            console.log("Contract instance:", marketplace);
            console.log("Available methods:", Object.keys(marketplace).filter(k => typeof marketplace[k] === 'function'));

            const spender = (marketplace && marketplace.target) || marketplaceAddress;
            setStatus('Checking listing details...');

            const l = await marketplace.listings(id);
            if (!l || !l.active) { setStatus('Error: Listing is inactive'); return; }

            const is1155 = !!l.isERC1155;
            const listed = BigInt(l.quantity?.toString?.() ?? String(l.quantity ?? '0'));
            const qty = BigInt(String(quantity || 1));

            if (!is1155 && qty !== 1n) { setStatus('Error: ERC-721 quantity must be 1'); return; }
            if (is1155 && (qty <= 0n || qty > listed)) { setStatus('Error: Requested quantity exceeds available'); return; }

            const unit = BigInt(l.pricePerUnit?.toString?.() ?? String(l.pricePerUnit ?? '0'));
            const total = unit * qty;
            const token = l.paymentToken;
            const isNative = !token || String(token).toLowerCase() === ethers.ZeroAddress.toLowerCase();

            console.log('Buy Details:', {
                listingId: id,
                pricePerUnit: ethers.formatEther(unit),
                totalPrice: ethers.formatEther(total),
                paymentToken: token,
                isNative,
                quantity: qty.toString()
            });

            const walletBal = await provider.getBalance(wallet);
            console.log(`Wallet Native Balance: ${ethers.formatEther(walletBal)} VTRU`);
            setStatus(`Preparing transaction with ${ethers.formatEther(total)} VTRU...`);

            const connectedContract = marketplace.connect ? marketplace.connect(signer) : marketplace;

            if (isNative) {
                const gasLimit = 600000n;

                try {
                    const tx = await connectedContract.buy(id, qty, {
                        value: total,
                        gasLimit
                    });
                    setStatus('Transaction submitted. Waiting for confirmation...');
                    await tx.wait();
                } catch (callError) {
                    console.error("First attempt failed:", callError);

                    const txData = connectedContract.interface.encodeFunctionData('buy', [id, qty]);
                    const tx = await signer.sendTransaction({
                        to: marketplaceAddress,
                        data: txData,
                        value: total,
                        gasLimit
                    });

                    setStatus('Transaction submitted (fallback method). Waiting for confirmation...');
                    await tx.wait();
                }
            } else {
                const erc20 = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], provider);
                const bal = BigInt((await erc20.balanceOf(wallet)).toString());
                if (bal < total) { setStatus('Error: Insufficient token balance for this purchase'); return; }

                await ensureAllowanceWithBuffer({
                    tokenAddress: token,
                    owner: wallet,
                    spender,
                    needed: total,
                    signer,
                    setStatus,
                    bufferBps: 1000n
                });

                const tx = await connectedContract.buy(id, qty);
                setStatus('Transaction submitted. Waiting for confirmation...');
                await tx.wait();
            }

            setStatus('Purchase successful! Updating listings...');
            if (supabaseConnected && cacheListings) await fetchListings(true); else fetchListings();

            setTimeout(() => {
                setStatus('Purchase successful!');
                setTimeout(() => setStatus(''), 3000);
            }, 1200);
        } catch (e) {
            criticalError('Error in buyListing:', e);
            console.error('Full error details:', e);

            const em = String(e?.message || '').toLowerCase();
            if (em.includes('user rejected')) setStatus('Transaction was rejected in your wallet');
            else if (em.includes('insufficient funds')) setStatus(`Error: Insufficient funds for gas + payment. You need more VTRU.`);
            else if (em.includes('cannot read') || em.includes('undefined')) {
                setStatus('Contract function access error. Using fallback method...');

                try {
                    const l = await marketplace.listings(id);
                    const qty = BigInt(String(quantity || 1));
                    const total = BigInt(l.pricePerUnit?.toString() ?? '0') * qty;

                    const ABI = ["function buy(uint256 listingId, uint256 buyQuantity)"];
                    const iface = new ethers.Interface(ABI);
                    const data = iface.encodeFunctionData("buy", [id, qty]);

                    const tx = await signer.sendTransaction({
                        to: marketplaceAddress,
                        data: data,
                        value: total,
                        gasLimit: 800000n
                    });

                    setStatus('Transaction submitted (manual fallback). Waiting for confirmation...');
                    await tx.wait();
                    setStatus('Purchase successful!');
                } catch (fallbackError) {
                    setStatus(`Transaction failed: ${fallbackError.message}`);
                }
            }
            else setStatus('Buy failed: ' + (e.message || e));
        }
    };

    const createListing = async (nftContract, tokenId, quantity, price, paymentToken) => {
        try {
            if (!signer) {
                setStatus("Error: Wallet not connected. Please connect your wallet first");
                return;
            }

            if (!marketplace) {
                throw new Error("Marketplace contract not initialized");
            }

            setStatus("Preparing listing...");
            debugLog("Creating listing with parameters:", {
                nftContract,
                tokenId,
                quantity,
                price,
                paymentToken
            });

            // Detect erc1155 vs erc721
            let isERC1155 = false;
            try {
                const testContract = new ethers.Contract(
                    nftContract,
                    ['function balanceOf(address, uint256) view returns (uint256)'],
                    provider
                );
                await testContract.balanceOf(wallet, tokenId);
                isERC1155 = true;
                debugLog(`Detected ${nftContract} as ERC1155`);
            } catch {
                debugLog(`Detected ${nftContract} as ERC721`);
                isERC1155 = false;
            }

            if (isERC1155) {
                const nftContract1155 = new ethers.Contract(nftContract, ERC1155_APPROVAL_ABI, signer);
                const isApproved = await nftContract1155.isApprovedForAll(wallet, marketplaceAddress);

                if (!isApproved) {
                    setStatus("Requesting approval to sell your NFTs...");
                    const approvalTx = await nftContract1155.setApprovalForAll(marketplaceAddress, true);
                    setStatus("Approval transaction submitted. Please wait for confirmation...");
                    await approvalTx.wait();
                    setStatus("Approval confirmed! Creating listing...");
                }
            } else {
                const nftContract721 = new ethers.Contract(nftContract, ERC721_APPROVAL_ABI, signer);
                const isApprovedForAll = await nftContract721.isApprovedForAll(wallet, marketplaceAddress);

                if (!isApprovedForAll) {
                    const approvedAddress = await nftContract721.getApproved(tokenId);
                    const isTokenApproved = approvedAddress.toLowerCase() === marketplaceAddress.toLowerCase();

                    if (!isTokenApproved) {
                        setStatus("Requesting approval to sell your NFT...");
                        const approvalTx = await nftContract721.setApprovalForAll(marketplaceAddress, true);
                        setStatus("Approval transaction submitted. Please wait for confirmation...");
                        await approvalTx.wait();
                        setStatus("Approval confirmed! Creating listing...");
                    }
                }
            }

            setStatus("Creating listing...");
            const marketplaceWithSigner = marketplace.connect(signer);

            const tx = await marketplaceWithSigner.createListing(
                nftContract,
                tokenId,
                quantity,
                price,
                paymentToken
            );

            setStatus("Transaction submitted. Waiting for confirmation...");
            await tx.wait();
            setStatus("Listing created successfully!");

            if (supabaseConnected && cacheListings) {
                debugLog("💾 Invalidating cache due to new listing...");
                await fetchListings(true);
            } else {
                fetchListings();
            }

        } catch (error) {
            criticalError("Error in createListing:", error);

            if (error.message.includes("user rejected")) {
                setStatus("Transaction was rejected in your wallet");
            } else if (error.message.includes("contract runner does not support")) {
                setStatus("Error: Wallet not properly connected. Please disconnect and reconnect your wallet.");
            } else if (error.message.includes("insufficient funds")) {
                setStatus("Error: Insufficient funds for gas");
            } else {
                setStatus(`Error: ${error.message || "Failed to create listing"}`);
            }
            throw error;
        }
    };

    // Load listings on initial load only - no automatic refresh
    useEffect(() => {
        if (marketplace) {
            fetchListings();
        }
    }, [marketplace]);

    // Helpers for ABI resolution
    function hasAbiFn(abi, name) {
        try { return Array.isArray(abi) && abi.some(e => e?.type === 'function' && e?.name === name); }
        catch { return false; }
    }

    async function resolveMarketplaceAbi(incomingAbi) {
        if (hasAbiFn(incomingAbi, 'buy')) return incomingAbi;

        try {
            const A = await import('../abi/VTRUNFTMarketplace.json');
            const abiA = A.default?.abi || A.abi;
            if (hasAbiFn(abiA, 'buy')) return abiA;
        } catch { }

        try {
            const B = await import('../abi/Marketplace.json');
            const abiB = B.default?.abi || B.abi;
            if (hasAbiFn(abiB, 'buy')) return abiB;
        } catch { }

        throw new Error('No ABI with buy() found. Ensure VTRUNFTMarketplace ABI is provided.');
    }

    return (
        <MarketplaceContext.Provider value={{
            marketplace,
            marketplaceAddress,
            listings,
            hotListings,
            status,
            persistentStatus,
            statusType,
            setStatus: setStatusWithType,
            clearStatus,
            clearPersistentStatus,
            fetchListings,
            buyListing,
            createListing,
            isInitialized,
            isLoading,
            salesHistory,
            canceledListings,
            marketplaceStats,
            calculateMarketplaceStats,
            refreshBlockchainData: () => marketplace && fetchPastSalesEvents(marketplace)
        }}>
            {children}
        </MarketplaceContext.Provider>
    );
}

export function useMarketplace() {
    return useContext(MarketplaceContext);
}

// Add this function to reset allowances
async function resetTokenAllowance(tokenAddress, spender, setStatus) {
    // signer is closed over from provider; in module scope it's undefined, so keep function for reference only
    try {
        setStatus(`Reset allowance not wired in this scope`);
        return false;
    } catch {
        return false;
    }
}