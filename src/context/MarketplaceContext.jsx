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
import { batchLoadMetadata } from '../utils/metadataLoader';

const MarketplaceContext = createContext();

export function MarketplaceProvider({ children, marketplaceAddress, abi }) {
    const { wallet, signer, provider } = useWallet();
    const {
        cacheListings,
        getCachedListings,
        validateListingAgainstBlockchain,
        cacheSalesHistory,
        getCachedSalesHistory,
        markListingAsSold,
        removeSoldListings,
        cleanupOrphanedListings,
        subscribeToListings,
        isConnected: supabaseConnected,
        supabase,
        clearCache
    } = useSupabase();
    const [marketplace, setMarketplace] = useState(null);
    const [listings, setListings] = useState([]);
    const [hotListings, setHotListings] = useState([]);
    const [status, setStatus] = useState('');
    const [persistentStatus, setPersistentStatus] = useState('');
    const [statusType, setStatusType] = useState('info');
    const [isInitialized, setIsInitialized] = useState(false);
    const isConnectedRef = useRef(false);
    const cacheUpdateInterval = useRef(null);

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

    const [isLoading, setIsLoading] = useState(false);
    const [lastCacheSignature, setLastCacheSignature] = useState(null);

    const setStatusWithType = (message, type = 'info', persistent = false) => {
        setStatus(message);
        setStatusType(type);
        if (persistent) setPersistentStatus(message);
    };
    const clearStatus = () => { setStatus(''); setStatusType('info'); };
    const clearPersistentStatus = () => { setPersistentStatus(''); };

    const hasLoadedInitialData = useRef(false);

    // ============================================================
    // HOISTED sync + listing functions (must be before any useEffect)
    // ============================================================
    async function triggerInstantSync(listingId = null) {
        try {
            debugLog(`🚀 Triggering instant sync${listingId ? ` for listing ${listingId}` : ''}...`);
            const res = await fetch('/api/instant-sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    listingId,
                    checkRecentBlocks: 50,
                    broadcastUpdate: true
                })
            });
            if (!res.ok) throw new Error(`Instant sync failed: ${res.status}`);
            await res.json();
            setTimeout(() => { fetchListings(false); }, 120);
        } catch (e) {
            debugWarn('Instant sync failed:', e.message);
        }
    }

    async function triggerManualSync() {
        try {
            debugLog('🔄 Triggering manual listings sync...');
            setStatus('Requesting fresh data sync...');
            const res = await fetch('/api/sync-listings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
            const result = await res.json();
            setStatus(`Sync completed: ${result.stats?.found || 0} found, ${result.stats?.cached || 0} cached`);
            setTimeout(async () => {
                await fetchListings(false);
                setStatus('');
            }, 2000);
        } catch (e) {
            debugWarn('Manual sync failed:', e.message);
            setStatus(`Sync failed: ${e.message}`);
            setTimeout(() => setStatus(''), 5000);
        }
    }

    async function fetchListings(forceRefresh = false) {
        if (isLoading) {
            debugLog('Fetch already in progress, skipping');
            return;
        }
        setIsLoading(true);
        setStatus('Loading listings...');
        debugLog(`fetchListings(forceRefresh=${forceRefresh}, supabaseConnected=${supabaseConnected})`);
        try {
            if (supabaseConnected && getCachedListings) {
                setStatus('Loading and validating listings against blockchain...');
                // CRITICAL FIX: Pass marketplace contract for blockchain validation
                const cached = await getCachedListings(marketplace);
                if (cached?.length) {
                    // CRITICAL FIX: Load metadata for all listings using batchLoadMetadata
                    setStatus('Loading NFT metadata from blockchain...');
                    debugLog(`📋 Loading metadata for ${cached.length} listings using batchLoadMetadata...`);
                    
                    // Prepare NFT objects for batch metadata loading
                    const nftsForMetadata = cached.map(listing => ({
                        contractAddress: listing.nftContract,
                        tokenId: listing.tokenId,
                        metadata: listing.metadata, // Pass existing metadata if any
                        id: listing.id
                    }));
                    
                    // Load metadata for all NFTs in parallel using batchLoadMetadata
                    let nftsWithMetadata = [];
                    try {
                        if (provider) {
                            nftsWithMetadata = await batchLoadMetadata(nftsForMetadata, provider, 15);
                            debugLog(`✅ Successfully loaded metadata for ${nftsWithMetadata.length} NFTs`);
                        } else {
                            debugWarn('Provider not available, skipping metadata loading');
                            nftsWithMetadata = nftsForMetadata.map(nft => ({
                                ...nft,
                                metadata: normalizeNFTMetadata(nft.metadata, nft.contractAddress, nft.tokenId)
                            }));
                        }
                    } catch (metadataError) {
                        debugWarn('Failed to load metadata with batchLoadMetadata, falling back to normalization:', metadataError);
                        nftsWithMetadata = nftsForMetadata.map(nft => ({
                            ...nft,
                            metadata: normalizeNFTMetadata(nft.metadata, nft.contractAddress, nft.tokenId)
                        }));
                    }
                    
                    // Merge the loaded metadata back into the listings
                    const processed = cached.map(listing => {
                        // Use contractAddress + tokenId for more reliable matching instead of ID
                        const nftWithMetadata = nftsWithMetadata.find(nft => 
                            nft.contractAddress && listing.nftContract &&
                            nft.contractAddress.toLowerCase() === listing.nftContract.toLowerCase() &&
                            String(nft.tokenId) === String(listing.tokenId)
                        );
                        
                        if (!nftWithMetadata) {
                            debugWarn(`❌ No metadata match found for ${listing.nftContract}:${listing.tokenId}, falling back to normalization`);
                        }
                        
                        const metadata = nftWithMetadata?.metadata || normalizeNFTMetadata(listing.metadata, listing.nftContract, listing.tokenId);
                        
                        return {
                            ...listing,
                            metadata: metadata,
                            image: metadata.image || listing.image,
                            imageUrl: metadata.imageUrl || listing.imageUrl || metadata.image,
                            name: metadata.name || listing.name,
                            description: metadata.description || listing.description
                        };
                    });
                    
                    setListings(processed);
                    setHotListings(processed.slice(0, 5));
                    setStatus(`${processed.length} listings loaded with metadata from blockchain`);
                    setTimeout(() => setStatus(''), 2500);
                } else {
                    setListings([]);
                    setHotListings([]);
                    setStatus('No valid listings available (blockchain verified)');
                }
                if (forceRefresh) await triggerManualSync();
            } else {
                debugWarn('Supabase not connected - listings unavailable');
                setListings([]);
                setHotListings([]);
                setStatus('Supabase not connected - no listings');
                setTimeout(() => setStatus(''), 4000);
            }
        } catch (e) {
            criticalError('Error loading listings:', e);
            setStatus('Failed to load listings');
            setListings([]);
            setHotListings([]);
        } finally {
            setIsLoading(false);
        }
    }
    // ============================================================


    
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
                    
                    // Test network connectivity and set up instant event listeners
                    try {
                        await provider.getNetwork();
                        // PRODUCTION: Enable real-time event listeners for instant updates
                        setupEventListeners(contract);
                        debugLog("✅ Real-time blockchain event listeners enabled for instant updates");
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
        // Set up Supabase real-time subscriptions for instant updates
        if (supabaseConnected && subscribeToListings) {
            debugLog("🔄 Setting up Supabase real-time subscriptions for instant listing updates...");
            
            const unsubscribe = subscribeToListings((payload) => {
                debugLog("📡 Real-time listing update received:", payload);
                
                // Immediately refresh listings on any database change
                fetchListings(false);
                
                // Show status update
                setStatusWithType("Listings updated instantly via real-time sync", 'success');
                setTimeout(() => clearStatus(), 3000);
            });

            return () => {
                if (unsubscribe) {
                    debugLog("🔌 Unsubscribing from real-time listing updates");
                    unsubscribe.unsubscribe?.();
                }
                if (cacheUpdateInterval.current) {
                    clearInterval(cacheUpdateInterval.current);
                }
            };
        }
        
        return () => {
            if (cacheUpdateInterval.current) {
                clearInterval(cacheUpdateInterval.current);
            }
        };
    }, [supabaseConnected, subscribeToListings, fetchListings, setStatusWithType, clearStatus]);

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
            const fromBlock = Math.max(currentBlock - 100000, lastScannedBlock); // Extended to last 100k blocks for better test sales coverage
            
            debugLog(`🔍 CONSERVATIVE BLOCKCHAIN SCAN: Recent blocks only from ${fromBlock} to ${currentBlock}`);
            debugLog(`⚡ Limiting scan to recent 100k blocks to prevent mass data collection`);
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
                    
                    // Immediately trigger instant sync for the sold listing
                    debugLog(`⚡ Purchase detected - triggering instant sync for listing ${listingId.toString()}...`);
                    try {
                        await triggerInstantSync(listingId.toString());
                        debugLog(`✅ Instant sync completed for sold listing ${listingId.toString()}`);
                        
                        setStatusWithType(`Listing #${listingId.toString()} sold and updated instantly!`, 'success');
                        setTimeout(() => clearStatus(), 3000);
                    } catch (syncError) {
                        debugWarn("Failed to instant sync after purchase:", syncError);
                        // Fallback to marking inactive locally
                        markListingInactive(listingId.toString());
                    }
                    
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
                    
                    // Still try instant sync on error
                    try {
                        await triggerInstantSync(listingId.toString());
                    } catch {
                        markListingInactive(listingId.toString());
                    }
                }
            });

            // Listen for canceled listings
            contract.on("ListingCanceled", (listingId) => {
                debugLog("Listing Canceled event:", { listingId });
                setCanceledListings(prev => new Set([...prev, listingId.toString()]));
            });

            // Listen for new listings
            contract.on("ListingCreated", async (listingId, seller, nftContract, tokenId, quantity, pricePerUnit, paymentToken, isERC1155) => {
                debugLog("New listing created:", { listingId, seller, nftContract });
                
                // Immediately trigger instant sync for the new listing
                debugLog("⚡ New listing detected - triggering instant sync...");
                try {
                    const id = listingId.toString();
                    await triggerInstantSync(id);
                    debugLog(`✅ Instant sync completed for new listing ${id}`);
                    
                    setStatusWithType(`New listing #${id} created and synced instantly!`, 'success');
                    setTimeout(() => clearStatus(), 3000);
                } catch (syncError) {
                    debugWarn("Failed to instant sync after new listing creation:", syncError);
                    // Fallback to regular refresh
                    setTimeout(fetchListings, 1000);
                }
            });

            // CRITICAL FIX: Listen for listing price updates to prevent stale Supabase cache
            contract.on("ListingUpdated", async (listingId, newPricePerUnit, event) => {
                debugLog("🔄 Listing price updated on blockchain:", { listingId: listingId.toString(), newPricePerUnit: newPricePerUnit.toString() });
                
                try {
                    const id = listingId.toString();
                    const newPrice = newPricePerUnit.toString();
                    
                    // IMMEDIATE: Update Supabase cache with new price to prevent stale data
                    if (supabaseConnected && supabase) {
                        debugLog(`💾 CRITICAL: Immediately updating Supabase cache for listing ${id} with new price ${ethers.formatEther(newPrice)} VTRU`);
                        
                        try {
                            const { error } = await supabase
                                .from('marketplace_listings')
                                .update({ 
                                    price_per_unit: newPrice,
                                    updated_at: new Date().toISOString()
                                })
                                .eq('listing_id', id);
                                
                            if (error) {
                                debugWarn(`❌ Failed to update Supabase cache for listing ${id}:`, error);
                            } else {
                                debugLog(`✅ Successfully updated Supabase cache for listing ${id} with new price`);
                            }
                        } catch (cacheError) {
                            debugWarn(`❌ Error updating Supabase cache for listing ${id}:`, cacheError);
                        }
                    }
                    
                    // IMMEDIATE: Update local listings state to reflect new price
                    setListings(prevListings => 
                        prevListings.map(listing => 
                            listing.id.toString() === id 
                                ? { ...listing, pricePerUnit: newPrice }
                                : listing
                        )
                    );
                    
                    // IMMEDIATE: Update hot listings state if this listing is in hot listings
                    setHotListings(prevHotListings => 
                        prevHotListings.map(listing => 
                            listing.id.toString() === id 
                                ? { ...listing, pricePerUnit: newPrice }
                                : listing
                        )
                    );
                    
                    // IMMEDIATE: Clear cache for this specific listing to force fresh load
                    if (clearCache) {
                        clearCache(`listing:${id}`);
                        clearCache('all_listings');
                    }
                    
                    // Trigger instant sync as backup to ensure everything is synchronized
                    debugLog(`⚡ Price update detected - triggering instant sync for listing ${id}...`);
                    try {
                        await triggerInstantSync(id);
                        debugLog(`✅ Instant sync completed after price update for listing ${id}`);
                        
                        setStatusWithType(`Listing #${id} price updated and synced instantly!`, 'success');
                        setTimeout(() => clearStatus(), 3000);
                    } catch (syncError) {
                        debugWarn("Failed to instant sync after price update:", syncError);
                        // Price was still updated in cache and local state, so this is non-critical
                    }
                    
                } catch (error) {
                    criticalError("Error processing ListingUpdated event:", error);
                    // Fallback: refresh all listings to eventually get the updated price
                    setTimeout(() => fetchListings(false), 2000);
                }
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
            // Debug current state before calculation
            debugLog("Calculating marketplace stats with data:", {
                salesHistoryLength: salesHistory.length,
                listingsLength: listings.length,
                canceledListingsSize: canceledListings.size,
                hasProvider: !!provider
            });
            
            // Test network connectivity
            try {
                await provider.getNetwork();
            } catch (networkError) {
                debugWarn("Network issue - calculating stats with fallback values");
                debugLog("Using fallback calculation for", salesHistory.length, "sales");
                
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

                debugLog("Fallback stats calculation complete:", {
                    totalSales: salesHistory.length,
                    totalNativeVolume,
                    transactionHistoryLength: transactionHistory.length,
                    volume24h,
                    sales24h
                });

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
            let sales24h = 0, sales7d = 0, sales30h = 0;
            
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

            debugLog("USDC stats calculation complete:", {
                totalSales: salesHistory.length,
                actualSoldVolumeUSDC,
                currentListingVolumeUSDC,
                transactionHistoryLength: transactionHistory.length,
                volume24hUSDC,
                sales24h
            });

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
        
        // CRITICAL: Mark the listing as sold in database - this must succeed for production
        let databaseUpdateSuccess = false;
        
        if (markListingAsSold) {
            try {
                debugLog(`🔄 CRITICAL: Marking listing ${id} as sold in database...`);
                databaseUpdateSuccess = await markListingAsSold(id, tx.hash);
                
                if (databaseUpdateSuccess) {
                    debugLog(`✅ Successfully marked listing ${id} as sold in database`);
                } else {
                    throw new Error('markListingAsSold returned false');
                }
                
            } catch (dbError) {
                debugWarn(`❌ CRITICAL: Failed to update listing status in database:`, dbError);
                
                // FALLBACK: Use instant-sync API as backup method
                debugLog(`🆘 Attempting fallback via instant-sync API for listing ${id}...`);
                try {
                    await triggerInstantSync(id);
                    debugLog(`✅ Fallback instant sync completed for listing ${id}`);
                    databaseUpdateSuccess = true; // Consider it successful if instant sync worked
                } catch (syncError) {
                    debugWarn(`❌ CRITICAL: Fallback instant sync also failed:`, syncError);
                    // This is a critical failure - the listing won't be marked as sold
                    setStatus(`⚠️ Purchase successful but listing may still appear active. Please refresh in a few minutes.`);
                }
            }
        }
        
        // Additional instant sync for real-time updates (only if primary database update succeeded)
        if (databaseUpdateSuccess) {
            try {
                debugLog(`⚡ Triggering additional instant sync for real-time updates...`);
                await triggerInstantSync(id);
                debugLog(`✅ Additional instant sync completed`);
            } catch (syncError) {
                debugWarn(`⚠️ Additional instant sync failed (non-critical):`, syncError);
                // Non-critical - the listing is already marked as sold
            }
        }
        
        // Mark the listing as inactive locally for instant UI update
        markListingInactive(id);

        setStatus('Purchase successful! Database and UI updated instantly...');
        
        // Additional refresh to ensure data consistency
        setTimeout(() => {
            if (supabaseConnected && cacheListings) {
                fetchListings(true);
            } else {
                fetchListings();
            }
        }, 500);

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
      
      // CRITICAL: Mark the listing as sold in database - this must succeed for production
      let databaseUpdateSuccess = false;
      
      if (markListingAsSold) {
        try {
          debugLog(`🔄 CRITICAL: Marking listing ${id} as sold in database...`);
          databaseUpdateSuccess = await markListingAsSold(id, tx.hash);
          
          if (databaseUpdateSuccess) {
            debugLog(`✅ Successfully marked listing ${id} as sold in database`);
          } else {
            throw new Error('markListingAsSold returned false');
          }
          
        } catch (dbError) {
          debugWarn(`❌ CRITICAL: Failed to update listing status in database:`, dbError);
          
          // FALLBACK: Use instant-sync API as backup method
          debugLog(`🆘 Attempting fallback via instant-sync API for listing ${id}...`);
          try {
            await triggerInstantSync(id);
            debugLog(`✅ Fallback instant sync completed for listing ${id}`);
            databaseUpdateSuccess = true; // Consider it successful if instant sync worked
          } catch (syncError) {
            debugWarn(`❌ CRITICAL: Fallback instant sync also failed:`, syncError);
            // This is a critical failure - the listing won't be marked as sold
            setStatus(`⚠️ Purchase successful but listing may still appear active. Please refresh in a few minutes.`);
          }
        }
      }
      
      // Additional instant sync for real-time updates (only if primary database update succeeded)
      if (databaseUpdateSuccess) {
        try {
          debugLog(`⚡ Triggering additional instant sync for real-time updates...`);
          await triggerInstantSync(id);
          debugLog(`✅ Additional instant sync completed`);
        } catch (syncError) {
          debugWarn(`⚠️ Additional instant sync failed (non-critical):`, syncError);
          // Non-critical - the listing is already marked as sold
        }
      }
      
      // Mark the listing as inactive locally for instant UI update
      markListingInactive(id);

      setStatus('Purchase successful! Database and UI updated instantly...');
      
      // Additional refresh to ensure data consistency
      setTimeout(() => {
        if (supabaseConnected && cacheListings) {
          fetchListings(true);
        } else {
          fetchListings();
        }
      }, 500);

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

            // Check for duplicate listings - prevent listing the same NFT multiple times
            setStatus("Checking for existing listings...");
            debugLog("Checking if NFT is already listed:", { nftContract, tokenId });
            
            const existingListing = listings.find(listing => 
                listing.nftContract && 
                listing.tokenId &&
                listing.nftContract.toLowerCase() === nftContract.toLowerCase() && 
                listing.tokenId.toString() === tokenId.toString() &&
                listing.active !== false
            );
            
            if (existingListing) {
                const errorMessage = `This NFT (${nftContract.slice(0, 6)}...${nftContract.slice(-4)}:${tokenId}) is already listed on the marketplace.`;
                setStatus(`Error: ${errorMessage}`);
                debugWarn("Duplicate listing prevented:", { existingListing, nftContract, tokenId });
                throw new Error(errorMessage);
            }
            
            debugLog("✅ No existing listing found, proceeding with creation");

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

            // Immediately trigger instant sync to pick up the new listing
            if (supabaseConnected && triggerInstantSync) {
                debugLog("⚡ Immediately triggering instant sync for new listing...");
                setTimeout(async () => {
                    try {
                        // Use instant sync to detect and cache the new listing
                        await triggerInstantSync();
                        debugLog("✅ Instant sync completed - new listing should be available immediately");
                        
                        // Refresh UI to show the new listing
                        await fetchListings(false);
                        
                    } catch (syncError) {
                        debugWarn("⚠️ Instant sync failed, falling back to manual sync:", syncError);
                        // Fallback to manual sync
                        try {
                            if (triggerManualSync) {
                                await triggerManualSync();
                            }
                            await fetchListings(true);
                        } catch (fallbackError) {
                            debugWarn("⚠️ Fallback sync also failed:", fallbackError);
                            // Final fallback to regular refresh
                            await fetchListings();
                        }
                    }
                }, 100);
            } else {
                // Refresh listings normally if Supabase not available
                setTimeout(() => {
                    fetchListings();
                }, 500);
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

    // Periodic cleanup for production reliability
    useEffect(() => {
        if (!supabaseConnected || !cleanupOrphanedListings) return;

        // Run initial cleanup after 30 seconds
        const initialCleanup = setTimeout(async () => {
            try {
                debugLog('🧹 Running initial orphaned listings cleanup...');
                const result = await cleanupOrphanedListings();
                if (result.cleaned > 0) {
                    debugLog(`✅ Initial cleanup: fixed ${result.cleaned} orphaned listings`);
                    // Refresh listings if we cleaned anything
                    setTimeout(() => fetchListings(false), 1000);
                }
                if (result.errors.length > 0) {
                    debugWarn(`⚠️ Initial cleanup errors:`, result.errors);
                }
            } catch (error) {
                debugWarn('Initial cleanup failed:', error);
            }
        }, 30000);

        // Run periodic cleanup every 5 minutes
        const cleanupInterval = setInterval(async () => {
            try {
                debugLog('🧹 Running periodic orphaned listings cleanup...');
                const result = await cleanupOrphanedListings();
                if (result.cleaned > 0) {
                    debugLog(`✅ Periodic cleanup: fixed ${result.cleaned} orphaned listings`);
                    // Refresh listings if we cleaned anything
                    setTimeout(() => fetchListings(false), 1000);
                }
                if (result.errors.length > 0) {
                    debugWarn(`⚠️ Periodic cleanup errors:`, result.errors);
                }
            } catch (error) {
                debugWarn('Periodic cleanup failed:', error);
            }
        }, 5 * 60 * 1000); // 5 minutes

        return () => {
            clearTimeout(initialCleanup);
            clearInterval(cleanupInterval);
        };
    }, [supabaseConnected, cleanupOrphanedListings, fetchListings]);

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

    // Reset token allowance function
const resetTokenAllowance = useCallback(
  async (tokenAddress, spender, customSetStatus) => {
    if (!signer) {
      (customSetStatus || setStatusWithType)('Wallet not connected', 'error');
      return false;
    }
    try {
      const token = new ethers.Contract(
        tokenAddress,
        [
          'function symbol() view returns (string)',
          'function approve(address,uint256) returns (bool)'
        ],
        signer
      );
      const symbol = await token.symbol().catch(() => 'TOKEN');

      (customSetStatus || setStatusWithType)(`Resetting ${symbol} allowance to 0…`);
      const tx1 = await token.approve(spender, 0);
      await tx1.wait();

      (customSetStatus || setStatusWithType)(`Approving max ${symbol} allowance…`);
      const tx2 = await token.approve(spender, ethers.MaxUint256);
      await tx2.wait();

      (customSetStatus || setStatusWithType)(`${symbol} allowance refreshed`, 'success');
      return true;
    } catch (e) {
      (customSetStatus || setStatusWithType)(`Allowance reset failed: ${e.message}`, 'error');
      return false;
    }
  },
  [signer]
);

const updateListingPrice = async (listingId, newPricePerUnit) => {
    if (!signer) {
        setStatusWithType('Error: Wallet not connected', 'error');
        return false;
    }
    
    if (!marketplace) {
        setStatusWithType('Error: Marketplace contract not initialized', 'error');
        return false;
    }

    try {
        setStatusWithType('Updating listing price...', 'info');
        
        // Convert price to wei
        const priceInWei = ethers.parseEther(newPricePerUnit.toString());
        
        // CRITICAL FIX: Connect the marketplace contract to the signer before calling the function
        const marketplaceWithSigner = marketplace.connect(signer);
        
        // Call the contract's updateListingPrice function with proper signer
        const tx = await marketplaceWithSigner.updateListingPrice(listingId, priceInWei);
        
        setStatusWithType('Confirming price update transaction...', 'info');
        const receipt = await tx.wait();
        
        // CRITICAL: Immediately update Supabase cache to prevent stale data
        if (supabaseConnected && supabase) {
            debugLog(`💾 CRITICAL: Force updating Supabase cache for listing ${listingId} with new price ${newPricePerUnit} VTRU`);
            
            try {
                const { error } = await supabase
                    .from('marketplace_listings')
                    .update({ 
                        price_per_unit: priceInWei.toString(),
                        updated_at: new Date().toISOString()
                    })
                    .eq('listing_id', listingId.toString());
                    
                if (error) {
                    debugWarn(`❌ Failed to force update Supabase cache for listing ${listingId}:`, error);
                } else {
                    debugLog(`✅ Successfully force updated Supabase cache for listing ${listingId}`);
                }
            } catch (cacheError) {
                debugWarn(`❌ Error force updating Supabase cache for listing ${listingId}:`, cacheError);
            }
        }
        
        // CRITICAL: Clear relevant cache entries to force fresh data
        if (clearCache) {
            clearCache(`listing:${listingId}`);
            clearCache('all_listings');
            debugLog(`🧹 Cleared cache entries for listing ${listingId}`);
        }
        
        setStatusWithType('Price updated successfully! Syncing with database...', 'success');
        
        // CRITICAL: Force instant sync to ensure database consistency
        try {
            debugLog(`⚡ Triggering instant sync after manual price update for listing ${listingId}...`);
            await triggerInstantSync(listingId.toString());
            debugLog(`✅ Instant sync completed after manual price update`);
        } catch (syncError) {
            debugWarn("Instant sync failed after price update (non-critical):", syncError);
        }
        
        // CRITICAL: Force complete listings refresh to show updated price everywhere
        await fetchListings(false);
        
        setStatusWithType('Listing price updated and synchronized!', 'success');
        setTimeout(() => clearStatus(), 3000);
        
        return true;
    } catch (error) {
        console.error('Error updating listing price:', error);
        const errorMessage = error?.reason || error?.message || 'Unknown error occurred';
        setStatusWithType(`Failed to update price: ${errorMessage}`, 'error');
        return false;
    }
};

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
            updateListingPrice,
            isInitialized,
            isLoading,
            markListingInactive,
            salesHistory,
            canceledListings,
            marketplaceStats,
            calculateMarketplaceStats,
            triggerManualSync,
            resetTokenAllowance, // <-- added
            ensureAllowanceWithBuffer // <-- added for auction bidding
        }}>
            {children}
        </MarketplaceContext.Provider>
    );
}

export function useMarketplace() {
    return useContext(MarketplaceContext);
}