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

    // Load sales history from localStorage on initialization
    useEffect(() => {
        const loadPersistedData = () => {
            try {
                const savedSalesHistory = localStorage.getItem('marketplace_sales_history');
                const savedCanceledListings = localStorage.getItem('marketplace_canceled_listings');
                
                if (savedSalesHistory) {
                    const parsedHistory = JSON.parse(savedSalesHistory);
                    console.log("Loaded persisted sales history:", parsedHistory);
                    setSalesHistory(parsedHistory);
                }
                
                if (savedCanceledListings) {
                    const parsedCanceled = JSON.parse(savedCanceledListings);
                    setCanceledListings(new Set(parsedCanceled));
                }
            } catch (error) {
                console.error("Error loading persisted marketplace data:", error);
            }
        };
        
        loadPersistedData();
    }, []);

    // Persist sales history to localStorage whenever it changes
    useEffect(() => {
        if (salesHistory.length > 0) {
            try {
                localStorage.setItem('marketplace_sales_history', JSON.stringify(salesHistory));
                console.log("Persisted sales history to localStorage:", salesHistory.length, "transactions");
            } catch (error) {
                console.error("Error persisting sales history:", error);
            }
        }
    }, [salesHistory]);

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
                        // Set up event listeners for sales tracking
                        setupEventListeners(contract);
                        
                        // Fetch past sales events from blockchain
                        await fetchPastSalesEvents(contract);
                    } catch (networkError) {
                        console.warn("Network connectivity issue - event listeners not set up:", networkError.message);
                        setStatus("Network connectivity issue - running in offline mode. Sales tracking unavailable.");
                        
                        // Set up demo data for testing when network is unavailable
                        setupDemoData();
                    }
                } catch (error) {
                    console.error("Error initializing marketplace contract:", error);
                    setStatus("Failed to initialize marketplace contract");
                }
            }
        };

        initializeMarketplace();
    }, [marketplaceAddress, abi, provider]);

    // Set up real-time subscriptions when Supabase is connected
    useEffect(() => {
        if (supabaseConnected && subscribeToListings) {
            console.log("🔄 Setting up real-time subscriptions...");
            
            const listingsSubscription = subscribeToListings((payload) => {
                console.log("📡 Real-time listing update received:", payload);
                
                // Refresh listings when changes occur
                if (marketplace) {
                    console.log("🔄 Refreshing listings due to real-time update");
                    fetchListings(true); // Force refresh
                }
            });

            // Set up periodic cache updates for blockchain data
            cacheUpdateInterval.current = setInterval(() => {
                if (marketplace) {
                    console.log("⏰ Periodic cache update triggered");
                    fetchListingsFromBlockchain(true); // Background update
                }
            }, 60000); // Update every minute

            return () => {
                if (listingsSubscription) {
                    console.log("🔌 Unsubscribing from listings updates");
                    listingsSubscription.unsubscribe();
                }
                if (cacheUpdateInterval.current) {
                    clearInterval(cacheUpdateInterval.current);
                }
            };
        }
    }, [supabaseConnected, marketplace, subscribeToListings]);

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
    const [lastScannedBlock, setLastScannedBlock] = useState(10000000);

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
            
            // OPTIMIZED SCAN: Start from block 10,000,000 but check cache
            const fromBlock = Math.max(10000000, lastScannedBlock);
            
            console.log(`🔍 OPTIMIZED BLOCKCHAIN SCAN: Parallel processing from block ${fromBlock} to ${currentBlock}`);
            console.log(`⚡ Using smart caching and concurrent chunk processing for maximum efficiency`);
            setStatus(`⚡ Optimized scan: blocks ${fromBlock} to ${currentBlock} with parallel processing...`);
            
            let purchasedEvents = [];
            let canceledEvents = [];
            
            // Optimized chunk size for parallel processing
            const CHUNK_SIZE = 25000; // Smaller chunks for better parallelization
            const MAX_CONCURRENT_CHUNKS = 4; // Process multiple chunks simultaneously
            
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
                
                setStatus(`⚡ Processing batch ${batchNumber}/${totalBatches} (${batch.length} chunks in parallel)...`);
                console.log(`⚡ Processing batch ${batchNumber}/${totalBatches}: chunks ${batch.map(c => `${c.start}-${c.end}`).join(', ')}`);
                
                // Process all chunks in this batch concurrently
                const batchPromises = batch.map(async (chunk) => {
                    const { start, end } = chunk;
                    
                    // Skip if we've already processed this chunk
                    const chunkKey = `${start}-${end}`;
                    if (processedBlocksCache.has(chunkKey)) {
                        console.log(`⚡ Skipping cached chunk: ${chunkKey}`);
                        return { purchased: [], canceled: [] };
                    }
                    
                    try {
                        // Parallel event queries for this chunk
                        const [chunkPurchased, chunkCanceled] = await Promise.all([
                            contract.queryFilter(
                                contract.filters.NFTPurchased(),
                                start,
                                end
                            ),
                            contract.queryFilter(
                                contract.filters.ListingCanceled(),
                                start,
                                end
                            )
                        ]);
                        
                        // Cache this chunk as processed
                        setProcessedBlocksCache(prev => new Set([...prev, chunkKey]));
                        
                        console.log(`✅ Chunk ${chunkKey}: ${chunkPurchased.length} purchases, ${chunkCanceled.length} cancellations`);
                        return { purchased: chunkPurchased, canceled: chunkCanceled };
                        
                    } catch (chunkError) {
                        console.warn(`⚠️ Error in chunk ${chunkKey}:`, chunkError);
                        return { purchased: [], canceled: [] };
                    }
                });
                
                // Wait for all chunks in this batch to complete
                const batchResults = await Promise.all(batchPromises);
                
                // Accumulate results
                batchResults.forEach(result => {
                    purchasedEvents = [...purchasedEvents, ...result.purchased];
                    canceledEvents = [...canceledEvents, ...result.canceled];
                });
                
                // Progressive update: show data as it's being fetched
                if (purchasedEvents.length > 0) {
                    setStatus(`📈 Found ${purchasedEvents.length} transactions so far... (batch ${batchNumber}/${totalBatches} complete)`);
                    
                    // Process and display partial results immediately
                    await processPartialSalesData(purchasedEvents.slice(-batchResults.reduce((sum, r) => sum + r.purchased.length, 0)));
                }
                
                // Small delay between batches to prevent overwhelming the RPC
                if (i + MAX_CONCURRENT_CHUNKS < chunks.length) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
            
            // Update last scanned block
            setLastScannedBlock(currentBlock);
            
            console.log(`🎉 OPTIMIZED SCAN COMPLETE:`);
            console.log(`⚡ Found ${purchasedEvents.length} total purchase events using parallel processing`);
            console.log(`❌ Found ${canceledEvents.length} total canceled events`);
            console.log(`🚀 Performance: Processed ${chunks.length} chunks with ${MAX_CONCURRENT_CHUNKS}x parallelization`);
            
            setStatus(`🎉 Optimized scan complete! Processing ${purchasedEvents.length} purchase events and ${canceledEvents.length} canceled events...`);
            
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

    // Set up demo data for testing/offline mode
    const setupDemoData = () => {
        console.log("Setting up demo data for offline testing");
        
        // Only set up demo data if we don't have any existing sales history
        if (salesHistory.length === 0) {
            // Create some demo sales history
            const demoSales = [
                {
                    listingId: "1",
                    buyer: "0x1234567890123456789012345678901234567890",
                    quantity: "1",
                    totalPrice: ethers.parseEther("2.5").toString(),
                    paymentToken: ethers.ZeroAddress,
                    timestamp: Date.now() - 3600000, // 1 hour ago
                    type: 'sale'
                },
                {
                    listingId: "2", 
                    buyer: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
                    quantity: "1",
                    totalPrice: ethers.parseEther("1.8").toString(),
                    paymentToken: ethers.ZeroAddress,
                    timestamp: Date.now() - 7200000, // 2 hours ago
                    type: 'sale'
                },
                {
                    listingId: "3",
                    buyer: "0x9876543210987654321098765432109876543210", 
                    quantity: "1",
                    totalPrice: ethers.parseEther("3.2").toString(),
                    paymentToken: ethers.ZeroAddress,
                    timestamp: Date.now() - 86400000, // 1 day ago
                    type: 'sale'
                }
            ];
            
            setSalesHistory(demoSales);
        }
        
        setStatus("Running in demo mode - showing sample transaction data");
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
        
        try {
            // Step 1: Try to load from cache first (unless force refresh)
            if (!forceRefresh && supabaseConnected) {
                console.log("🔍 Checking cache for listings...");
                const cachedListings = await getCachedListings();
                
                if (cachedListings && cachedListings.length > 0) {
                    console.log(`📦 Loaded ${cachedListings.length} listings from cache`);
                    setListings(cachedListings);
                    setHotListings(cachedListings.slice(0, 5));
                    setStatus('Loaded from cache - fetching latest updates...');
                    
                    // Continue to fetch fresh data in background
                    setTimeout(() => fetchListingsFromBlockchain(true), 100);
                    return;
                }
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
                
                // Provide demo listings for testing
                const demoListings = [
                    {
                        id: 1,
                        seller: "0x1234567890123456789012345678901234567890",
                        nftContract: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
                        tokenId: "1",
                        quantity: "1",
                        pricePerUnit: ethers.parseEther("1.5").toString(),
                        paymentToken: ethers.ZeroAddress,
                        isERC1155: false,
                        active: true,
                        image: '/placeholders/nft-placeholder.jpg',
                        imageUrl: '/placeholders/nft-placeholder.jpg',
                        name: 'Demo NFT #1',
                        title: 'Demo NFT #1',
                        description: 'Demo listing for offline testing',
                        metadata: {
                            name: 'Demo NFT #1',
                            description: 'Demo listing for offline testing',
                            image: '/placeholders/nft-placeholder.jpg'
                        }
                    },
                    {
                        id: 2,
                        seller: "0x9876543210987654321098765432109876543210",
                        nftContract: "0xfedcbafedcbafedcbafedcbafedcbafedcbafed",
                        tokenId: "2",
                        quantity: "1", 
                        pricePerUnit: ethers.parseEther("2.0").toString(),
                        paymentToken: ethers.ZeroAddress,
                        isERC1155: false,
                        active: true,
                        image: '/placeholders/nft-placeholder.jpg',
                        imageUrl: '/placeholders/nft-placeholder.jpg',
                        name: 'Demo NFT #2',
                        title: 'Demo NFT #2',
                        description: 'Demo listing for offline testing',
                        metadata: {
                            name: 'Demo NFT #2',
                            description: 'Demo listing for offline testing',
                            image: '/placeholders/nft-placeholder.jpg'
                        }
                    }
                ];
                
                console.log("Using demo listings for offline testing");
                setListings(demoListings);
                setHotListings(demoListings);
                setStatus('Running in demo mode - showing sample listings');
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
            
            // Cache the fresh data
            if (supabaseConnected && res.length > 0) {
                try {
                    await cacheListings(res);
                    console.log(`✅ Cached ${res.length} listings to Supabase`);
                } catch (cacheError) {
                    console.warn("Failed to cache listings:", cacheError);
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

    // Load listings on initial load
    useEffect(() => {
        if (marketplace) {
            fetchListings();
            // Use a ref to keep track of the interval
            const intervalId = setInterval(fetchListings, 30000);
            return () => clearInterval(intervalId);
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