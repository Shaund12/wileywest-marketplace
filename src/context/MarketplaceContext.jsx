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
                
                // Supabase caching disabled to prevent mass data collection
                debugLog("Auto-caching to Supabase DISABLED to prevent mass data collection");
                debugLog(`${salesHistory.length} sales in memory - Supabase auto-cache disabled`);
                
            } catch (error) {
                criticalError("Error persisting sales history:", error);
            }
        }
    }, [salesHistory]); // Removed supabaseConnected from dependencies as noted in original

    // Persist canceled listings to localStorage whenever they change
    useEffect(() => {
        if (canceledListings.size > 0) {
            try {
                const canceledArray = Array.from(canceledListings);
                localStorage.setItem('marketplace_canceled_listings', JSON.stringify(canceledArray));
            } catch (error) {
                console.error("Error persisting canceled listings:", error);
            }
        }
    }, [canceledListings]);

    // Initialize marketplace contract
    useEffect(() => {
        const initializeMarketplace = async () => {
            if (marketplaceAddress && provider) {
                try {
                    console.log("Initializing marketplace contract...");
                    const contract = new ethers.Contract(marketplaceAddress, abi, provider);
                    setMarketplace(contract);
                    setIsInitialized(true);
                    console.log("Marketplace contract initialized successfully");
                    
                    // Test network connectivity before setting up events
                    try {
                        await provider.getNetwork();
                        // DISABLED: Automatic past events fetch to prevent mass data collection
                        console.log("⚠️ Automatic blockchain scanning DISABLED to prevent mass data collection");
                        console.log("💡 Users can manually refresh blockchain data if needed");
                        
                        // Don't automatically fetch past sales events - only set up event listeners
                        // setupEventListeners(contract); - Also disabled to prevent any automatic data collection
                        
                        console.log("💡 Event listeners and blockchain scanning DISABLED - manual refresh only");
                    } catch (networkError) {
                        console.warn("Network connectivity issue - event listeners not set up:", networkError.message);
                        setStatus("Network connectivity issue - running in offline mode. Sales tracking unavailable.");
                    }
                } catch (error) {
                    console.error("Error initializing marketplace contract:", error);
                    setStatus("Failed to initialize marketplace contract");
                }
            }
        };

        initializeMarketplace();
    }, [marketplaceAddress, abi, provider]);

    // Disabled aggressive real-time subscriptions and background scanning to prevent mass data collection
    // TODO: Re-implement with user-controlled refresh if needed
    useEffect(() => {
        // Completely disable automatic periodic updates to prevent mass data collection
        console.log("⚠️ Automatic background scanning DISABLED to prevent mass data collection");
        console.log("💡 Users can manually refresh if needed");
        
        // No periodic updates - user must manually refresh
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
            console.log("🚀 Starting optimized blockchain scan with parallel processing...");
            
            // Test network connectivity first
            try {
                await provider.getNetwork();
            } catch (networkError) {
                console.warn("Network connectivity issue - skipping past events fetch");
                setStatus("");
                return;
            }
            
            // Get the current block number
            const currentBlock = await provider.getBlockNumber();
            
            // CONSERVATIVE SCAN: Only scan recent blocks to avoid massive data collection
            const fromBlock = Math.max(currentBlock - 50000, lastScannedBlock); // Only last 50k blocks
            
            console.log(`🔍 CONSERVATIVE BLOCKCHAIN SCAN: Recent blocks only from ${fromBlock} to ${currentBlock}`);
            console.log(`⚡ Limiting scan to recent 50k blocks to prevent mass data collection`);
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
            
            console.log(`📊 Processing ${chunks.length} chunks with ${MAX_CONCURRENT_CHUNKS} concurrent workers`);
            
            // Process chunks in parallel batches
            for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_CHUNKS) {
                const batch = chunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
                const batchNumber = Math.floor(i / MAX_CONCURRENT_CHUNKS) + 1;
                const totalBatches = Math.ceil(chunks.length / MAX_CONCURRENT_CHUNKS);
                
                setStatus(`⚡ Processing chunk ${batchNumber}/${totalBatches} (conservative mode)...`);
                
                // Process one chunk at a time to reduce load
                const chunk = batch[0]; // Only process first chunk since MAX_CONCURRENT_CHUNKS = 1
                console.log(`⚡ Processing chunk ${batchNumber}/${totalBatches}: ${chunk.start}-${chunk.end}`);
                const chunkPromise = async () => {
                    const { start, end } = chunk;
                    
                    // Skip if we've already processed this chunk
                    const chunkKey = `${start}-${end}`;
                    if (processedBlocksCache.has(chunkKey)) {
                        console.log(`⚡ Skipping cached chunk: ${chunkKey}`);
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
                        
                        console.log(`✅ Chunk ${chunkKey}: ${chunkPurchased.length} purchases, ${chunkCanceled.length} cancellations`);
                        return { purchased: chunkPurchased, canceled: chunkCanceled };
                        
                    } catch (chunkError) {
                        console.warn(`⚠️ Error in chunk ${chunkKey}:`, chunkError);
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
            
            console.log(`🎉 CONSERVATIVE SCAN COMPLETE:`);
            console.log(`⚡ Found ${purchasedEvents.length} total purchase events using conservative scanning`);
            console.log(`❌ Found ${canceledEvents.length} total canceled events`);
            console.log(`🚀 Performance: Processed ${chunks.length} chunks conservatively to prevent data overload`);
            
            setStatus(`🎉 Conservative scan complete! Processing ${purchasedEvents.length} purchase events and ${canceledEvents.length} canceled events...`);
            
            // Process all events with enhanced performance
            const pastSales = [];
            console.log(`🔄 Fast processing ${purchasedEvents.length} purchase events...`);
            
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
                        console.warn(`⚠️ Error processing purchase event ${i + batchIndex + 1}:`, eventError);
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
                    console.log(`📊 Processed ${Math.min(i + BATCH_SIZE, purchasedEvents.length)}/${purchasedEvents.length} transactions`);
                }
            }
            
            // Fast process canceled events
            console.log(`🔄 Processing ${canceledEvents.length} canceled events...`);
            const pastCanceled = new Set();
            canceledEvents.forEach(event => {
                try {
                    pastCanceled.add(event.args.listingId.toString());
                } catch (eventError) {
                    console.warn(`⚠️ Error processing canceled event:`, eventError);
                }
            });
            
            // Merge with existing data (avoid duplicates)
            setSalesHistory(prev => {
                const existingHashes = new Set(prev.map(sale => sale.transactionHash));
                const newSales = pastSales.filter(sale => !existingHashes.has(sale.transactionHash));
                const merged = [...prev, ...newSales].sort((a, b) => b.timestamp - a.timestamp);
                
                console.log(`📊 OPTIMIZED SCAN RESULTS:`);
                console.log(`💾 Previous sales: ${prev.length}`);
                console.log(`🆕 New sales from blockchain: ${newSales.length}`);
                console.log(`📈 Total sales history: ${merged.length} transactions`);
                console.log(`⚡ Performance: Used parallel processing and smart caching`);
                
                return merged;
            });
            
            setCanceledListings(prev => {
                const merged = new Set([...prev, ...pastCanceled]);
                console.log(`❌ Updated canceled listings: ${merged.size} total`);
                return merged;
            });
            
            // Enhanced success message with performance metrics
            const totalEventsFound = pastSales.length + pastCanceled.size;
            if (totalEventsFound > 0) {
                console.log(`🎉 OPTIMIZED BLOCKCHAIN SCAN COMPLETE!`);
                console.log(`📈 Total transactions found: ${pastSales.length}`);
                console.log(`❌ Total cancellations found: ${pastCanceled.size}`);
                console.log(`⚡ Performance improvement: Parallel chunk processing used`);
                
                setStatus(`✅ Optimized scan complete! Found ${pastSales.length} transactions and ${pastCanceled.size} cancellations using parallel processing.`);
                setTimeout(() => setStatus(""), 8000);
            } else {
                console.log(`📋 Optimized scan complete - no transaction history found in smart contract`);
                setStatus("✅ Optimized scan complete - no historical transactions found. This could mean the marketplace is new or transactions happened on a different contract.");
                setTimeout(() => setStatus(""), 8000);
            }
            
        } catch (error) {
            console.error("❌ Error in optimized blockchain scan:", error);
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
            console.warn("Error processing partial sales data:", error);
        }
    };

    // Set up event listeners for marketplace events
    const setupEventListeners = (contract) => {
        try {
            // Listen for purchases (sales)
            contract.on("NFTPurchased", async (listingId, buyer, quantity, totalPrice, paymentToken, event) => {
                console.log("NFT Purchased event:", { listingId, buyer, quantity, totalPrice, paymentToken });
                
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
                            console.log("Sale event already recorded, skipping duplicate");
                            return prev;
                        }
                        
                        const updated = [saleData, ...prev].sort((a, b) => b.timestamp - a.timestamp);
                        console.log("Added new sale to history:", saleData);
                        console.log("Total sales history now:", updated.length, "transactions");
                        return updated;
                    });
                } catch (error) {
                    console.error("Error processing NFTPurchased event:", error);
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
                console.log("Listing Canceled event:", { listingId });
                setCanceledListings(prev => new Set([...prev, listingId.toString()]));
            });

            // Listen for new listings
            contract.on("ListingCreated", (listingId, seller, nftContract, tokenId, quantity, pricePerUnit, paymentToken, isERC1155) => {
                console.log("New listing created:", { listingId, seller, nftContract });
                // Refresh listings when new ones are created
                setTimeout(fetchListings, 2000);
            });

            console.log("Event listeners set up successfully");
        } catch (error) {
            console.error("Error setting up event listeners:", error);
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
                console.warn("Network issue - calculating stats with fallback values");
                
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
                        console.warn("Error parsing sale price:", error);
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
                        console.warn("Error parsing listing price:", error);
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
                    console.warn("Error calculating sale value:", error);
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
                    console.warn("Error calculating listing value:", error);
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
        if (!marketplace) {
            debugWarn("Marketplace contract not initialized yet");
            return;
        }
        
        // Prevent concurrent fetches to avoid race conditions
        if (isLoading) {
            debugLog("Fetch already in progress, skipping concurrent request");
            return;
        }
        
        setIsLoading(true);
        setStatus('Loading listings...');
        debugLog(`fetchListings called with forceRefresh=${forceRefresh}, supabaseConnected=${supabaseConnected}`);
        
        let cachedListings = [];
        let shouldCheckBlockchain = true; // Default to check blockchain
        
        try {

            // Step 1: Try to load from cache first (unless force refresh)
            if (!forceRefresh && supabaseConnected && getCachedListings) {
                debugLog("Checking cache for listings...");
                cachedListings = await getCachedListings();
                
                if (cachedListings && cachedListings.length > 0) {
                    // Validate cache using content signature if available
                    const cacheValid = !lastCacheSignature || isCacheValid(
                        { signature: lastCacheSignature }, 
                        { listings: cachedListings }
                    );
                    
                    if (cacheValid) {
                        debugLog(`Loaded ${cachedListings.length} listings from cache`);
                        setListings(cachedListings);
                        setHotListings(cachedListings.slice(0, 5));
                        
                        // Check if cache is stale (older than 1 hour)
                        const cacheAge = Date.now() - (cachedListings[0]?.timestamp || 0);
                        if (cacheAge > 60 * 60 * 1000) {
                            setStatusWithType('Loaded from cache (data may be stale)', 'warning', true);
                            shouldCheckBlockchain = true; // Check blockchain if cache is stale
                        } else {
                            setStatusWithType('Loaded from cache', 'success');
                            shouldCheckBlockchain = false; // Don't need to check blockchain if cache is fresh
                        }
                        
                        // Clear non-persistent status after delay
                        setTimeout(() => clearStatus(), 2000);
                        
                        // If cache is fresh, don't check blockchain unless forced
                        if (!shouldCheckBlockchain && !forceRefresh) {
                            return;
                        }
                    } else {
                        debugLog("Cache signature mismatch, fetching fresh data");
                    }
                } else {
                    debugLog("No cached listings found, fetching from blockchain");
                }
            } else {
                debugLog("Skipping cache check:", {
                    forceRefresh,
                    supabaseConnected,
                    hasCachedListingsFunc: !!getCachedListings
                });

            }
            
            // Step 2: Check blockchain for updates if needed
            if (shouldCheckBlockchain) {
                console.log("🌐 Checking blockchain for latest listings...");
                await fetchListingsFromBlockchain(cachedListings.length > 0, cachedListings);
                lastCacheUpdateRef.current = Date.now();
            } else {
                // Just show cached data with appropriate status
                setStatus('Showing cached listings');
                setTimeout(() => setStatus(''), 2000);
            }
            
        } catch (error) {
            criticalError("Error in fetchListings:", error);
            setStatus('Failed to fetch listings');
        } finally {
            setIsLoading(false);
        }
    };

    const fetchListingsFromBlockchain = async (isBackgroundUpdate = false, existingListings = []) => {
        if (!isBackgroundUpdate) {
            setStatus('Fetching latest listings from blockchain...');
        } else {
            setStatus('Checking for new listings...');
        }
        
        try {
            console.log(`🌐 Fetching marketplace listings from blockchain... (background: ${isBackgroundUpdate})`);
            
            // Test network connectivity first
            try {
                await provider.getNetwork();
                
                // Check if we should use mock data for testing (environment flag)
                const useMockData = import.meta.env.VITE_USE_MOCK_DATA === 'true';
                if (useMockData) {
                    console.log("🧪 Using mock data for testing collection names (VITE_USE_MOCK_DATA=true)");
                    throw new Error("Using mock data for testing");
                }
            } catch (networkError) {
                console.warn("Network connectivity issue:", networkError.message);
                
                if (existingListings.length > 0) {
                    // We have cached data, use it
                    setStatus("Network issue - showing cached listings");
                    setTimeout(() => setStatus(''), 3000);
                    return;
                } else {
                    // For testing: Add mock listings when network is not available
                    console.log("Network issue - adding mock listings for testing collection names");
                    
                    const mockListings = [
                        {
                            id: 1,
                            seller: "0x1234567890123456789012345678901234567890",
                            nftContract: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
                            tokenId: "1",
                            quantity: "1",
                            pricePerUnit: ethers.parseEther("0.1").toString(),
                            paymentToken: ethers.ZeroAddress,
                            isERC1155: false,
                            active: true,
                            image: "https://picsum.photos/seed/1/300/300",
                            imageUrl: "https://picsum.photos/seed/1/300/300",
                            name: "Cosmic Dream #1",
                            title: "Cosmic Dream #1",
                            description: "A beautiful cosmic-themed digital artwork featuring swirling galaxies and stars",
                            collectionName: "Cosmic Dreams Collection",
                            metadata: {
                                name: "Cosmic Dream #1",
                                description: "A beautiful cosmic-themed digital artwork featuring swirling galaxies and stars",
                                image: "https://picsum.photos/seed/1/300/300",
                                collection: {
                                    name: "Cosmic Dreams Collection",
                                    description: "A collection of cosmic-themed digital artworks exploring the beauty of space",
                                    external_link: "https://cosmicdreams.example.com",
                                    image: "https://picsum.photos/seed/collection1/300/300"
                                }
                            }
                        },
                        {
                            id: 2,
                            seller: "0x2345678901234567890123456789012345678901",
                            nftContract: "0xbcdefabcdefabcdefabcdefabcdefabcdefabcde",
                            tokenId: "5",
                            quantity: "1",
                            pricePerUnit: ethers.parseEther("0.25").toString(),
                            paymentToken: ethers.ZeroAddress,
                            isERC1155: false,
                            active: true,
                            image: "https://picsum.photos/seed/2/300/300",
                            imageUrl: "https://picsum.photos/seed/2/300/300",
                            name: "Digital Warrior #5",
                            title: "Digital Warrior #5",
                            description: "A powerful warrior character from the digital realm",
                            collectionName: "Digital Warriors",
                            metadata: {
                                name: "Digital Warrior #5",
                                description: "A powerful warrior character from the digital realm",
                                image: "https://picsum.photos/seed/2/300/300",
                                collection: {
                                    name: "Digital Warriors",
                                    description: "Elite warrior characters ready for battle in the metaverse",
                                    external_link: "https://digitalwarriors.example.com",
                                    image: "https://picsum.photos/seed/collection2/300/300"
                                }
                            }
                        },
                        {
                            id: 3,
                            seller: "0x3456789012345678901234567890123456789012",
                            nftContract: "0xcdefabcdefabcdefabcdefabcdefabcdefabcdef",
                            tokenId: "10",
                            quantity: "1",
                            pricePerUnit: ethers.parseEther("0.05").toString(),
                            paymentToken: ethers.ZeroAddress,
                            isERC1155: false,
                            active: true,
                            image: "https://picsum.photos/seed/3/300/300",
                            imageUrl: "https://picsum.photos/seed/3/300/300",
                            name: "Abstract Expression #10",
                            title: "Abstract Expression #10",
                            description: "A vibrant abstract artwork exploring color and form",
                            collectionName: "Abstract Expressions",
                            metadata: {
                                name: "Abstract Expression #10",
                                description: "A vibrant abstract artwork exploring color and form",
                                image: "https://picsum.photos/seed/3/300/300",
                                collection: {
                                    name: "Abstract Expressions",
                                    description: "Bold abstract artworks that push the boundaries of digital creativity",
                                    external_link: "https://abstractexpressions.example.com",
                                    image: "https://picsum.photos/seed/collection3/300/300"
                                }
                            }
                        },
                        {
                            id: 4,
                            seller: "0x4567890123456789012345678901234567890123",
                            nftContract: "0xdefabcdefabcdefabcdefabcdefabcdefabcdefa",
                            tokenId: "15",
                            quantity: "1",
                            pricePerUnit: ethers.parseEther("0.75").toString(),
                            paymentToken: ethers.ZeroAddress,
                            isERC1155: false,
                            active: true,
                            image: "https://picsum.photos/seed/4/300/300",
                            imageUrl: "https://picsum.photos/seed/4/300/300",
                            name: "Cyber Punk Avatar #15",
                            title: "Cyber Punk Avatar #15",
                            description: "A futuristic cyberpunk character with neon aesthetics",
                            collectionName: "Cyber Punk Avatars",
                            metadata: {
                                name: "Cyber Punk Avatar #15",
                                description: "A futuristic cyberpunk character with neon aesthetics",
                                image: "https://picsum.photos/seed/4/300/300",
                                collection: {
                                    name: "Cyber Punk Avatars",
                                    description: "Futuristic avatars from the cyberpunk universe",
                                    external_link: "https://cyberpunkavatars.example.com",
                                    image: "https://picsum.photos/seed/collection4/300/300"
                                }
                            }
                        },
                        {
                            id: 5,
                            seller: "0x5678901234567890123456789012345678901234",
                            nftContract: "0xefabcdefabcdefabcdefabcdefabcdefabcdefab",
                            tokenId: "3",
                            quantity: "1",
                            pricePerUnit: ethers.parseEther("0.15").toString(),
                            paymentToken: ethers.ZeroAddress,
                            isERC1155: false,
                            active: true,
                            image: "https://picsum.photos/seed/5/300/300",
                            imageUrl: "https://picsum.photos/seed/5/300/300",
                            name: "Nature Spirit #3",
                            title: "Nature Spirit #3",
                            description: "A mystical nature spirit embodying the essence of the forest",
                            collectionName: "Nature Spirits",
                            metadata: {
                                name: "Nature Spirit #3",
                                description: "A mystical nature spirit embodying the essence of the forest",
                                image: "https://picsum.photos/seed/5/300/300",
                                collection: {
                                    name: "Nature Spirits",
                                    description: "Mystical beings that connect the digital and natural worlds",
                                    external_link: "https://naturespirits.example.com",
                                    image: "https://picsum.photos/seed/collection5/300/300"
                                }
                            }
                        },
                        {
                            id: 6,
                            seller: "0x6789012345678901234567890123456789012345",
                            nftContract: "0xfabcdefabcdefabcdefabcdefabcdefabcdefabc",
                            tokenId: "7",
                            quantity: "1",
                            pricePerUnit: ethers.parseEther("0.3").toString(),
                            paymentToken: ethers.ZeroAddress,
                            isERC1155: false,
                            active: true,
                            image: "https://picsum.photos/seed/6/300/300",
                            imageUrl: "https://picsum.photos/seed/6/300/300",
                            name: "Pixel Art Masterpiece #7",
                            title: "Pixel Art Masterpiece #7",
                            description: "A retro-style pixel art creation with modern appeal",
                            collectionName: "Pixel Art Masterpieces",
                            metadata: {
                                name: "Pixel Art Masterpiece #7",
                                description: "A retro-style pixel art creation with modern appeal",
                                image: "https://picsum.photos/seed/6/300/300",
                                collection: {
                                    name: "Pixel Art Masterpieces",
                                    description: "Nostalgic pixel art that brings back the golden age of gaming",
                                    external_link: "https://pixelartmasterpieces.example.com",
                                    image: "https://picsum.photos/seed/collection6/300/300"
                                }
                            }
                        }
                    ];
                    
                    setListings(mockListings);
                    setHotListings(mockListings.slice(0, 2));
                    setStatus("Showing mock listings for testing collection names");
                    setTimeout(() => setStatus(''), 3000);
                    return;
                }
            }
            
            // Track existing listing IDs to detect new ones
            const existingIds = new Set(existingListings.map(listing => listing.id));
            let newListingsFound = 0;
            
            const res = [];
            const maxScanRange = MARKETPLACE_CONFIG.MAX_LISTING_SCAN;
            
            for (let i = MARKETPLACE_CONFIG.MIN_LISTING_SCAN; i <= maxScanRange; i++) {
                try {
                    const listing = await marketplace.listings(i);

                    // Skip inactive listings
                    if (!listing || !listing.active) continue;

                    // For background updates, prioritize new listings
                    if (isBackgroundUpdate && existingIds.has(i)) {
                        // Use existing listing data to avoid re-fetching metadata
                        const existingListing = existingListings.find(l => l.id === i);
                        if (existingListing) {
                            res.push(existingListing);
                            continue;
                        }
                    }

                    // Create a proper image URL for the NFT
                    let image = MARKETPLACE_CONFIG.DEFAULT_NFT_PLACEHOLDER;
                    let name = resolveCollectionName({ tokenId: listing.tokenId?.toString() || '0' });
                    let metadata = null;
                    let collectionName = null;

                    try {
                        // Enhanced contract instance for the NFT with collection name support
                        const nftContract = new ethers.Contract(
                            listing.nftContract,
                            listing.isERC1155 ?
                                ['function uri(uint256 id) view returns (string)', 'function name() view returns (string)'] :
                                ['function tokenURI(uint256 tokenId) view returns (string)', 'function name() view returns (string)', 'function symbol() view returns (string)'],
                            provider
                        );

                        // Try to get collection name from contract first with enhanced error handling
                        try {
                            const contractName = await nftContract.name();
                            if (contractName && contractName.trim() !== '') {
                                collectionName = contractName.trim();
                                console.log(`✅ Collection name from contract for ${listing.nftContract}: ${collectionName}`);
                            } else {
                                console.warn(`⚠️ Contract ${listing.nftContract} returned empty name`);
                            }
                        } catch (nameError) {
                            console.warn(`❌ Failed to get contract name for ${listing.nftContract}:`, nameError.message);
                            // Continue with fallback resolution below
                        }

                        // Get token URI
                        let tokenURI;
                        if (listing.isERC1155) {
                            tokenURI = await nftContract.uri(listing.tokenId);
                            tokenURI = tokenURI.replace('{id}', listing.tokenId.toString().padStart(64, '0'));
                        } else {
                            tokenURI = await nftContract.tokenURI(listing.tokenId);
                        }

                        debugLog(`Token URI for listing ${i}: ${tokenURI}`);

                        // Enhanced metadata fetching with multiple IPFS gateway fallbacks
                        const ipfsGateways = [
                            'https://ipfs.io/ipfs/',
                            'https://cloudflare-ipfs.com/ipfs/',
                            'https://gateway.pinata.cloud/ipfs/',
                            'https://ipfs.fleek.co/ipfs/',
                            'https://dweb.link/ipfs/'
                        ];

                        // Enhanced metadata fetching with CORS-safe requests and better error handling
                        const { primaryUrl, fallbacks } = resolveIPFSWithFallbacks(tokenURI);
                        
                        debugLog(`Fetching metadata for listing ${i} from: ${primaryUrl}`);
                        if (fallbacks.length > 0) {
                            debugLog(`Available fallbacks: ${fallbacks.length} IPFS gateways`);
                        }

                        // Fetch metadata with CORS-safe requests and automatic fallbacks
                        let metadata = null;
                        let fetchSuccess = false;
                        
                        try {
                            const metadataJson = await fetchJSON(primaryUrl, {
                                timeout: 10000
                            }, fallbacks);
                            
                            metadata = normalizeNFTMetadata(metadataJson, listing.nftContract, listing.tokenId?.toString());
                            fetchSuccess = true;
                            debugLog(`Successfully fetched metadata for listing ${i}`);
                            
                        } catch (fetchError) {
                            debugWarn(`All metadata fetch attempts failed for listing ${i}:`, fetchError.message);
                            
                            // Provide specific error feedback for debugging
                            if (isCORSError(fetchError)) {
                                debugLog(`CORS issue detected - this is often due to restrictive server policies`);
                            } else if (isNetworkError(fetchError)) {
                                debugLog(`Network connectivity issue - may be temporary`);
                            }
                            
                            // Use fallback metadata
                            metadata = normalizeNFTMetadata(null, listing.nftContract, listing.tokenId?.toString());
                        }

                        debugLog(`Metadata for listing ${i}:`, metadata);

                        if (metadata.name) name = metadata.name;

                        // Enhanced image resolution with IPFS gateway support
                        if (metadata.image) {
                            image = metadata.image;
                            
                            // If metadata image is also IPFS, ensure it uses a working gateway
                            if (image.startsWith('ipfs://')) {
                                image = image.replace('ipfs://', ipfsGateways[0]);
                            }
                            
                            debugLog(`Image URL for listing ${i}: ${image}`);
                        }

                        // Enhanced collection name resolution with multiple fallbacks
                        if (!collectionName || collectionName.includes('Collection 0x')) {
                            // Try metadata.collection.name first
                            if (metadata?.collection?.name && metadata.collection.name.trim() !== '') {
                                collectionName = metadata.collection.name.trim();
                                console.log(`📋 Using collection name from metadata: ${collectionName}`);
                            } 
                            // Try metadata.name if it doesn't look like a token name
                            else if (metadata?.name && 
                                     !metadata.name.includes('#') && 
                                     !metadata.name.toLowerCase().includes('token') &&
                                     !metadata.name.toLowerCase().includes('nft') &&
                                     metadata.name.trim() !== '') {
                                collectionName = metadata.name.trim();
                                console.log(`📝 Using NFT name as collection name: ${collectionName}`);
                            }
                            // Try to extract from description
                            else if (metadata?.description && metadata.description.trim() !== '') {
                                const description = metadata.description.trim();
                                const words = description.split(' ');
                                if (words.length >= 2 && words.length <= 4) {
                                    // If description is short enough, it might be a collection name
                                    collectionName = description;
                                    console.log(`📖 Using description as collection name: ${collectionName}`);
                                } else {
                                    // Extract first few words
                                    collectionName = words.slice(0, 3).join(' ');
                                    console.log(`🔤 Using first words of description: ${collectionName}`);
                                }
                            }
                        }
                    } catch (error) {
                        debugWarn(`Failed to fetch metadata for listing ${i}:`, error);
                        // Use fallback metadata
                        metadata = normalizeNFTMetadata(null, listing.nftContract, listing.tokenId?.toString());
                        name = metadata.name;
                    }

                    // Create the sanitized listing object with standardized BigInt handling
                    const sanitizedListing = {
                        id: i,
                        seller: listing.seller || ethers.ZeroAddress,
                        nftContract: listing.nftContract || ethers.ZeroAddress,
                        tokenId: listing.tokenId?.toString() || '0',
                        quantity: standardizeBigInt(listing.quantity || '0'),
                        pricePerUnit: standardizeBigInt(listing.pricePerUnit || '0'),
                        paymentToken: listing.paymentToken || ethers.ZeroAddress,
                        isERC1155: !!listing.isERC1155,
                        active: !!listing.active,

                        // Enhanced metadata structure with proper fallbacks
                        image,
                        imageUrl: image,
                        name,
                        title: name,

                        description: metadata?.description || `Token ID: ${listing.tokenId?.toString() || '0'}`,

                        // Normalized metadata object
                        metadata: {
                            ...metadata,
                            image: image // Ensure the resolved URL is in metadata too
                        },
                        
                        // Add content signature for cache validation
                        signature: createContentSignature({
                            tokenId: listing.tokenId?.toString(),
                            pricePerUnit: listing.pricePerUnit?.toString(),
                            active: listing.active,
                            metadata: metadata
                        })
                    };

                    debugLog("Sanitized listing with enhanced metadata:", sanitizedListing.name);

                    res.push(sanitizedListing);
                    
                    // Track new listings
                    if (!existingIds.has(i)) {
                        newListingsFound++;
                    }
                } catch (err) {
                    debugWarn(`Skipping listing ${i}:`, err.message);
                }
            }

            debugLog(`Successfully loaded ${res.length} listings from blockchain`);
            setListings(res);
            setHotListings(res.slice(0, 5));
            
            // Enhanced caching with content-based validation
            debugLog(`Auto-caching DISABLED to prevent mass data collection to Supabase`);
            debugLog(`Found ${res.length} listings - caching disabled to prevent database overload`);

            // Auto-caching disabled to prevent mass data collection
            const shouldCache = false;
            
            if (shouldCache && supabaseConnected && res.length > 0 && cacheListings) {
                try {
                    console.log(`💾 Caching ${res.length} listings (${newListingsFound} new)...`);
                    await cacheListings(res);
                    console.log(`✅ Successfully cached ${res.length} listings`);
                } catch (cacheError) {
                    console.warn("❌ Failed to cache listings:", cacheError);
                }
            } else if (!shouldCache) {
                console.log("📋 No cache update needed - data unchanged");
            }
            
            // Clear status after delay
            setTimeout(() => setStatus(''), isBackgroundUpdate ? 2000 : 3000);
            
        } catch (error) {
            console.error("Error in fetchListingsFromBlockchain:", error);
            
            // If we have existing data and this was a background update, keep showing it
            if (isBackgroundUpdate && existingListings.length > 0) {
                setStatus('Update failed - showing cached listings');
                setTimeout(() => setStatus(''), 3000);
            } else {
                setStatus('Failed to fetch listings - network connectivity issue');
            }
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

    // Replace the current buyListing function with this version
    const buyListing = async (id, pricePerUnit, paymentToken) => {
        if (!signer) {
            setStatus('Error: Wallet not connected. Please connect your wallet first');
            return;
        }

        if (!marketplace) {
            setStatus('Error: Marketplace contract not initialized');
            return;
        }

        try {
            // Connect with signer
            const marketplaceWithSigner = marketplace.connect(signer);
            
            // If using ERC20 token (not native VTRU), check approval first
            if (paymentToken !== ethers.ZeroAddress) {
                setStatus('Checking token approval...');
                
                // Create token contract instance
                const tokenContract = new ethers.Contract(paymentToken, ERC20_ABI, signer);
                
                try {
                    // Get token symbol and decimals for better messages
                    const tokenSymbol = await tokenContract.symbol();
                    
                    // Check current allowance
                    const currentAllowance = await tokenContract.allowance(wallet, marketplaceAddress);
                    
                    // If allowance is insufficient, request approval
                    if (currentAllowance < pricePerUnit) {
                        setStatus(`Requesting approval to spend ${tokenSymbol}...`);
                        
                        // Request approval for a large amount to avoid future approvals
                        const approvalTx = await tokenContract.approve(
                            marketplaceAddress,
                            ethers.MaxUint256 // Infinite approval
                        );
                        
                        setStatus(`Approving ${tokenSymbol} spending. Please confirm in your wallet...`);
                        await approvalTx.wait();
                        setStatus(`${tokenSymbol} approved! Processing purchase...`);
                    }
                } catch (error) {
                    if (error.message.includes('user rejected')) {
                        setStatus('Token approval was rejected');
                        return;
                    }
                    console.error('Error in token approval:', error);
                    throw new Error(`Failed to approve token: ${error.message}`);
                }
            }

            // Now proceed with the purchase
            setStatus('Buying...');
            
            console.log(`Buying listing ${id} for ${ethers.formatEther(pricePerUnit)} ${
                paymentToken === ethers.ZeroAddress ? 'VTRU' : 'tokens'}`);
            
            const tx = await marketplaceWithSigner.buy(id, 1, {
                value: paymentToken === ethers.ZeroAddress ? pricePerUnit : undefined
            });
            
            setStatus('Transaction submitted. Waiting for confirmation...');
            await tx.wait();
            setStatus('Purchase successful! Updating marketplace data...');
            
            // Invalidate cache and refresh listings
            if (supabaseConnected && cacheListings) {
                console.log("💾 Invalidating cache due to purchase...");
                // Force refresh from blockchain to get latest state
                await fetchListings(true);
            } else {
                // Refresh listings normally
                fetchListings();
            }
            
            // Wait a moment for events to be mined and then fetch recent events
            setTimeout(async () => {
                try {
                    await fetchPastSalesEvents(marketplace);
                    setStatus('Purchase successful! Marketplace updated.');
                    
                    // Clear status after a few seconds
                    setTimeout(() => setStatus(''), 3000);
                } catch (eventError) {
                    console.warn("Error fetching updated events after purchase:", eventError);
                    setStatus('Purchase successful!');
                    setTimeout(() => setStatus(''), 3000);
                }
            }, 2000);
            
        } catch (e) {
            console.error('Error in buyListing:', e);
            
            if (e.message.includes('user rejected transaction')) {
                setStatus('Transaction was rejected in your wallet');
            } else if (e.message.includes('insufficient funds')) {
                setStatus('Error: Insufficient funds for this purchase');
            } else if (e.message.includes('caller is not token owner or approved')) {
                setStatus('Error: Seller needs to approve the marketplace to transfer their NFT');
            } else {
                setStatus('Buy failed: ' + (e.message || e));
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
            console.log("Creating listing with parameters:", {
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
                console.log(`Detected ${nftContract} as ERC1155`);
            } catch (e) {
                // If that fails, assume it's ERC721
                console.log(`Detected ${nftContract} as ERC721`);
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
                    console.log("Requesting ERC1155 approval for marketplace");

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
                        console.log("Requesting ERC721 approval for marketplace");

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

            console.log("Sending create listing transaction...");
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
                console.log("💾 Invalidating cache due to new listing...");
                // Force refresh from blockchain to get latest state
                await fetchListings(true);
            } else {
                // Refresh listings normally
                fetchListings();
            }

        } catch (error) {
            console.error("Error in createListing:", error);

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

    // DISABLED: Load listings on initial load only - no automatic refresh to prevent mass data
    useEffect(() => {
        if (marketplace) {
            // Only load once on initial mount - no automatic refresh intervals
            console.log("📋 Loading listings once on initialization - auto-refresh DISABLED");
            fetchListings();
            
            // DISABLED: Automatic refresh interval to prevent mass data collection
            console.log("⚠️ Automatic listing refresh DISABLED to prevent mass data collection");
            console.log("💡 Users can manually refresh listings if needed");
            
            // No automatic refresh interval
            return () => {
                // No interval to cleanup
            };
        }
    }, [marketplace]);

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
            // New marketplace statistics and data
            salesHistory,
            canceledListings,
            marketplaceStats,
            calculateMarketplaceStats,
            // Add function to manually refresh blockchain data
            refreshBlockchainData: () => marketplace && fetchPastSalesEvents(marketplace)
        }}>
            {children}
        </MarketplaceContext.Provider>
    );
}

export function useMarketplace() {
    return useContext(MarketplaceContext);
}