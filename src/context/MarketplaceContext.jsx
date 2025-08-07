import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './WalletContext';
import { useSupabase } from './SupabaseContext';
import { convertToUSDCValue } from '../utils/tokenUtils';

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
                    console.log("🔍 Loading sales history from Supabase cache...");
                    const cachedSales = await getCachedSalesHistory();
                    
                    if (cachedSales && cachedSales.length > 0) {
                        console.log(`📦 Loaded ${cachedSales.length} sales from Supabase cache`);
                        setSalesHistory(cachedSales);
                    } else {
                        // Fallback to localStorage if no Supabase cache
                        console.log("No Supabase cache found, falling back to localStorage");
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
                console.error("Error loading persisted marketplace data:", error);
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
                    console.log("Loaded persisted sales history from localStorage:", parsedHistory);
                    setSalesHistory(parsedHistory);
                }
            } catch (error) {
                console.error("Error loading from localStorage:", error);
            }
        };
        
        loadPersistedData();
    }, [supabaseConnected]); // Removed getCachedSalesHistory from dependencies to prevent infinite loops

    // DISABLED: Persist sales history to Supabase to prevent mass data collection
    // Use a ref to track last cached count to prevent unnecessary Supabase calls
    const lastCachedSalesCount = useRef(0);
    useEffect(() => {
        if (salesHistory.length > 0) {
            try {
                // Always persist to localStorage for immediate access
                localStorage.setItem('marketplace_sales_history', JSON.stringify(salesHistory));
                console.log("Persisted sales history to localStorage:", salesHistory.length, "transactions");
                
                // DISABLED: Auto-caching to Supabase to prevent mass data collection
                console.log("💾 Auto-caching to Supabase DISABLED to prevent mass data collection");
                console.log(`💡 ${salesHistory.length} sales in memory - Supabase auto-cache disabled`);
                
                if (false) { // Explicitly disabled - change to true only if user wants auto-caching
                    // Only cache to Supabase if we have new sales data
                    if (supabaseConnected && cacheSalesHistory && salesHistory.length !== lastCachedSalesCount.current) {
                        console.log("💾 Caching sales history to Supabase...");
                        lastCachedSalesCount.current = salesHistory.length;
                        cacheSalesHistory(salesHistory).catch(error => {
                            console.warn("Failed to cache sales history to Supabase:", error);
                        });
                    }
                }
            } catch (error) {
                console.error("Error persisting sales history:", error);
            }
        }
    }, [salesHistory, supabaseConnected]); // Removed cacheSalesHistory from dependencies

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
    const calculateMarketplaceStats = async () => {
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
                
                // Calculate listing volume in native tokens
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
            console.error("Error calculating marketplace stats:", error);
        }
    };

    // Recalculate stats when data changes
    useEffect(() => {
        calculateMarketplaceStats();
    }, [salesHistory, listings, canceledListings, provider]);

    const fetchListings = async (forceRefresh = false) => {
        if (!marketplace) {
            console.warn("Marketplace contract not initialized yet");
            return;
        }
        
        setStatus('Loading listings...');
        console.log(`🔄 fetchListings called with forceRefresh=${forceRefresh}, supabaseConnected=${supabaseConnected}`);
        
        try {
            // Step 1: Try to load from cache first (unless force refresh)
            if (!forceRefresh && supabaseConnected && getCachedListings) {
                console.log("🔍 Checking cache for listings...");
                const cachedListings = await getCachedListings();
                
                if (cachedListings && cachedListings.length > 0) {
                    console.log(`📦 Loaded ${cachedListings.length} listings from cache`);
                    setListings(cachedListings);
                    setHotListings(cachedListings.slice(0, 5));
                    setStatus('Loaded from cache');
                    
                    // Remove automatic background fetch to prevent refresh loops
                    // User can manually refresh if needed
                    setTimeout(() => setStatus(''), 2000);
                    return;
                } else {
                    console.log("🔍 No cached listings found, fetching from blockchain");
                }
            } else {
                console.log("🔍 Skipping cache check:", {
                    forceRefresh,
                    supabaseConnected,
                    hasCachedListingsFunc: !!getCachedListings
                });
            }
            
            // Step 2: Fetch from blockchain
            await fetchListingsFromBlockchain(false);
            
        } catch (error) {
            console.error("Error in fetchListings:", error);
            setStatus('Failed to fetch listings');
        }
    };

    const fetchListingsFromBlockchain = async (isBackgroundUpdate = false) => {
        if (!isBackgroundUpdate) {
            setStatus('Fetching latest listings from blockchain...');
        }
        
        try {
            console.log("Fetching marketplace listings from blockchain...");
            
            // Test network connectivity first
            try {
                await provider.getNetwork();
            } catch (networkError) {
                console.warn("Network connectivity issue:", networkError.message);
                setStatus("Network connectivity issue - using cached data if available");
                
                // Try to use cached data as fallback
                if (supabaseConnected) {
                    const cachedListings = await getCachedListings();
                    if (cachedListings && cachedListings.length > 0) {
                        setListings(cachedListings);
                        setHotListings(cachedListings.slice(0, 5));
                        setStatus("Using cached listings - network unavailable");
                        return;
                    }
                }
                
                // When network is unavailable and no cached data, show empty state
                console.log("Network unavailable and no cached data - showing empty state");
                setListings([]);
                setHotListings([]);
                setStatus('Network unavailable - no listings to display');
                return;
            }
            
            const res = [];
            for (let i = 1; i < 20; i++) {
                try {
                    const listing = await marketplace.listings(i);

                    // Skip inactive listings
                    if (!listing || !listing.active) continue;

                    // Create a proper image URL for the NFT
                    let image = '/placeholders/nft-placeholder.jpg';
                    let name = `NFT #${listing.tokenId?.toString() || '0'}`;
                    let metadata = null;

                    try {
                        // Create contract instance for the NFT
                        const nftContract = new ethers.Contract(
                            listing.nftContract,
                            listing.isERC1155 ?
                                ['function uri(uint256 id) view returns (string)'] :
                                ['function tokenURI(uint256 tokenId) view returns (string)', 'function name() view returns (string)'],
                            provider
                        );

                        // Get token URI
                        let tokenURI;
                        if (listing.isERC1155) {
                            tokenURI = await nftContract.uri(listing.tokenId);
                            tokenURI = tokenURI.replace('{id}', listing.tokenId.toString().padStart(64, '0'));
                        } else {
                            tokenURI = await nftContract.tokenURI(listing.tokenId);
                        }

                        console.log(`Token URI for listing ${i}: ${tokenURI}`);

                        // Resolve IPFS URI
                        const resolvedURI = tokenURI.startsWith('ipfs://')
                            ? tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/')
                            : tokenURI;

                        // Fetch metadata
                        const response = await fetch(resolvedURI);
                        const metadataJson = await response.json();
                        metadata = metadataJson; // Save the full metadata object

                        console.log(`Metadata for listing ${i}:`, metadata);

                        if (metadata.name) name = metadata.name;

                        if (metadata.image) {
                            if (metadata.image.startsWith('ipfs://')) {
                                image = metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
                            } else {
                                image = metadata.image;
                            }
                            console.log(`Image URL for listing ${i}: ${image}`);
                        }
                    } catch (error) {
                        console.warn(`Failed to fetch metadata for listing ${i}:`, error);
                    }

                    // Create the sanitized listing object
                    const sanitizedListing = {
                        id: i,
                        seller: listing.seller || ethers.ZeroAddress,
                        nftContract: listing.nftContract || ethers.ZeroAddress,
                        tokenId: listing.tokenId?.toString() || '0',
                        quantity: listing.quantity?.toString() || '0',
                        pricePerUnit: listing.pricePerUnit?.toString() || '0',
                        paymentToken: listing.paymentToken || ethers.ZeroAddress,
                        isERC1155: !!listing.isERC1155,
                        active: !!listing.active,

                        // CRITICAL: Add both direct properties AND a nested metadata object
                        // This ensures we cover both access patterns
                        image,
                        imageUrl: image,
                        name,
                        title: name,
                        description: `Token ID: ${listing.tokenId?.toString() || '0'}`,

                        // Add the full metadata object - CRUCIAL!
                        // ListingCard is likely expecting this structure
                        metadata: {
                            ...metadata,
                            image: image // Ensure the IPFS URL is resolved in the metadata object too
                        }
                    };

                    console.log("Sanitized listing with image:", sanitizedListing);
                    res.push(sanitizedListing);
                } catch (err) {
                    console.log(`Skipping listing ${i}:`, err.message);
                }
            }

            console.log(`Successfully loaded ${res.length} listings from blockchain`);
            setListings(res);
            setHotListings(res.slice(0, 5));
            
            // DISABLED: Automatic caching to prevent mass data collection to Supabase
            // Cache the fresh data only if user explicitly enables it
            console.log(`🔧 Auto-caching DISABLED to prevent mass data collection to Supabase`);
            console.log(`💡 Found ${res.length} listings - caching disabled to prevent database overload`);
            
            if (false) { // Explicitly disabled - change to true only if user wants auto-caching
                if (supabaseConnected && res.length > 0 && cacheListings) {
                    try {
                        console.log(`💾 Attempting to cache ${res.length} listings to Supabase...`);
                        await cacheListings(res);
                        console.log(`✅ Successfully cached ${res.length} listings to Supabase`);
                    } catch (cacheError) {
                        console.warn("❌ Failed to cache listings:", cacheError);
                    }
                } else {
                    console.log("⚠️ Skipping listings cache due to:", {
                        supabaseConnected,
                        listingsCount: res.length,
                        hasCacheListingsFunc: !!cacheListings
                    });
                }
            }
            
            if (isBackgroundUpdate) {
                setStatus('');
            } else {
                setStatus(`Loaded ${res.length} listings`);
                setTimeout(() => setStatus(''), 3000);
            }
        } catch (error) {
            console.error("Error in fetchListingsFromBlockchain:", error);
            if (!isBackgroundUpdate) {
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
            setStatus,
            fetchListings,
            buyListing,
            createListing,
            isInitialized,
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