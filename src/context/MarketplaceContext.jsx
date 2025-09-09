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

export function MarketplaceProvider({ children, marketplaceAddress, abi }) {
    const { wallet, signer, provider } = useWallet();
    const { 
        cacheListings, 
        getCachedListings, 
        cacheSalesHistory,
        getCachedSalesHistory,
        removeSoldListings,
        subscribeToListings,
        isConnected: supabaseConnected 
    } = useSupabase();
    const [marketplace, setMarketplace] = useState(null);
    const [listings, setListings] = useState([]);
    const [hotListings, setHotListings] = useState([]);
    const [status, setStatus] = useState('');
    const [persistentStatus, setPersistentStatus] = useState(''); // For stale data warnings
    const [statusType, setStatusType] = useState('info'); // 'info', 'warning', 'error', 'success'
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
        // Enhanced time-based volume metrics
        volume1h: 0,
        volume6h: 0,
        volume12h: 0,
        volume24h: 0,
        volume7d: 0,
        volume30d: 0,
        volumeAllTime: 0,
        // Enhanced sales count metrics
        sales1h: 0,
        sales6h: 0,
        sales12h: 0,
        sales24h: 0,
        sales7d: 0,
        sales30d: 0,
        // Advanced analytics
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

    // State for tracking loading operations to prevent race conditions
    const [isLoading, setIsLoading] = useState(false);
    const [lastCacheSignature, setLastCacheSignature] = useState(null);

    // Enhanced status management with persistence for important messages
    const setStatusWithType = (message, type = 'info', persistent = false) => {
        setStatus(message);
        setStatusType(type);
        
        if (persistent) {
            setPersistentStatus(message);
        }
    };
    
    const clearStatus = () => {
        setStatus('');
        setStatusType('info');
    };
    
    const clearPersistentStatus = () => {
        setPersistentStatus('');
    };

    // Load sales history from Supabase cache first, fallback to localStorage
    // Use a ref to prevent infinite loops from function reference changes
    const hasLoadedInitialData = useRef(false);
    
    useEffect(() => {
        // Only load once when the component mounts or when Supabase connection status changes
        if (hasLoadedInitialData.current && supabaseConnected === hasLoadedInitialData.supabaseState) {
            return; // Prevent re-loading if already loaded and connection state hasn't changed
        }
        
        const loadPersistedData = async () => {
            try {
                // Try to load from Supabase cache first
                if (supabaseConnected && getCachedSalesHistory) {
                    debugLog("Loading sales history from Supabase cache...");
                    const cachedSales = await getCachedSalesHistory();
                    
                    if (cachedSales && cachedSales.length > 0) {
                        debugLog(`Loaded ${cachedSales.length} sales from Supabase cache`);
                        setSalesHistory(cachedSales);
                    } else {
                        // Fallback to localStorage if no Supabase cache
                        debugLog("No Supabase cache found, falling back to localStorage");
                        loadFromLocalStorage();
                    }
                } else {
                    // Load from localStorage if Supabase not connected
                    loadFromLocalStorage();
                }
                
                // Always load canceled listings from localStorage (smaller data set)
                const savedCanceledListings = localStorage.getItem('marketplace_canceled_listings');
                if (savedCanceledListings) {
                    const parsedCanceled = JSON.parse(savedCanceledListings);
                    setCanceledListings(new Set(parsedCanceled));
                }
                
                // Mark as loaded and store connection state
                hasLoadedInitialData.current = true;
                hasLoadedInitialData.supabaseState = supabaseConnected;
            } catch (error) {
                criticalError("Error loading persisted marketplace data:", error);
                // Fallback to localStorage on any error
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
    }, [supabaseConnected]); // Removed getCachedSalesHistory from dependencies to prevent infinite loops

    // Enhanced cache persistence with content-based invalidation
    const lastCachedSalesCount = useRef(0);
    useEffect(() => {
        if (salesHistory.length > 0) {
            // Use async function inside useEffect
            const cacheSales = async () => {
                try {
                    // Always persist to localStorage for immediate access
                    localStorage.setItem('marketplace_sales_history', JSON.stringify(salesHistory));
                    debugLog("Persisted sales history to localStorage:", salesHistory.length, "transactions");
                    
                    // Check if content has actually changed using signature
                    const currentSignature = createContentSignature({ salesHistory });
                    if (lastCacheSignature !== currentSignature) {
                        setLastCacheSignature(currentSignature);
                        debugLog("Sales history content changed, signature updated");
                    }
                    
                    // Smart sales history caching with reasonable limits
                    const MAX_SAFE_SALES_CACHE = 500; // Reasonable limit for sales history
                    const shouldCacheSales = supabaseConnected && salesHistory.length > 0 && 
                                           salesHistory.length <= MAX_SAFE_SALES_CACHE && 
                                           lastCacheSignature !== currentSignature;
                    
                    if (shouldCacheSales && cacheSalesHistory) {
                        try {
                            debugLog(`💾 Smart caching ${salesHistory.length} sales (within safe limit)...`);
                            await cacheSalesHistory(salesHistory);
                            debugLog(`✅ Successfully cached sales history`);
                            
                            // Remove sold listings from marketplace and profiles
                            if (removeSoldListings && salesHistory.length > 0) {
                                try {
                                    debugLog(`🧹 Removing ${salesHistory.length} sold listings from marketplace...`);
                                    await removeSoldListings(salesHistory);
                                    debugLog(`✅ Successfully removed sold listings`);
                                } catch (removeError) {
                                    debugWarn("❌ Failed to remove sold listings:", removeError);
                                }
                            }
                            
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
            
            // Call the async function
            cacheSales();
        }
    }, [salesHistory]); // Removed supabaseConnected from dependencies as noted in original

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
                    console.log("[CONTRACT INIT] Starting marketplace contract initialization...");
                    console.log("[CONTRACT INIT] Marketplace address:", marketplaceAddress);
                    console.log("[CONTRACT INIT] Incoming ABI type:", typeof abi);
                    console.log("[CONTRACT INIT] Incoming ABI is array:", Array.isArray(abi));
                    
                    const resolvedAbi = await resolveMarketplaceAbi(abi);
                    console.log("[CONTRACT INIT] Resolved ABI type:", typeof resolvedAbi);
                    console.log("[CONTRACT INIT] Resolved ABI is array:", Array.isArray(resolvedAbi));
                    console.log("[CONTRACT INIT] Resolved ABI length:", resolvedAbi?.length);
                    
                    if (!hasAbiFn(resolvedAbi, 'buy')) {
                        throw new Error('Resolved ABI still missing buy()');
                    }
                    console.log("[CONTRACT INIT] ABI validation passed - buy() function found");

                    const contract = new ethers.Contract(marketplaceAddress, resolvedAbi, provider);
                    console.log("[CONTRACT INIT] Contract created successfully");
                    console.log("[CONTRACT INIT] Contract address:", contract.target);
                    console.log("[CONTRACT INIT] Contract interface:", !!contract.interface);
                    console.log("[CONTRACT INIT] Contract methods available:", Object.getOwnPropertyNames(contract).filter(name => 
                        typeof contract[name] === 'function' && !name.startsWith('_')));

                    setMarketplace(contract);
                    setIsInitialized(true);
                    console.log("[CONTRACT INIT] Marketplace initialization completed successfully");
                    
                    // Test network connectivity before setting up events
                    try {
                        await provider.getNetwork();
                        // Event listeners and blockchain scanning disabled for production
                    } catch (networkError) {
                        debugWarn("Network connectivity issue - event listeners not set up:", networkError.message);
                        setStatus("Network connectivity issue - running in offline mode. Sales tracking unavailable.");
                    }
                } catch (error) {
                    criticalError("[CONTRACT INIT] Error initializing marketplace contract:", error);
                    console.error("[CONTRACT INIT] Full error details:", error);
                    setStatus("Failed to initialize marketplace contract (ABI mismatch)");
                }
            }
        };

        initializeMarketplace();
    }, [marketplaceAddress, abi, provider]);

    // Manual refresh functionality if needed
    useEffect(() => {
        // No automatic periodic updates - user must manually refresh
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

    // Enhanced cache for processed blocks to avoid re-scanning
    const [processedBlocksCache, setProcessedBlocksCache] = useState(new Set());
    const [lastScannedBlock, setLastScannedBlock] = useState(0);

    // Optimized parallel blockchain scanning with smart caching
    const fetchPastSalesEvents = async (contract) => {
        if (!contract || !provider) return;
        
        try {
            setStatus("🚀 Starting optimized blockchain scan with parallel processing...");
            debugLog("🚀 Starting optimized blockchain scan with parallel processing...");
            
            // Test network connectivity first
            try {
                await provider.getNetwork();
            } catch (networkError) {
                debugWarn("Network connectivity issue - skipping past events fetch");
                setStatus("");
                return;
            }
            
            // Get the current block number
            const currentBlock = await provider.getBlockNumber();
            
            // CONSERVATIVE SCAN: Only scan recent blocks to avoid massive data collection
            const fromBlock = Math.max(currentBlock - 50000, lastScannedBlock); // Only last 50k blocks
            
            debugLog(`🔍 CONSERVATIVE BLOCKCHAIN SCAN: Recent blocks only from ${fromBlock} to ${currentBlock}`);
            debugLog(`⚡ Limiting scan to recent 50k blocks to prevent mass data collection`);
            setStatus(`⚡ Conservative scan: recent blocks ${fromBlock} to ${currentBlock} only...`);
            
            let purchasedEvents = [];
            let canceledEvents = [];
            
            // Conservative chunk size to reduce load
            const CHUNK_SIZE = 5000; // Much smaller chunks
            const MAX_CONCURRENT_CHUNKS = 1; // Sequential processing to reduce load
            
            // Create chunk ranges
            const chunks = [];
            for (let chunkStart = fromBlock; chunkStart <= currentBlock; chunkStart += CHUNK_SIZE) {
                const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, currentBlock);
                chunks.push({ start: chunkStart, end: chunkEnd });
            }
            
            debugLog(`📊 Processing ${chunks.length} chunks with ${MAX_CONCURRENT_CHUNKS} concurrent workers`);
            
            // Process chunks in parallel batches
            for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_CHUNKS) {
                const batch = chunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
                const batchNumber = Math.floor(i / MAX_CONCURRENT_CHUNKS) + 1;
                const totalBatches = Math.ceil(chunks.length / MAX_CONCURRENT_CHUNKS);
                
                setStatus(`⚡ Processing chunk ${batchNumber}/${totalBatches} (conservative mode)...`);
                
                // Process one chunk at a time to reduce load
                const chunk = batch[0]; // Only process first chunk since MAX_CONCURRENT_CHUNKS = 1
                debugLog(`⚡ Processing chunk ${batchNumber}/${totalBatches}: ${chunk.start}-${chunk.end}`);
                const chunkPromise = async () => {
                    const { start, end } = chunk;
                    
                    // Skip if we've already processed this chunk
                    const chunkKey = `${start}-${end}`;
                    if (processedBlocksCache.has(chunkKey)) {
                        debugLog(`⚡ Skipping cached chunk: ${chunkKey}`);
                        return { purchased: [], canceled: [] };
                    }
                    
                    try {
                        // Sequential event queries for this chunk (no parallel processing)
                        const chunkPurchased = await contract.queryFilter(
                            contract.filters.NFTPurchased(),
                            start,
                            end
                        );
                        
                        const chunkCanceled = await contract.queryFilter(
                            contract.filters.ListingCanceled(),
                            start,
                            end
                        );
                        
                        // Cache this chunk as processed
                        setProcessedBlocksCache(prev => new Set([...prev, chunkKey]));
                        
                        debugLog(`✅ Chunk ${chunkKey}: ${chunkPurchased.length} purchases, ${chunkCanceled.length} cancellations`);
                        return { purchased: chunkPurchased, canceled: chunkCanceled };
                        
                    } catch (chunkError) {
                        debugWarn(`⚠️ Error in chunk ${chunkKey}:`, chunkError);
                        return { purchased: [], canceled: [] };
                    }
                };
                
                // Process single chunk
                const chunkResult = await chunkPromise();
                
                // Accumulate results from single chunk
                purchasedEvents = [...purchasedEvents, ...chunkResult.purchased];
                canceledEvents = [...canceledEvents, ...chunkResult.canceled];
                
                // Progressive update: show data as it's being fetched
                if (purchasedEvents.length > 0) {
                    setStatus(`📈 Found ${purchasedEvents.length} transactions so far... (batch ${batchNumber}/${totalBatches} complete)`);
                    
                    // Process and display partial results immediately
                    await processPartialSalesData(chunkResult.purchased);
                }
                
                // Conservative delay between chunks to reduce load
                if (i + MAX_CONCURRENT_CHUNKS < chunks.length) {
                    await new Promise(resolve => setTimeout(resolve, 500)); // Longer delay
                }
            }
            
            // Update last scanned block
            setLastScannedBlock(currentBlock);
            
            debugLog(`🎉 CONSERVATIVE SCAN COMPLETE:`);
            debugLog(`⚡ Found ${purchasedEvents.length} total purchase events using conservative scanning`);
            debugLog(`❌ Found ${canceledEvents.length} total canceled events`);
            debugLog(`🚀 Performance: Processed ${chunks.length} chunks conservatively to prevent data overload`);
            
            setStatus(`🎉 Conservative scan complete! Processing ${purchasedEvents.length} purchase events and ${canceledEvents.length} canceled events...`);
            
            // Process all events with enhanced performance
            const pastSales = [];
            debugLog(`🔄 Fast processing ${purchasedEvents.length} purchase events...`);
            
            // Batch process events for better performance
            const BATCH_SIZE = 20;
            for (let i = 0; i < purchasedEvents.length; i += BATCH_SIZE) {
                const batch = purchasedEvents.slice(i, i + BATCH_SIZE);
                setStatus(`📋 Processing transactions ${i + 1}-${Math.min(i + BATCH_SIZE, purchasedEvents.length)}/${purchasedEvents.length}...`);
                
                // Process batch events in parallel
                const batchPromises = batch.map(async (event, batchIndex) => {
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
                    } catch (eventError) {
                        debugWarn(`⚠️ Error processing purchase event ${i + batchIndex + 1}:`, eventError);
                        // Fallback data
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
                });
                
                const batchResults = await Promise.all(batchPromises);
                pastSales.push(...batchResults);
                
                // Progress feedback
                if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= purchasedEvents.length) {
                    debugLog(`📊 Processed ${Math.min(i + BATCH_SIZE, purchasedEvents.length)}/${purchasedEvents.length} transactions`);
                }
            }
            
            // Fast process canceled events
            debugLog(`🔄 Processing ${canceledEvents.length} canceled events...`);
            const pastCanceled = new Set();
            canceledEvents.forEach(event => {
                try {
                    pastCanceled.add(event.args.listingId.toString());
                } catch (eventError) {
                    debugWarn(`⚠️ Error processing canceled event:`, eventError);
                }
            });
            
            // Merge with existing data (avoid duplicates)
            setSalesHistory(prev => {
                const existingHashes = new Set(prev.map(sale => sale.transactionHash));
                const newSales = pastSales.filter(sale => !existingHashes.has(sale.transactionHash));
                const merged = [...prev, ...newSales].sort((a, b) => b.timestamp - a.timestamp);
                
                debugLog(`📊 OPTIMIZED SCAN RESULTS:`);
                debugLog(`💾 Previous sales: ${prev.length}`);
                debugLog(`🆕 New sales from blockchain: ${newSales.length}`);
                debugLog(`📈 Total sales history: ${merged.length} transactions`);
                debugLog(`⚡ Performance: Used parallel processing and smart caching`);
                
                return merged;
            });
            
            setCanceledListings(prev => {
                const merged = new Set([...prev, ...pastCanceled]);
                debugLog(`❌ Updated canceled listings: ${merged.size} total`);
                return merged;
            });
            
            // Enhanced success message with performance metrics
            const totalEventsFound = pastSales.length + pastCanceled.size;
            if (totalEventsFound > 0) {
                debugLog(`🎉 OPTIMIZED BLOCKCHAIN SCAN COMPLETE!`);
                debugLog(`📈 Total transactions found: ${pastSales.length}`);
                debugLog(`❌ Total cancellations found: ${pastCanceled.size}`);
                debugLog(`⚡ Performance improvement: Parallel chunk processing used`);
                
                setStatus(`✅ Optimized scan complete! Found ${pastSales.length} transactions and ${pastCanceled.size} cancellations using parallel processing.`);
                setTimeout(() => setStatus(""), 8000);
            } else {
                debugLog(`📋 Optimized scan complete - no transaction history found in smart contract`);
                setStatus("✅ Optimized scan complete - no historical transactions found. This could mean the marketplace is new or transactions happened on a different contract.");
                setTimeout(() => setStatus(""), 8000);
            }
            
        } catch (error) {
            criticalError("❌ Error in optimized blockchain scan:", error);
            setStatus(`❌ Error in optimized scan: ${error.message}. Check console for details.`);
            setTimeout(() => setStatus(""), 10000);
        }
    };

    // Helper function to process partial sales data for progressive loading
    const processPartialSalesData = async (newEvents) => {
        if (newEvents.length === 0) return;
        
        try {
            // Quick process new events and update state progressively
            const partialSales = await Promise.all(
                newEvents.map(async (event) => {
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
                    } catch (error) {
                        // Return minimal data on error
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
                })
            );
            
            // Update sales history progressively
            setSalesHistory(prev => {
                const existingHashes = new Set(prev.map(sale => sale.transactionHash));
                const newSales = partialSales.filter(sale => !existingHashes.has(sale.transactionHash));
                return [...prev, ...newSales].sort((a, b) => b.timestamp - a.timestamp);
            });
            
        } catch (error) {
            debugWarn("Error processing partial sales data:", error);
        }
    };

    // Set up event listeners for marketplace events
    const setupEventListeners = (contract) => {
        try {
            // Listen for purchases (sales)
            contract.on("NFTPurchased", async (listingId, buyer, quantity, totalPrice, paymentToken, event) => {
                debugLog("NFT Purchased event:", { listingId, buyer, quantity, totalPrice, paymentToken });
                
                try {
                    // Get block information for timestamp
                    const block = await event.getBlock();
                    
                    const saleData = {
                        listingId: listingId.toString(),
                        buyer,
                        quantity: quantity.toString(),
                        totalPrice: totalPrice.toString(),
                        paymentToken,
                        timestamp: block.timestamp * 1000, // Convert to milliseconds
                        type: 'sale',
                        blockNumber: event.blockNumber,
                        transactionHash: event.transactionHash
                    };
                    
                    setSalesHistory(prev => {
                        // Check if this transaction already exists
                        const exists = prev.some(sale => sale.transactionHash === saleData.transactionHash);
                        if (exists) {
                            debugLog("Sale event already recorded, skipping duplicate");
                            return prev;
                        }
                        
                        const updated = [saleData, ...prev].sort((a, b) => b.timestamp - a.timestamp);
                        debugLog("Added new sale to history:", saleData);
                        debugLog("Total sales history now:", updated.length, "transactions");
                        return updated;
                    });
                } catch (error) {
                    criticalError("Error processing NFTPurchased event:", error);
                    // Fallback without block info
                    const saleData = {
                        listingId: listingId.toString(),
                        buyer,
                        quantity: quantity.toString(),
                        totalPrice: totalPrice.toString(),
                        paymentToken,
                        timestamp: Date.now(),
                        type: 'sale'
                    };
                    
                    setSalesHistory(prev => [saleData, ...prev]);
                }
            });

            // Listen for canceled listings
            contract.on("ListingCanceled", (listingId) => {
                debugLog("Listing Canceled event:", { listingId });
                setCanceledListings(prev => new Set([...prev, listingId.toString()]));
            });

            // Listen for new listings
            contract.on("ListingCreated", (listingId, seller, nftContract, tokenId, quantity, pricePerUnit, paymentToken, isERC1155) => {
                debugLog("New listing created:", { listingId, seller, nftContract });
                // Refresh listings when new ones are created
                setTimeout(fetchListings, 2000);
            });

            debugLog("Event listeners set up successfully");
        } catch (error) {
            criticalError("Error setting up event listeners:", error);
        }
    };

    // Enhanced comprehensive marketplace statistics with detailed analytics
    // Memoized to prevent unnecessary recalculations
    const calculateMarketplaceStats = useCallback(async () => {
        if (!provider) return;

        try {
            // Test network connectivity
            try {
                await provider.getNetwork();
            } catch (networkError) {
                debugWarn("Network issue - calculating stats with fallback values");
                
                // Enhanced fallback calculations with more timeframes and analytics
                const now = Date.now();
                const hour = 60 * 60 * 1000;
                const day = 24 * hour;
                const week = 7 * day;
                const month = 30 * day;
                
                let totalNativeVolume = 0;
                // Enhanced timeframes
                let volume1h = 0, volume6h = 0, volume12h = 0;
                let volume24h = 0, volume7d = 0, volume30d = 0;
                let sales1h = 0, sales6h = 0, sales12h = 0;
                let sales24h = 0, sales7d = 0, sales30d = 0;
                
                // Price tracking for trends
                let priceSum = 0, priceCount = 0;
                let highestPrice = 0, lowestPrice = Infinity;
                const priceHistory = [];
                
                // Buyer and activity tracking
                const uniqueBuyers = new Set();
                const hourlyVolume = new Array(24).fill(0);
                const dailyVolume = new Array(30).fill(0);
                
                for (const sale of salesHistory) {
                    try {
                        const nativeValue = parseFloat(ethers.formatEther(sale.totalPrice));
                        totalNativeVolume += nativeValue;
                        priceSum += nativeValue;
                        priceCount++;
                        
                        // Track price extremes
                        if (nativeValue > highestPrice) highestPrice = nativeValue;
                        if (nativeValue < lowestPrice) lowestPrice = nativeValue;
                        
                        // Add to price history for trend analysis
                        priceHistory.push({
                            price: nativeValue,
                            timestamp: sale.timestamp
                        });
                        
                        // Track unique buyers
                        uniqueBuyers.add(sale.buyer);
                        
                        // Enhanced time-based calculations
                        const saleAge = now - sale.timestamp;
                        const saleHour = Math.floor(saleAge / hour);
                        const saleDay = Math.floor(saleAge / day);
                        
                        // Hourly distribution for last 24 hours
                        if (saleHour < 24) {
                            hourlyVolume[saleHour] += nativeValue;
                        }
                        
                        // Daily distribution for last 30 days
                        if (saleDay < 30) {
                            dailyVolume[saleDay] += nativeValue;
                        }
                        
                        // Multiple timeframe tracking
                        if (saleAge <= hour) {
                            volume1h += nativeValue;
                            sales1h++;
                        }
                        if (saleAge <= 6 * hour) {
                            volume6h += nativeValue;
                            sales6h++;
                        }
                        if (saleAge <= 12 * hour) {
                            volume12h += nativeValue;
                            sales12h++;
                        }
                        if (saleAge <= day) {
                            volume24h += nativeValue;
                            sales24h++;
                        }
                        if (saleAge <= week) {
                            volume7d += nativeValue;
                            sales7d++;
                        }
                        if (saleAge <= month) {
                            volume30d += nativeValue;
                            sales30d++;
                        }
                    } catch (error) {
                        debugWarn("Error parsing sale price:", error);
                    }
                }
                
                // Calculate listing volume in native tokens first
                let currentListingVolumeNative = 0;
                const activeListings = listings.filter(listing => 
                    listing.active && !canceledListings.has(listing.id.toString())
                );
                
                for (const listing of activeListings) {
                    try {
                        const nativeValue = parseFloat(ethers.formatEther(listing.pricePerUnit));
                        currentListingVolumeNative += nativeValue;
                    } catch (error) {
                        debugWarn("Error parsing listing price:", error);
                    }
                }

                // Advanced analytics calculations
                const avgPrice = priceCount > 0 ? priceSum / priceCount : 0;
                const marketCap = totalNativeVolume;
                const liquidityRatio = currentListingVolumeNative / (totalNativeVolume || 1);
                // Market velocity calculations
                const marketVelocity24h = volume7d > 0 ? (volume24h / (volume7d / 7)) : 0;
                const marketVelocity7d = volume30d > 0 ? (volume7d / (volume30d / 30)) : 0;
                
                // Growth rate calculations (comparing recent vs historical)
                const growthRate24h = volume7d > volume24h ? ((volume24h - (volume7d - volume24h) / 6) / ((volume7d - volume24h) / 6 || 1)) * 100 : 0;
                const growthRate7d = volume30d > volume7d ? ((volume7d - (volume30d - volume7d) / 3) / ((volume30d - volume7d) / 3 || 1)) * 100 : 0;
                
                // Market health score (0-100)
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
                    // Enhanced time-based metrics
                    volume1h, volume6h, volume12h,
                    volume24h, volume7d, volume30d,
                    volumeAllTime: totalNativeVolume,
                    sales1h, sales6h, sales12h,
                    sales24h, sales7d, sales30d,
                    // Advanced analytics
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
            
            // Enhanced USDC calculation with comprehensive analytics
            const now = Date.now();
            const hour = 60 * 60 * 1000;
            const day = 24 * hour;
            const week = 7 * day;
            const month = 30 * day;
            
            let actualSoldVolumeUSDC = 0;
            // Enhanced timeframes
            let volume1hUSDC = 0, volume6hUSDC = 0, volume12hUSDC = 0;
            let volume24hUSDC = 0, volume7dUSDC = 0, volume30dUSDC = 0;
            let sales1h = 0, sales6h = 0, sales12h = 0;
            let sales24h = 0, sales7d = 0, sales30d = 0;
            
            // Advanced analytics tracking
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
                    priceSum += usdcValue;
                    priceCount++;
                    
                    // Track price extremes
                    if (usdcValue > highestPrice) highestPrice = usdcValue;
                    if (usdcValue < lowestPrice) lowestPrice = usdcValue;
                    
                    // Add to price history for trend analysis
                    priceHistory.push({
                        price: usdcValue,
                        timestamp: sale.timestamp
                    });
                    
                    // Track unique buyers
                    uniqueBuyers.add(sale.buyer);
                    
                    // Enhanced time-based volume calculations
                    const saleAge = now - sale.timestamp;
                    const saleHour = Math.floor(saleAge / hour);
                    const saleDay = Math.floor(saleAge / day);
                    
                    // Hourly distribution for last 24 hours
                    if (saleHour < 24) {
                        hourlyVolume[saleHour] += usdcValue;
                    }
                    
                    // Daily distribution for last 30 days
                    if (saleDay < 30) {
                        dailyVolume[saleDay] += usdcValue;
                    }
                    
                    // Multiple timeframe tracking
                    if (saleAge <= hour) {
                        volume1hUSDC += usdcValue;
                        sales1h++;
                    }
                    if (saleAge <= 6 * hour) {
                        volume6hUSDC += usdcValue;
                        sales6h++;
                    }
                    if (saleAge <= 12 * hour) {
                        volume12hUSDC += usdcValue;
                        sales12h++;
                    }
                    if (saleAge <= day) {
                        volume24hUSDC += usdcValue;
                        sales24h++;
                    }
                    if (saleAge <= week) {
                        volume7dUSDC += usdcValue;
                        sales7d++;
                    }
                    if (saleAge <= month) {
                        volume30dUSDC += usdcValue;
                        sales30d++;
                    }
                    
                    // Track top tokens
                    const tokenKey = sale.paymentToken || 'VTRU';
                    if (!topTokensMap[tokenKey]) {
                        topTokensMap[tokenKey] = { volume: 0, sales: 0, token: tokenKey };
                    }
                    topTokensMap[tokenKey].volume += usdcValue;
                    topTokensMap[tokenKey].sales += 1;
                } catch (error) {
                    debugWarn("Error calculating sale value:", error);
                }
            }

            // Calculate current listing volume (excluding canceled listings)
            let currentListingVolumeUSDC = 0;
            const activeListings = listings.filter(listing => 
                listing.active && !canceledListings.has(listing.id.toString())
            );
            
            for (const listing of activeListings) {
                try {
                    const usdcValue = await convertToUSDCValue(listing.pricePerUnit, listing.paymentToken, provider);
                    currentListingVolumeUSDC += usdcValue;
                    
                    // Track seller stats
                    if (!sellerStatsMap[listing.seller]) {
                        sellerStatsMap[listing.seller] = { address: listing.seller, listingsCount: 0, totalVolume: 0 };
                    }
                    sellerStatsMap[listing.seller].listingsCount += 1;
                    sellerStatsMap[listing.seller].totalVolume += usdcValue;
                } catch (error) {
                    debugWarn("Error calculating listing value:", error);
                }
            }

            // Process transaction history
            const transactionHistory = salesHistory.map(sale => ({
                ...sale,
                formattedTimestamp: new Date(sale.timestamp).toLocaleString()
            })).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50); // Last 50 transactions

            // Get top tokens sorted by volume
            const topTokens = Object.values(topTokensMap)
                .sort((a, b) => b.volume - a.volume)
                .slice(0, 10);

            // Get most active sellers
            const mostActiveSellers = Object.values(sellerStatsMap)
                .sort((a, b) => b.listingsCount - a.listingsCount)
                .slice(0, 10);

            // Advanced analytics calculations
            const avgPrice = priceCount > 0 ? priceSum / priceCount : 0;
            const marketCap = actualSoldVolumeUSDC;
            const liquidityRatio = currentListingVolumeUSDC / (actualSoldVolumeUSDC || 1);
            
            // Market velocity calculations (how much faster current activity is vs average)
            const marketVelocity24h = volume7dUSDC > 0 ? (volume24hUSDC / (volume7dUSDC / 7)) : 0;
            const marketVelocity7d = volume30dUSDC > 0 ? (volume7dUSDC / (volume30dUSDC / 30)) : 0;
            
            // Growth rate calculations
            const growthRate24h = volume7dUSDC > volume24hUSDC ? ((volume24hUSDC - (volume7dUSDC - volume24hUSDC) / 6) / ((volume7dUSDC - volume24hUSDC) / 6 || 1)) * 100 : 0;
            const growthRate7d = volume30dUSDC > volume7dUSDC ? ((volume7dUSDC - (volume30dUSDC - volume7dUSDC) / 3) / ((volume30dUSDC - volume7dUSDC) / 3 || 1)) * 100 : 0;
            
            // Market health score (0-100 composite score)
            const volumeScore = Math.min((volume24hUSDC / Math.max(volume7dUSDC / 7, 0.01)) * 25, 25);
            const activityScore = Math.min((sales24h / Math.max(sales7d / 7, 0.01)) * 25, 25);
            const liquidityScore = Math.min(liquidityRatio * 25, 25);
            const diversityScore = Math.min(uniqueBuyers.size * 5, 25);
            const marketHealthScore = volumeScore + activityScore + liquidityScore + diversityScore;
            
            // Turnover rate (how quickly inventory moves)
            const turnoverRate = actualSoldVolumeUSDC > 0 ? (volume30dUSDC / actualSoldVolumeUSDC) * 100 : 0;

            setMarketplaceStats({
                totalSales: salesHistory.length,
                actualSoldVolume: actualSoldVolumeUSDC,
                currentListingVolume: currentListingVolumeUSDC,
                // Enhanced time-based volume metrics
                volume1h: volume1hUSDC,
                volume6h: volume6hUSDC,
                volume12h: volume12hUSDC,
                volume24h: volume24hUSDC,
                volume7d: volume7dUSDC,
                volume30d: volume30dUSDC,
                volumeAllTime: actualSoldVolumeUSDC,
                // Enhanced sales count metrics
                sales1h,
                sales6h,
                sales12h,
                sales24h,
                sales7d,
                sales30d,
                // Advanced analytics
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
    }, [salesHistory, listings, canceledListings, provider]); // Dependencies for useCallback

    // Recalculate stats when data changes - audit dependencies to ensure all inputs are covered
    useEffect(() => {
        calculateMarketplaceStats();
    }, [calculateMarketplaceStats]); // Use the memoized function as dependency

    // Track last cache update time to prevent excessive calls
    const lastCacheUpdateRef = useRef(0);
    const CACHE_UPDATE_COOLDOWN = 30000; // 30 seconds minimum between cache updates
    
    const fetchListings = async (forceRefresh = false) => {
        // Prevent concurrent fetches to avoid race conditions
        if (isLoading) {
            debugLog("Fetch already in progress, skipping concurrent request");
            return;
        }
        
        setIsLoading(true);
        setStatus('Loading listings...');
        debugLog(`fetchListings called with forceRefresh=${forceRefresh}, supabaseConnected=${supabaseConnected}`);
        
        try {
            // Load from Supabase cache (updated by cron job)
            if (supabaseConnected && getCachedListings) {
                debugLog("🚀 Loading listings from cache...");
                setStatus('Loading cached listings...');
                
                const cachedListings = await getCachedListings();
                
                if (cachedListings && cachedListings.length > 0) {
                    debugLog(`✅ Loaded ${cachedListings.length} cached listings`);
                    
                    // Apply V-Share metadata normalization to cached listings
                    const processedListings = cachedListings.map(listing => {
                        if (listing?.nftContract && listing?.tokenId) {
                            // Apply metadata normalization (handles V-Share detection)
                            const normalizedMetadata = normalizeNFTMetadata(
                                listing.metadata, 
                                listing.nftContract, 
                                listing.tokenId
                            );
                            
                            // Update listing with normalized metadata
                            return {
                                ...listing,
                                metadata: normalizedMetadata,
                                // Ensure image fields are properly set for V-Share NFTs
                                image: normalizedMetadata.image || listing.image,
                                imageUrl: normalizedMetadata.imageUrl || listing.imageUrl || normalizedMetadata.image,
                                name: normalizedMetadata.name || listing.name,
                                description: normalizedMetadata.description || listing.description
                            };
                        }
                        return listing;
                    });
                    
                    setListings(processedListings);
                    setHotListings(processedListings.slice(0, 5));
                    setStatus(`${processedListings.length} listings loaded (updated by background sync)`);
                    
                    // Clear status after 3 seconds
                    setTimeout(() => setStatus(''), 3000);
                } else {
                    debugLog("⚠️ No cached listings found");
                    setListings([]);
                    setHotListings([]);
                    setStatus('No listings available - sync may be in progress');
                }
                
                // If forceRefresh is requested, trigger manual sync
                if (forceRefresh) {
                    await triggerManualSync();
                }
                
            } else {
                debugWarn("Supabase not connected - loading demo listings");
                setStatus('Loading demo listings (Supabase not configured)');
                
                // Provide demo listings when cache is unavailable
                const demoListings = [
                    {
                        id: 1,
                        seller: '0x742d35Cc6464B4C4F3196f2Ac1bE7C0A90f22C8f',
                        nftContract: '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906',
                        tokenId: '1',
                        quantity: '1',
                        pricePerUnit: '1000000000000000000', // 1 VTRU
                        paymentToken: '0x0000000000000000000000000000000000000000',
                        isERC1155: false,
                        active: true,
                        metadata: {
                            name: 'Demo Pixel Art #1',
                            description: 'A beautiful pixel art NFT for demonstration purposes',
                            image: 'ipfs://QmSHzd8MmLcsG8x4yYb4k3dRP6BawJmShmKgxDcvNRtB4i',
                            attributes: [
                                { trait_type: 'Color', value: 'Blue' },
                                { trait_type: 'Style', value: 'Pixel' },
                                { trait_type: 'Rarity', value: 'Common' }
                            ]
                        },
                        image: 'ipfs://QmSHzd8MmLcsG8x4yYb4k3dRP6BawJmShmKgxDcvNRtB4i',
                        imageUrl: 'ipfs://QmSHzd8MmLcsG8x4yYb4k3dRP6BawJmShmKgxDcvNRtB4i',
                        name: 'Demo Pixel Art #1',
                        title: 'Demo Pixel Art #1',
                        description: 'A beautiful pixel art NFT for demonstration purposes'
                    },
                    {
                        id: 2,
                        seller: '0x742d35Cc6464B4C4F3196f2Ac1bE7C0A90f22C8f',
                        nftContract: '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906',
                        tokenId: '2',
                        quantity: '1',
                        pricePerUnit: '2500000000000000000', // 2.5 VTRU
                        paymentToken: '0x0000000000000000000000000000000000000000',
                        isERC1155: false,
                        active: true,
                        metadata: {
                            name: 'Demo Digital Art #2',
                            description: 'A vibrant digital artwork showcasing modern NFT aesthetics',
                            image: 'ipfs://QmYHH5k4g1ZqDBsxKz8ZhEQqJXBhFXuUb3Fh4q4YJXXp4',
                            attributes: [
                                { trait_type: 'Color', value: 'Purple' },
                                { trait_type: 'Style', value: 'Digital' },
                                { trait_type: 'Rarity', value: 'Rare' }
                            ]
                        },
                        image: 'ipfs://QmYHH5k4g1ZqDBsxKz8ZhEQqJXBhFXuUb3Fh4q4YJXXp4',
                        imageUrl: 'ipfs://QmYHH5k4g1ZqDBsxKz8ZhEQqJXBhFXuUb3Fh4q4YJXXp4',
                        name: 'Demo Digital Art #2',
                        title: 'Demo Digital Art #2',
                        description: 'A vibrant digital artwork showcasing modern NFT aesthetics'
                    },
                    {
                        id: 3,
                        seller: '0x1234567890123456789012345678901234567890',
                        nftContract: '0xc5d518d131738481947cFa4670F94eb7b948a1ac', // V-Share contract
                        tokenId: '1',
                        quantity: '1',
                        pricePerUnit: '5000000000000000000', // 5 VTRU
                        paymentToken: '0x0000000000000000000000000000000000000000',
                        isERC1155: false,
                        active: true,
                        // Remove hardcoded metadata to allow V-Share normalization to work
                        name: 'V-Share Revenue Pool #1',
                        title: 'V-Share Revenue Pool #1',
                        description: 'A revenue sharing NFT that provides returns from marketplace fees'
                    }
                ];
                
                // Apply V-Share metadata normalization to demo listings
                const processedDemoListings = demoListings.map(listing => {
                    if (listing?.nftContract && listing?.tokenId) {
                        // Apply metadata normalization (handles V-Share detection)
                        const normalizedMetadata = normalizeNFTMetadata(
                            listing.metadata, 
                            listing.nftContract, 
                            listing.tokenId
                        );
                        
                        // Update listing with normalized metadata  
                        return {
                            ...listing,
                            metadata: normalizedMetadata,
                            // Ensure image fields are properly set for V-Share NFTs
                            image: normalizedMetadata.image || listing.image,
                            imageUrl: normalizedMetadata.imageUrl || listing.imageUrl || normalizedMetadata.image,
                            name: normalizedMetadata.name || listing.name,
                            description: normalizedMetadata.description || listing.description
                        };
                    }
                    return listing;
                });
                
                setListings(processedDemoListings);
                setHotListings(processedDemoListings.slice(0, 2));
                
                // Clear status after 3 seconds
                setTimeout(() => setStatus(''), 3000);
            }
            
        } catch (error) {
            criticalError("Error loading cached listings:", error);
            setStatus('Failed to load listings from cache');
            setListings([]);
            setHotListings([]);
        } finally {
            setIsLoading(false);
        }
    };

    // Trigger manual sync via API endpoint (optional - for manual refresh)
    const triggerManualSync = async () => {
        try {
            debugLog("🔄 Triggering manual listings sync...");
            setStatus('Requesting fresh data sync...');
            
            const response = await fetch('/api/sync-listings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`Sync failed: ${response.status}`);
            }
            
            const result = await response.json();
            debugLog("✅ Manual sync completed:", result);
            
            setStatus(`Sync completed: ${result.stats?.found || 0} listings found, ${result.stats?.cached || 0} cached`);
            
            // Refresh the listings after sync
            setTimeout(async () => {
                await fetchListings(false); // Reload from cache
                setStatus('');
            }, 2000);
            
        } catch (error) {
            debugWarn("Manual sync failed:", error.message);
            setStatus(`Sync failed: ${error.message}`);
            setTimeout(() => setStatus(''), 5000);
        }
    };

    // Add this ERC20 ABI at the top with your other imports
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
];

// ERC721 ABI for approval operations
const ERC721_APPROVAL_ABI = [
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function getApproved(uint256 tokenId) view returns (address)',
    'function setApprovalForAll(address operator, bool approved)'
];

// ERC1155 ABI for approval operations  
const ERC1155_APPROVAL_ABI = [
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)'
];

    // Replace the current buyListing with this version
// ===== Buffer-aware ERC20 allowance helper (handles USDT-style 0->new) =====
async function ensureAllowanceWithBuffer({
  tokenAddress,
  owner,
  spender,
  needed,             // BigInt in token units
  signer,
  setStatus,
  bufferBps = 1000n,  // 10% buffer; e.g. 500n = 5%
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

  // Prefer Max approval for smoother future buys
  try {
    await ask(ethers.MaxUint256, 'max');
    return { symbol, approved: true, allowance: ethers.MaxUint256, neededWithBuffer };
  } catch (e1) {
    const m = (e1?.reason || e1?.message || '').toLowerCase();

    // USDT-style tokens require 0 -> new
    if (m.includes('allowance') || m.includes('must be zero') || m.includes('non-zero')) {
      try {
        await ask(0, 'reset to 0');
        await ask(ethers.MaxUint256, 'max');
        return { symbol, approved: true, allowance: ethers.MaxUint256, neededWithBuffer };
      } catch (e2) {
        // Fallback: exact buffered amount
        try {
          await ask(neededWithBuffer, `exact ${symbol}`);
          return { symbol, approved: true, allowance: neededWithBuffer, neededWithBuffer };
        } catch (e3) {
          throw new Error(`Failed to approve ${symbol}: ${e3?.message || e3}`);
        }
      }
    }

    // Different failure → exact buffered amount
    try {
      await ask(neededWithBuffer, `exact ${symbol}`);
      return { symbol, approved: true, allowance: neededWithBuffer, neededWithBuffer };
    } catch (e4) {
      throw new Error(`Failed to approve ${symbol}: ${e4?.message || e4}`);
    }
  }
}


// ===== buyListing with enhanced error handling and gas estimation =====
const buyListing = async (id, _uiPricePerUnit, _uiPaymentToken, quantity = 1) => {
  if (!signer) { setStatus('Error: Wallet not connected. Please connect your wallet first'); return; }
  if (!marketplace) { setStatus('Error: Marketplace contract not initialized'); return; }

  try {
    console.log("[BUY DEBUG] Starting buy process...");
    console.log("[BUY DEBUG] Marketplace contract address:", marketplaceAddress);
    console.log("Marketplace contract:", marketplaceAddress);
    console.log("Contract instance:", marketplace);
    console.log("Available methods:", Object.getOwnPropertyNames(marketplace).filter(name => 
        typeof marketplace[name] === 'function' && !name.startsWith('_')));

    setStatus('Checking listing details...');

    // Get listing details
    console.log("[BUY DEBUG] Fetching listing details...");
    const l = await marketplace.listings(id);
    console.log("Listing details:", l);
    
    if (!l || !l.active) { 
      setStatus('Error: Listing is inactive or does not exist'); 
      return; 
    }

    // Validate quantity and pricing
    const is1155 = !!l.isERC1155;
    const listed = BigInt(l.quantity?.toString?.() ?? String(l.quantity ?? '0'));
    const qty = BigInt(String(quantity || 1));

    if (!is1155 && qty !== 1n) { setStatus('Error: ERC-721 quantity must be 1'); return; }
    if (is1155 && (qty <= 0n || qty > listed)) { setStatus('Error: Requested quantity exceeds available'); return; }

    const unit = BigInt(l.pricePerUnit?.toString?.() ?? String(l.pricePerUnit ?? '0'));
    const listingTotal = unit * qty;
    
    // Fetch platform fee from contract - simplified for new contract structure
    console.log("[BUY DEBUG] Fetching platform fee...");
    let platformFeeBps = 0n;
    try {
      const feeResult = await marketplace.platformFeeBps();
      platformFeeBps = BigInt(feeResult.toString());
      console.log("Platform fee (basis points):", platformFeeBps.toString());
    } catch (feeError) {
      console.warn("Could not fetch platform fee, using 0:", feeError.message);
    }

    // Calculate platform fee - new contract handles vibe distribution internally
    const platformFeeTotal = (listingTotal * platformFeeBps) / 10000n;
    
    // Check if there are creator royalties by querying the NFT contract
    let royaltyAmount = 0n;
    try {
      // Try to get royalty info from the NFT contract (ERC2981)
      const nftContract = new ethers.Contract(
        l.nftContract, 
        ['function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address, uint256)'], 
        provider
      );
      const [royaltyReceiver, royaltyFee] = await nftContract.royaltyInfo(l.tokenId, listingTotal);
      if (royaltyReceiver !== ethers.ZeroAddress && royaltyFee > 0) {
        royaltyAmount = BigInt(royaltyFee.toString());
        console.log("Creator royalty:", ethers.formatEther(royaltyAmount), "VTRU to", royaltyReceiver);
      }
    } catch (royaltyError) {
      console.log("No royalty info available or NFT doesn't support ERC2981:", royaltyError.message);
    }
    
    // Total transaction value includes listing price + platform fees + royalties
    // New contract handles vibe conversion internally - no separate fee processor
    let totalWithFees = listingTotal + platformFeeTotal + royaltyAmount;
    
    console.log("[SIMPLIFIED FEE BREAKDOWN]");
    console.log("Listing price:", ethers.formatEther(listingTotal), "VTRU");
    console.log("Platform fee:", ethers.formatEther(platformFeeTotal), "VTRU (contract handles vibe distribution)");
    console.log("Creator royalty:", ethers.formatEther(royaltyAmount), "VTRU");
    console.log("Total transaction value:", ethers.formatEther(totalWithFees), "VTRU");
    
    const token = l.paymentToken;
    const isNative = !token || String(token).toLowerCase() === ethers.ZeroAddress.toLowerCase();
    
    console.log('Buy Details:', {
      listingId: id,
      pricePerUnit: ethers.formatEther(unit),
      totalPrice: ethers.formatEther(totalWithFees),
      paymentToken: token,
      isNative,
      quantity: qty.toString()
    });

    // Check wallet balance
    const walletBal = await provider.getBalance(wallet);
    console.log(`Wallet Native Balance: ${ethers.formatEther(walletBal)} VTRU`);
    
    if (isNative && walletBal < totalWithFees) {
      setStatus(`Error: Insufficient balance. Need ${ethers.formatEther(totalWithFees)} VTRU, have ${ethers.formatEther(walletBal)} VTRU`);
      return;
    }

    setStatus(`Preparing transaction for ${ethers.formatEther(totalWithFees)} VTRU...`);
    
    // Ensure connected contract
    const connectedContract = marketplace.connect(signer);
    
    if (isNative) {
      // For native token purchases, estimate gas first
      console.log("Estimating gas for native token purchase...");
      let gasEstimate;
      try {
        gasEstimate = await connectedContract.buy.estimateGas(id, qty, { value: totalWithFees });
        console.log("Gas estimate:", gasEstimate.toString());
      } catch (gasError) {
        console.warn("Gas estimation failed with full amount:", gasError.message);
        
        // Try with just the listing price (maybe contract calculates fees internally)
        try {
          gasEstimate = await connectedContract.buy.estimateGas(id, qty, { value: listingTotal });
          console.log("Gas estimate with listing price only:", gasEstimate.toString());
          console.log("Using listing price only - contract may calculate fees internally");
          totalWithFees = listingTotal; // Update the total to use
        } catch (gasError2) {
          console.warn("Gas estimation failed with listing price only:", gasError2.message);
          gasEstimate = 500000n; // Fallback gas limit
        }
      }
      
      // Add 20% buffer to gas estimate
      const gasLimit = (gasEstimate * 120n) / 100n;
      console.log(`Sending buy tx with ${ethers.formatEther(totalWithFees)} VTRU as value, gas limit ${gasLimit}`);
      
      try {
        const tx = await connectedContract.buy(id, qty, { 
          value: totalWithFees,
          gasLimit
        });
        setStatus('Transaction submitted. Waiting for confirmation...');
        console.log("Transaction hash:", tx.hash);
        
        const receipt = await tx.wait();
        console.log("Transaction confirmed:", receipt);
        
        if (receipt.status === 0) {
          throw new Error("Transaction failed during execution");
        }
        
        // Mark the listing as inactive
        markListingInactive(id);

        setStatus('Purchase successful! Refreshing listings...');
        
        // Refresh listings after successful purchase
        setTimeout(() => {
          if (supabaseConnected && cacheListings) {
            fetchListings(true);
          } else {
            fetchListings();
          }
        }, 1000);

        setTimeout(() => {
          setStatus('Purchase completed successfully!');
          setTimeout(() => setStatus(''), 3000);
        }, 1500);
        
      } catch (callError) {
        console.error("Buy transaction failed:", callError);
        
        // Enhanced error handling for new contract
        if (callError.reason) {
          setStatus(`Transaction failed: ${callError.reason}`);
        } else if (callError.message?.includes('amount unused')) {
          setStatus('Error: Amount unused - the contract calculated fees differently than expected');
        } else if (callError.message?.includes('insufficient funds')) {
          setStatus('Error: Insufficient funds for transaction + gas');
        } else if (callError.message?.includes('user rejected')) {
          setStatus('Transaction was rejected in your wallet');
        } else {
          setStatus(`Transaction failed: ${callError.message || 'Unknown error'}`);
        }
        return;
      }
    } else {
      // ERC20 token path
      console.log("Processing ERC20 token purchase...");
      
      // Check ERC20 token balance
      const erc20Contract = new ethers.Contract(token, ERC20_ABI, provider);
      const tokenBalance = await erc20Contract.balanceOf(wallet);
      console.log(`ERC20 Token Balance: ${ethers.formatUnits(tokenBalance, await erc20Contract.decimals())} ${await erc20Contract.symbol()}`);
      
      if (BigInt(tokenBalance.toString()) < totalWithFees) {
        const tokenSymbol = await erc20Contract.symbol();
        const tokenDecimals = await erc20Contract.decimals();
        setStatus(`Error: Insufficient ${tokenSymbol} balance. Need ${ethers.formatUnits(totalWithFees, tokenDecimals)} ${tokenSymbol}, have ${ethers.formatUnits(tokenBalance, tokenDecimals)} ${tokenSymbol}`);
        return;
      }
      
      // Ensure marketplace contract has approval to spend user's ERC20 tokens
      console.log("Checking/ensuring ERC20 approval...");
      setStatus('Checking token approval...');
      
      try {
        await ensureAllowanceWithBuffer({
          tokenAddress: token,
          owner: wallet,
          spender: marketplaceAddress,
          needed: totalWithFees,
          signer,
          setStatus,
          bufferBps: 1000n // 10% buffer for future transactions
        });
        console.log("ERC20 approval confirmed");
      } catch (approvalError) {
        console.error("ERC20 approval failed:", approvalError);
        setStatus(`Error: Failed to approve token spending: ${approvalError.message}`);
        return;
      }
      
      // Estimate gas for ERC20 purchase
      console.log("Estimating gas for ERC20 token purchase...");
      let gasEstimate;
      try {
        gasEstimate = await connectedContract.buy.estimateGas(id, qty);
        console.log("Gas estimate:", gasEstimate.toString());
      } catch (gasError) {
        console.warn("Gas estimation failed:", gasError.message);
        gasEstimate = 500000n; // Fallback gas limit
      }
      
      // Add 20% buffer to gas estimate
      const gasLimit = (gasEstimate * 120n) / 100n;
      console.log(`Executing ERC20 buy transaction with gas limit ${gasLimit}`);
      
      setStatus('Submitting ERC20 purchase transaction...');
      const tx = await connectedContract.buy(id, qty, { gasLimit });
      setStatus('Transaction submitted. Waiting for confirmation...');
      console.log("Transaction hash:", tx.hash);
      
      const receipt = await tx.wait();
      console.log("Transaction confirmed:", receipt);
      
      if (receipt.status === 0) {
        throw new Error("Transaction failed during execution");
      }
      
      // Mark the listing as inactive
      markListingInactive(id);

      setStatus('Purchase successful! Refreshing listings...');
      
      // Refresh listings after successful purchase
      setTimeout(() => {
        if (supabaseConnected && cacheListings) {
          fetchListings(true);
        } else {
          fetchListings();
        }
      }, 1000);

      setTimeout(() => {
        setStatus('Purchase completed successfully!');
        setTimeout(() => setStatus(''), 3000);
      }, 1500);
    }

  } catch (e) {
    criticalError('[BUY] Error in buyListing:', e);
    console.error('[BUY] Full error details:', e);
    
    const errorMessage = e?.message || e?.reason || String(e);
    console.error("Error message:", errorMessage);
    
    if (errorMessage.includes('user rejected')) {
      setStatus('Transaction was rejected in your wallet');
    } else if (errorMessage.includes('insufficient funds')) {
      setStatus('Error: Insufficient funds for gas + payment');
    } else if (errorMessage.includes('amount unused')) {
      setStatus('Error: New marketplace contract fee calculation - trying different amount');
    } else if (errorMessage.includes('execution reverted')) {
      setStatus('Error: Transaction reverted - new contract validation failed');
    } else {
      setStatus(`Purchase failed: ${errorMessage.substring(0, 100)}...`);
    }
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

            // Check if this is an ERC721 or ERC1155
            let isERC1155 = false;
            try {
                // Try to detect if it's ERC1155 by calling balanceOf with tokenId parameter
                const testContract = new ethers.Contract(
                    nftContract,
                    ['function balanceOf(address, uint256) view returns (uint256)'],
                    provider
                );
                await testContract.balanceOf(wallet, tokenId);
                isERC1155 = true;
                debugLog(`Detected ${nftContract} as ERC1155`);
            } catch (e) {
                // If that fails, assume it's ERC721
                debugLog(`Detected ${nftContract} as ERC721`);
                isERC1155 = false;
            }

            // Check and request NFT approval
            if (isERC1155) {
                // Handle ERC1155 approval
                const nftContract1155 = new ethers.Contract(nftContract, ERC1155_APPROVAL_ABI, signer);

                // Check if already approved
                const isApproved = await nftContract1155.isApprovedForAll(wallet, marketplaceAddress);

                if (!isApproved) {
                    setStatus("Requesting approval to sell your NFTs...");
                    debugLog("Requesting ERC1155 approval for marketplace");

                    const approvalTx = await nftContract1155.setApprovalForAll(marketplaceAddress, true);

                    setStatus("Approval transaction submitted. Please wait for confirmation...");
                    await approvalTx.wait();
                    setStatus("Approval confirmed! Creating listing...");
                }
            } else {
                // Handle ERC721 approval
                const nftContract721 = new ethers.Contract(nftContract, ERC721_APPROVAL_ABI, signer);

                // Check if already approved for all tokens
                const isApprovedForAll = await nftContract721.isApprovedForAll(wallet, marketplaceAddress);

                if (!isApprovedForAll) {
                    // Check individual token approval
                    const approvedAddress = await nftContract721.getApproved(tokenId);
                    const isTokenApproved = approvedAddress.toLowerCase() === marketplaceAddress.toLowerCase();

                    if (!isTokenApproved) {
                        setStatus("Requesting approval to sell your NFT...");
                        debugLog("Requesting ERC721 approval for marketplace");

                        // Use setApprovalForAll for convenience (approves all tokens)
                        const approvalTx = await nftContract721.setApprovalForAll(marketplaceAddress, true);

                        setStatus("Approval transaction submitted. Please wait for confirmation...");
                        await approvalTx.wait();
                        setStatus("Approval confirmed! Creating listing...");
                    }
                }
            }

            // Now proceed with creating the listing
            setStatus("Creating listing...");

            // Make sure we're using the contract with the signer
            const marketplaceWithSigner = marketplace.connect(signer);

            debugLog("Sending create listing transaction...");
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

            // Invalidate cache and refresh listings
            if (supabaseConnected && cacheListings) {
                debugLog("💾 Invalidating cache due to new listing...");
                // Force refresh from blockchain to get latest state
                await fetchListings(true);
            } else {
                // Refresh listings normally
                fetchListings();
            }

        } catch (error) {
            criticalError("Error in createListing:", error);

            // Better error handling
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

    // Add helper near the top (below imports)
function hasAbiFn(abi, name) {
    try { return Array.isArray(abi) && abi.some(e => e?.type === 'function' && e?.name === name); }
    catch { return false; }
}

// Load a working ABI that contains `buy` if the incoming one does not
async function resolveMarketplaceAbi(incomingAbi) {
    if (hasAbiFn(incomingAbi, 'buy')) return incomingAbi;

    try {
        const A = await import('../abi/VTRUNFTMarketplace.json');
        const abiA = A.default?.abi || A.abi;
        if (hasAbiFn(abiA, 'buy')) return abiA;
    } catch {}

    try {
        const B = await import('../abi/Marketplace.json');
        const abiB = B.default?.abi || B.abi;
        if (hasAbiFn(abiB, 'buy')) return abiB;
    } catch {}

    throw new Error('No ABI with buy() found. Ensure VTRUNFTMarketplace ABI is provided.');
}

    // Add this function to MarketplaceContext.jsx after the buyListing function
const markListingInactive = useCallback((listingId) => {
  if (!listingId) return;
  
  debugLog(`Marking listing ${listingId} as inactive after purchase`);
  
  // Update listing in the listings array
  setListings(prevListings => 
    prevListings.map(listing => 
      listing.id === listingId ? { ...listing, active: false } : listing
    )
  );
  
  // Add to canceledListings set
  setCanceledListings(prevCanceled => {
    const newCanceled = new Set(prevCanceled);
    newCanceled.add(String(listingId));
    return newCanceled;
  });
}, []);

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
            markListingInactive, // Add this new function
            // New marketplace statistics and data
            salesHistory,
            canceledListings,
            marketplaceStats,
            calculateMarketplaceStats,
            // Add function to manually trigger sync via API
            triggerManualSync
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
  if (!signer) return false;
  
  try {
    const token = new ethers.Contract(tokenAddress, [
      'function symbol() view returns (string)',
      'function approve(address,uint256) returns (bool)'
    ], signer);
    
    const symbol = await token.symbol().catch(() => 'TOKEN');
    setStatus(`Resetting ${symbol} allowance to zero...`);
    
    // First set to zero
    const tx1 = await token.approve(spender, 0);
    await tx1.wait();
    
    // Then approve max
    setStatus(`Approving ${symbol} for trading...`);
    const tx2 = await token.approve(spender, ethers.MaxUint256);
    await tx2.wait();
    
    setStatus(`${symbol} approved successfully!`);
    return true;
  } catch (error) {
    setStatus(`Failed to reset token allowance: ${error.message}`);
    return false;
  }
}

// Add this reset button to the UI for marketplace page
// And modify buyListing to use this reset function when allowance errors occur