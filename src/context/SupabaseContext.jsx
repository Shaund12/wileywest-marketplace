import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';

const SupabaseContext = createContext();

// Cache configuration
const CACHE_CONFIG = {
    LISTINGS_TTL: 5 * 60 * 1000, // 5 minutes for listings
    PROFILE_TTL: 10 * 60 * 1000, // 10 minutes for profile data
    SALES_TTL: 60 * 60 * 1000,   // 1 hour for sales history
    MAX_CACHE_SIZE: 1000,        // Maximum number of cached items
};

export function SupabaseProvider({ children }) {
    const [supabase, setSupabase] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const [cacheStats, setCacheStats] = useState({
        hits: 0,
        misses: 0,
        updates: 0,
        errors: 0
    });

    // In-memory cache for frequently accessed data
    const cache = useRef(new Map());
    const subscriptions = useRef(new Map());

    // Initialize Supabase client
    useEffect(() => {
        try {
            const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
            const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

            if (supabaseUrl && supabaseKey && supabaseUrl !== 'https://dummy.supabase.co') {
                const client = createClient(supabaseUrl, supabaseKey);
                setSupabase(client);
                setIsConnected(true);
                debugLog('✅ Supabase client initialized for caching');

                // for quick console testing if you want:
                // @ts-ignore
                window.supabase = client;

                // Test the connection
                testSupabaseConnection(client);
            } else {
                debugLog('⚠️ Supabase not configured - running without cache');
                setIsConnected(false);
            }
        } catch (error) {
            debugWarn('❌ Supabase initialization failed:', error.message);
            setIsConnected(false);
        }
    }, []);

    // Test Supabase connection
    const testSupabaseConnection = async (client) => {
        try {
            const { error } = await client.from('marketplace_listings').select('id').limit(1);
            if (error) {
                debugWarn('⚠️ Supabase connection test failed:', error.message);
            }
        } catch (error) {
            debugWarn('⚠️ Supabase connection test error:', error.message);
        }
    };

    // Helper to ensure Supabase ready
    const ensureSupabaseReady = () =>
        new Promise((resolve) => {
            if (supabase && isConnected) return resolve(true);
            const checkReady = () => (supabase && isConnected ? resolve(true) : setTimeout(checkReady, 100));
            setTimeout(checkReady, 100);
        });

    // Cache utilities
    const getCacheKey = (type, id) => `${type}:${id}`;

    const isExpired = (item) => {
        if (!item.timestamp) return true;
        const now = Date.now();
        const ttl = CACHE_CONFIG[`${item.type.toUpperCase()}_TTL`] || CACHE_CONFIG.LISTINGS_TTL;
        return now - item.timestamp > ttl;
    };

    const updateCacheStats = (type) => {
        setCacheStats((prev) => ({ ...prev, [type]: prev[type] + 1 }));
    };

    const setCache = (key, data, type = 'listings') => {
        try {
            const cacheItem = { data, type, timestamp: Date.now() };
            cache.current.set(key, cacheItem);
            
            // Also persist to localStorage for auctions to survive page refresh
            if (type === 'auctions') {
                try {
                    localStorage.setItem(`cache_${key}`, JSON.stringify(cacheItem));
                } catch (e) {
                    debugWarn('localStorage error:', e);
                }
            }
            
            updateCacheStats('updates');
            if (cache.current.size > CACHE_CONFIG.MAX_CACHE_SIZE) {
                const oldestKey = cache.current.keys().next().value;
                cache.current.delete(oldestKey);
            }
            // debugLog(`📦 Cached ${type}:`, key);
        } catch (error) {
            debugWarn('Cache set error:', error);
            updateCacheStats('errors');
        }
    };

    const getCache = (key) => {
        try {
            // First check in-memory cache
            let item = cache.current.get(key);
            
            // If not in memory and it might be auction data, check localStorage
            if (!item && key.includes('auction')) {
                try {
                    const stored = localStorage.getItem(`cache_${key}`);
                    if (stored) {
                        item = JSON.parse(stored);
                        // Restore to in-memory cache
                        cache.current.set(key, item);
                    }
                } catch (e) {
                    debugWarn('localStorage retrieval error:', e);
                }
            }
            
            if (!item) {
                updateCacheStats('misses');
                return null;
            }
            if (isExpired(item)) {
                cache.current.delete(key);
                // Also remove from localStorage
                if (key.includes('auction')) {
                    try {
                        localStorage.removeItem(`cache_${key}`);
                    } catch (e) {
                        debugWarn('localStorage removal error:', e);
                    }
                }
                updateCacheStats('misses');
                return null;
            }
            updateCacheStats('hits');
            // debugLog(`🎯 Cache hit: ${key}`);
            return item.data;
        } catch (error) {
            debugWarn('Cache get error:', error);
            updateCacheStats('errors');
            return null;
        }
    };

    const clearCache = (pattern) => {
        try {
            if (pattern) {
                for (const key of cache.current.keys()) {
                    if (key.includes(pattern)) cache.current.delete(key);
                }
                debugLog(`🧹 Cleared cache pattern: ${pattern}`);
            } else {
                cache.current.clear();
                debugLog('🧹 Cleared all cache');
            }
        } catch (error) {
            debugWarn('Cache clear error:', error);
        }
    };

    // ========== LISTINGS CACHE (DB) ==========
    const cacheListings = useCallback(
        async (listings, canceledSet = new Set()) => {
            try {
                await ensureSupabaseReady();
                if (!supabase) {
                    debugLog('⚠️ Supabase not available - skipping listings cache');
                    return;
                }
                if (!Array.isArray(listings) || listings.length === 0) {
                    debugLog('⚠️ No listings to cache');
                    return;
                }

                const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
                const normAddr = (x) => (x ? String(x).toLowerCase() : null);
                const str = (x, d = '0') => (x === undefined || x === null ? d : String(x));

                const rows = listings.map((l) => {
                    const isCanceled = canceledSet?.has?.(String(l.id));
                    const img =
                        l.image ||
                        l.imageUrl ||
                        l.metadata?.image ||
                        l.metadata?.image_url ||
                        null;

                    return {
                        listing_id: str(l.id, '').trim(),
                        seller: normAddr(l.seller) || normAddr(l.owner) || ZERO_ADDR, // NOT NULL
                        nft_contract: normAddr(l.nftContract) || '',                  // NOT NULL
                        token_id: str(l.tokenId, '').trim(),                          // NOT NULL
                        quantity:
                            typeof l.quantity === 'bigint' ? l.quantity.toString() : str(l.quantity, '1'),
                        price_per_unit:
                            typeof l.pricePerUnit === 'bigint'
                                ? l.pricePerUnit.toString()
                                : str(l.pricePerUnit, '0'),
                        payment_token: normAddr(l.paymentToken) || ZERO_ADDR,         // NOT NULL
                        is_erc1155: !!l.isERC1155,
                        active: isCanceled ? false : !!l.active,
                        sale_status: isCanceled ? 'canceled' : (l.active === false ? 'sold' : 'active'),
                        sale_transaction_hash: l.saleTransactionHash || null,
                        metadata: l.metadata || {},
                        image_url: img,
                        name: l.name || l.title || l.metadata?.name || null,
                        description: l.description || l.metadata?.description || null,
                        updated_at: new Date().toISOString()
                    };
                });

                // Filter invalid rows to avoid NOT NULL violations
                const toSave = rows.filter(
                    (r) =>
                        r.listing_id &&
                        r.seller &&
                        r.nft_contract &&
                        r.token_id &&
                        r.quantity !== '' &&
                        r.price_per_unit !== '' &&
                        r.payment_token
                );

                if (toSave.length === 0) {
                    debugWarn('⚠️ No valid rows to upsert (required fields missing). Example:', rows[0]);
                    return;
                }

                debugLog(`💾 Upserting ${toSave.length} listings to Supabase...`);

                // Chunked upserts (avoid payload too large)
                const CHUNK = 500;
                for (let i = 0; i < toSave.length; i += CHUNK) {
                    const chunk = toSave.slice(i, i + CHUNK);
                    const { data, error } = await supabase
                        .from('marketplace_listings')
                        .upsert(chunk, { onConflict: 'listing_id', ignoreDuplicates: false });

                    if (error) {
                        debugWarn('❌ Database cache error:', error);
                        debugWarn('🔍 Error details:', {
                            message: error.message,
                            details: error.details,
                            hint: error.hint,
                            code: error.code
                        });
                        updateCacheStats('errors');
                    } else {
                        debugLog(`✅ Cached ${chunk.length} listings [${i + 1}-${i + chunk.length}]`);
                        // also cache in memory
                        chunk.forEach((dbRow) => {
                            const id = dbRow.listing_id;
                            const key = getCacheKey('listing', id);
                            setCache(key, dbRow, 'listings');
                        });
                    }
                }

                // maintain an in-memory "all" snapshot for quick reads
                setCache('all_listings', listings, 'listings');
            } catch (error) {
                debugWarn('❌ Error caching listings:', error);
                updateCacheStats('errors');
            }
        },
        [supabase]
    );

    const getCachedListings = useCallback(async () => {
        if (!supabase) {
            const cachedData = getCache('all_listings');
            return cachedData || [];
        }

        try {
            const { data, error } = await supabase
                .from('marketplace_listings')
                .select('*')
                .eq('active', true)
                .order('updated_at', { ascending: false });

            if (error) {
                debugWarn('Error fetching cached listings:', error);
                updateCacheStats('errors');
                return [];
            }

            const listings = data.map((item) => ({
                id: Number(item.listing_id),
                seller: item.seller,
                nftContract: item.nft_contract,
                tokenId: item.token_id,
                quantity: item.quantity,
                pricePerUnit: item.price_per_unit,
                paymentToken: item.payment_token,
                isERC1155: item.is_erc1155,
                active: item.active,
                saleStatus: item.sale_status,
                saleTransactionHash: item.sale_transaction_hash,
                metadata: item.metadata || {},
                image: item.image_url,
                imageUrl: item.image_url,
                name: item.name,
                title: item.name,
                description: item.description
            }));

            setCache('all_listings', listings, 'listings');
            return listings;
        } catch (error) {
            debugWarn('Error retrieving cached listings:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase]);

    // ========== PROFILE CACHE ==========
    const cacheProfileData = useCallback(
        async (address, profileData) => {
            if (!supabase || !address) return;
            try {
                debugLog(`💾 Caching profile data for ${address}...`);
                const profileRecord = {
                    wallet_address: String(address).toLowerCase(),
                    nfts: profileData.nfts || [],
                    listings: profileData.listings || [],
                    balance: profileData.balance || '0',
                    updated_at: new Date().toISOString()
                };

                const { error } = await supabase
                    .from('user_profiles')
                    .upsert(profileRecord, { onConflict: 'wallet_address', ignoreDuplicates: false });

                if (error) {
                    debugWarn('Profile cache error:', error);
                    updateCacheStats('errors');
                } else {
                    debugLog(`✅ Cached profile for ${address}`);
                    const key = getCacheKey('profile', String(address).toLowerCase());
                    setCache(key, profileData, 'profile');
                }
            } catch (error) {
                debugWarn('Error caching profile:', error);
                updateCacheStats('errors');
            }
        },
        [supabase]
    );

    const getCachedProfile = useCallback(
        async (address) => {
            if (!address) return null;
            const memKey = getCacheKey('profile', String(address).toLowerCase());
            const mem = getCache(memKey);
            if (mem) return mem;

            if (!supabase) return null;

            try {
                debugLog(`🔍 Fetching cached profile for ${address}...`);
                const { data, error } = await supabase
                    .from('user_profiles')
                    .select('*')
                    .eq('wallet_address', String(address).toLowerCase())
                    .maybeSingle();

                if (error) {
                    debugWarn('Error fetching cached profile:', error);
                    updateCacheStats('misses');
                    return null;
                }
                if (!data) {
                    debugLog(`📭 No cached profile found for ${address}`);
                    updateCacheStats('misses');
                    return null;
                }

                const profileData = {
                    nfts: data.nfts || [],
                    listings: data.listings || [],
                    balance: data.balance || '0'
                };
                setCache(memKey, profileData, 'profile');
                debugLog(`📦 Retrieved cached profile for ${address}`);
                return profileData;
            } catch (error) {
                debugWarn('Error retrieving cached profile:', error);
                updateCacheStats('errors');
                return null;
            }
        },
        [supabase]
    );

    // ========== ENHANCED SALE EVENT TRACKING ==========
    
    // Comprehensive sale event recording with all analytics updates
    const recordSaleEvent = useCallback(
        async (saleData) => {
            if (!supabase || !saleData) {
                debugLog('⚠️ Supabase not available or no sale data provided');
                return false;
            }

            try {
                debugLog(`🔄 Recording comprehensive sale event for listing ${saleData.listingId}...`);

                const timestamp = Date.now();
                const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

                // Prepare sale breakdown data for analytics
                const saleBreakdown = {
                    listing_id: String(saleData.listingId),
                    platform_fee: saleData.platformFee || '0',
                    royalty: saleData.royalty || '0', 
                    proceeds: saleData.proceeds || saleData.totalPrice || '0',
                    vibe_amount: saleData.vibeAmount || '0',
                    vibe_portion_in_payment: saleData.vibePortionInPayment || null,
                    token_address: saleData.paymentToken || '0x0000000000000000000000000000000000000000',
                    from_address: saleData.buyer || '0x0000000000000000000000000000000000000000',
                    to_address: saleData.seller || '0x0000000000000000000000000000000000000000',
                    transaction_hash: saleData.transactionHash || '',
                    block_number: saleData.blockNumber || 0,
                    log_index: saleData.logIndex || 0,
                    timestamp: Math.floor(timestamp / 1000),
                    transfer_type: saleData.transferType || 'sale',
                    is_vibe_fee: false,
                    fee_source: 'marketplace_sale'
                };

                // Start transaction-like operations (Supabase doesn't support full transactions via JS client)
                const updates = [];

                // 1. Mark listing as sold
                const listingUpdate = supabase
                    .from('marketplace_listings')
                    .update({
                        active: false,
                        sale_status: 'sold',
                        sale_transaction_hash: saleData.transactionHash,
                        updated_at: new Date().toISOString()
                    })
                    .eq('listing_id', String(saleData.listingId));

                updates.push(listingUpdate);

                // 2. Record sale breakdown for analytics
                const saleBreakdownInsert = supabase
                    .from('sale_breakdowns')
                    .upsert(saleBreakdown, { 
                        onConflict: 'transaction_hash,log_index',
                        ignoreDuplicates: false 
                    });

                updates.push(saleBreakdownInsert);

                // 3. Record sale in sales history
                const saleHistoryRecord = {
                    listing_id: String(saleData.listingId),
                    buyer: saleData.buyer,
                    seller: saleData.seller,
                    quantity: String(saleData.quantity || '1'),
                    total_price: String(saleData.totalPrice || '0'),
                    payment_token: saleData.paymentToken || '0x0000000000000000000000000000000000000000',
                    transaction_hash: saleData.transactionHash,
                    block_number: saleData.blockNumber || null,
                    timestamp: Math.floor(timestamp / 1000),
                    sale_type: 'sale'
                };

                const salesHistoryInsert = supabase
                    .from('sales_history')
                    .upsert(saleHistoryRecord, {
                        onConflict: 'transaction_hash',
                        ignoreDuplicates: true
                    });

                updates.push(salesHistoryInsert);

                // 4. Update collection stats (if collection address available)
                if (saleData.nftContract) {
                    const collectionStatsUpsert = supabase
                        .from('collection_stats')
                        .upsert({
                            collection_address: saleData.nftContract.toLowerCase(),
                            date: currentDate,
                            platform_fees: saleData.platformFee || '0',
                            royalties_paid: saleData.royalty || '0',
                            sales_count: 1,
                            updated_at: new Date().toISOString()
                        }, {
                            onConflict: 'collection_address,date',
                            ignoreDuplicates: false
                        });

                    updates.push(collectionStatsUpsert);
                }

                // 5. Update token fee stats (if non-native payment token)
                if (saleData.paymentToken && saleData.paymentToken !== '0x0000000000000000000000000000000000000000') {
                    const tokenStatsUpsert = supabase
                        .from('token_fee_stats')
                        .upsert({
                            token_address: saleData.paymentToken.toLowerCase(),
                            date: currentDate,
                            total_amount_in: saleData.totalPrice || '0',
                            total_wvtru_out: saleData.vibeAmount || '0',
                            conversion_count: 1,
                            updated_at: new Date().toISOString()
                        }, {
                            onConflict: 'token_address,date',
                            ignoreDuplicates: false
                        });

                    updates.push(tokenStatsUpsert);
                }

                // Execute all updates concurrently for performance
                debugLog(`📊 Executing ${updates.length} analytics updates concurrently...`);
                const results = await Promise.allSettled(updates);

                // Check results and log any errors
                let successCount = 0;
                let errorCount = 0;

                results.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        if (result.value.error) {
                            debugWarn(`❌ Update ${index + 1} failed:`, result.value.error);
                            errorCount++;
                        } else {
                            successCount++;
                        }
                    } else {
                        debugWarn(`❌ Update ${index + 1} rejected:`, result.reason);
                        errorCount++;
                    }
                });

                debugLog(`✅ Sale event recording completed: ${successCount} successful, ${errorCount} failed`);

                // Update in-memory cache
                const key = getCacheKey('listing', saleData.listingId);
                cache.current.delete(key);
                cache.current.delete('all_listings');
                cache.current.delete('sales_history');

                updateCacheStats('updates');
                
                return successCount > 0; // Return true if at least some updates succeeded

            } catch (error) {
                debugWarn(`❌ Error in recordSaleEvent for listing ${saleData.listingId}:`, error);
                updateCacheStats('errors');
                return false;
            }
        },
        [supabase]
    );

    // Fast listing status update (optimized for speed)
    const markListingAsSold = useCallback(
        async (listingId, transactionHash = null) => {
            if (!supabase || !listingId) {
                debugLog('⚠️ Supabase not available or no listing ID provided');
                return false;
            }

            try {
                debugLog(`🔄 Fast marking listing ${listingId} as sold...`);

                const updateData = {
                    active: false,
                    sale_status: 'sold',
                    updated_at: new Date().toISOString()
                };

                if (transactionHash) {
                    updateData.sale_transaction_hash = transactionHash;
                }

                // Use parallel update with optimistic cache invalidation
                const updatePromise = supabase
                    .from('marketplace_listings')
                    .update(updateData)
                    .eq('listing_id', String(listingId))
                    .select();

                // Immediately update cache (optimistic update)
                const key = getCacheKey('listing', listingId);
                cache.current.delete(key);
                cache.current.delete('all_listings');

                const { data, error } = await updatePromise;

                if (error) {
                    debugWarn(`❌ Error marking listing ${listingId} as sold:`, error);
                    updateCacheStats('errors');
                    return false;
                } else {
                    debugLog(`✅ Successfully marked listing ${listingId} as sold in database`);
                    updateCacheStats('updates');
                    return true;
                }

            } catch (error) {
                debugWarn(`❌ Error in markListingAsSold for listing ${listingId}:`, error);
                updateCacheStats('errors');
                return false;
            }
        },
        [supabase]
    );

    // ========== BATCH OPERATIONS FOR PERFORMANCE ==========
    
    // Batch update multiple listings (for bulk operations)
    const batchUpdateListingStatus = useCallback(
        async (listingUpdates) => {
            if (!supabase || !Array.isArray(listingUpdates) || listingUpdates.length === 0) {
                return false;
            }

            try {
                debugLog(`🔄 Batch updating ${listingUpdates.length} listing statuses...`);

                const updatePromises = listingUpdates.map(update => 
                    supabase
                        .from('marketplace_listings')
                        .update({
                            active: update.active,
                            sale_status: update.status,
                            sale_transaction_hash: update.transactionHash || null,
                            updated_at: new Date().toISOString()
                        })
                        .eq('listing_id', String(update.listingId))
                );

                const results = await Promise.allSettled(updatePromises);
                const successCount = results.filter(r => r.status === 'fulfilled' && !r.value.error).length;

                debugLog(`✅ Batch update completed: ${successCount}/${listingUpdates.length} successful`);

                // Clear relevant cache entries
                listingUpdates.forEach(update => {
                    const key = getCacheKey('listing', update.listingId);
                    cache.current.delete(key);
                });
                cache.current.delete('all_listings');

                return successCount > 0;

            } catch (error) {
                debugWarn('❌ Error in batch listing status update:', error);
                return false;
            }
        },
        [supabase]
    );

    // Update collection statistics in real-time
    const updateCollectionStats = useCallback(
        async (collectionAddress, saleData) => {
            if (!supabase || !collectionAddress) return false;

            try {
                const currentDate = new Date().toISOString().split('T')[0];
                
                // Use Supabase's built-in increment functionality for atomic updates
                const { error } = await supabase.rpc('increment_collection_stats', {
                    p_collection_address: collectionAddress.toLowerCase(),
                    p_date: currentDate,
                    p_platform_fee: saleData.platformFee || '0',
                    p_royalty: saleData.royalty || '0',
                    p_sales_increment: 1
                });

                if (error) {
                    debugWarn('Collection stats update error:', error);
                    // Fallback to upsert if RPC function doesn't exist
                    return await fallbackCollectionStatsUpdate(collectionAddress, saleData);
                }

                debugLog(`✅ Updated collection stats for ${collectionAddress}`);
                return true;

            } catch (error) {
                debugWarn('Error updating collection stats:', error);
                return false;
            }
        },
        [supabase]
    );

    // Fallback collection stats update using upsert
    const fallbackCollectionStatsUpdate = async (collectionAddress, saleData) => {
        try {
            const currentDate = new Date().toISOString().split('T')[0];
            
            // Get existing stats
            const { data: existing } = await supabase
                .from('collection_stats')
                .select('*')
                .eq('collection_address', collectionAddress.toLowerCase())
                .eq('date', currentDate)
                .maybeSingle();

            const newStats = {
                collection_address: collectionAddress.toLowerCase(),
                date: currentDate,
                platform_fees: existing 
                    ? String(BigInt(existing.platform_fees) + BigInt(saleData.platformFee || '0'))
                    : saleData.platformFee || '0',
                royalties_paid: existing
                    ? String(BigInt(existing.royalties_paid) + BigInt(saleData.royalty || '0'))
                    : saleData.royalty || '0',
                sales_count: (existing?.sales_count || 0) + 1,
                updated_at: new Date().toISOString()
            };

            const { error } = await supabase
                .from('collection_stats')
                .upsert(newStats, {
                    onConflict: 'collection_address,date',
                    ignoreDuplicates: false
                });

            if (error) {
                debugWarn('Fallback collection stats error:', error);
                return false;
            }

            return true;
        } catch (error) {
            debugWarn('Fallback collection stats error:', error);
            return false;
        }
    };

    // Real-time analytics dashboard data
    const getMarketplaceAnalytics = useCallback(
        async (timeframe = '24h') => {
            if (!supabase) {
                const cachedData = getCache(`analytics_${timeframe}`);
                return cachedData || { sales: 0, volume: '0', fees: '0', collections: 0 };
            }

            try {
                debugLog(`📊 Fetching marketplace analytics for ${timeframe}...`);

                const timeframes = {
                    '1h': 1,
                    '24h': 24,
                    '7d': 24 * 7,
                    '30d': 24 * 30
                };

                const hours = timeframes[timeframe] || 24;
                const cutoffTime = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

                // Parallel queries for performance
                const [salesQuery, breakdownsQuery, collectionsQuery] = await Promise.allSettled([
                    supabase
                        .from('sales_history')
                        .select('total_price, payment_token')
                        .gte('timestamp', cutoffTime),
                    
                    supabase
                        .from('sale_breakdowns')
                        .select('platform_fee, vibe_amount')
                        .gte('timestamp', cutoffTime),
                    
                    supabase
                        .from('collection_stats')
                        .select('collection_address')
                        .gte('created_at', new Date(Date.now() - hours * 60 * 60 * 1000).toISOString())
                ]);

                const analytics = {
                    sales: 0,
                    volume: '0',
                    fees: '0',
                    vibeGenerated: '0',
                    collections: 0,
                    lastUpdated: Date.now()
                };

                // Process sales data
                if (salesQuery.status === 'fulfilled' && salesQuery.value.data) {
                    analytics.sales = salesQuery.value.data.length;
                    
                    let totalVolume = BigInt(0);
                    salesQuery.value.data.forEach(sale => {
                        try {
                            totalVolume += BigInt(sale.total_price || '0');
                        } catch (e) {
                            debugWarn('Error parsing sale price:', e);
                        }
                    });
                    analytics.volume = totalVolume.toString();
                }

                // Process fee breakdowns
                if (breakdownsQuery.status === 'fulfilled' && breakdownsQuery.value.data) {
                    let totalFees = BigInt(0);
                    let totalVibe = BigInt(0);
                    
                    breakdownsQuery.value.data.forEach(breakdown => {
                        try {
                            totalFees += BigInt(breakdown.platform_fee || '0');
                            totalVibe += BigInt(breakdown.vibe_amount || '0');
                        } catch (e) {
                            debugWarn('Error parsing breakdown amounts:', e);
                        }
                    });
                    
                    analytics.fees = totalFees.toString();
                    analytics.vibeGenerated = totalVibe.toString();
                }

                // Process collections data
                if (collectionsQuery.status === 'fulfilled' && collectionsQuery.value.data) {
                    const uniqueCollections = new Set(
                        collectionsQuery.value.data.map(item => item.collection_address)
                    );
                    analytics.collections = uniqueCollections.size;
                }

                // Cache the result
                setCache(`analytics_${timeframe}`, analytics, 'analytics');
                
                debugLog(`📊 Analytics for ${timeframe}:`, analytics);
                return analytics;

            } catch (error) {
                debugWarn('Error fetching marketplace analytics:', error);
                updateCacheStats('errors');
                return { sales: 0, volume: '0', fees: '0', collections: 0 };
            }
        },
        [supabase]
    );

    // Batch removal of sold listings (optimized version)
    const removeSoldListings = useCallback(
        async (salesHistory) => {
            if (!supabase || !Array.isArray(salesHistory) || salesHistory.length === 0) {
                return;
            }

            try {
                debugLog(`🧹 Batch removing ${salesHistory.length} sold listings from marketplace...`);

                // Get listing IDs from sales
                const soldListingIds = salesHistory.map(sale => sale.listingId).filter(Boolean);
                
                if (soldListingIds.length === 0) {
                    debugLog('⚠️ No valid listing IDs found in sales history');
                    return;
                }

                // Use batch update for better performance
                const listingUpdates = soldListingIds.map(listingId => ({
                    listingId,
                    active: false,
                    status: 'sold',
                    transactionHash: salesHistory.find(sale => sale.listingId === listingId)?.transactionHash
                }));

                await batchUpdateListingStatus(listingUpdates);

                // Also update user profiles to remove sold NFTs
                await updateUserProfilesAfterSales(salesHistory);

            } catch (error) {
                debugWarn('❌ Error in removeSoldListings:', error);
                updateCacheStats('errors');
            }
        },
        [supabase, batchUpdateListingStatus]
    );

    // Update user profiles after sales to remove sold NFTs
    const updateUserProfilesAfterSales = useCallback(
        async (salesHistory) => {
            if (!supabase || !Array.isArray(salesHistory)) return;

            try {
                // Group sales by seller to batch profile updates
                const sellerSales = {};
                salesHistory.forEach(sale => {
                    if (sale.seller) {
                        const seller = sale.seller.toLowerCase();
                        if (!sellerSales[seller]) {
                            sellerSales[seller] = [];
                        }
                        sellerSales[seller].push(sale);
                    }
                });

                // Update each seller's profile
                for (const [seller, sales] of Object.entries(sellerSales)) {
                    try {
                        // Get current profile
                        const { data: profileData, error: fetchError } = await supabase
                            .from('user_profiles')
                            .select('*')
                            .eq('wallet_address', seller)
                            .maybeSingle();

                        if (fetchError) {
                            debugWarn(`Error fetching profile for ${seller}:`, fetchError);
                            continue;
                        }

                        if (!profileData) {
                            debugLog(`No profile found for seller ${seller}`);
                            continue;
                        }

                        // Remove sold NFTs from listings
                        const soldListingIds = new Set(sales.map(sale => sale.listingId));
                        const updatedListings = (profileData.listings || []).filter(
                            listing => !soldListingIds.has(listing.id?.toString())
                        );

                        // Update profile with cleaned listings
                        const { error: updateError } = await supabase
                            .from('user_profiles')
                            .update({
                                listings: updatedListings,
                                updated_at: new Date().toISOString()
                            })
                            .eq('wallet_address', seller);

                        if (updateError) {
                            debugWarn(`Error updating profile for ${seller}:`, updateError);
                        } else {
                            debugLog(`✅ Updated profile for seller ${seller} - removed ${sales.length} sold items`);
                            
                            // Clear cached profile to force refresh
                            const profileKey = getCacheKey('profile', seller);
                            cache.current.delete(profileKey);
                        }

                    } catch (profileError) {
                        debugWarn(`Error processing profile update for ${seller}:`, profileError);
                    }
                }

            } catch (error) {
                debugWarn('❌ Error updating user profiles after sales:', error);
            }
        },
        [supabase]
    );

    // ========== SALES CACHE ==========
    const cacheSalesHistory = useCallback(
        async (salesHistory) => {
            try {
                await ensureSupabaseReady();
                if (!supabase) {
                    debugLog('⚠️ Supabase not available - skipping sales history cache');
                    return;
                }
                if (!Array.isArray(salesHistory) || salesHistory.length === 0) {
                    debugLog('⚠️ No sales history to cache');
                    return;
                }

                debugLog(`💾 Caching ${salesHistory.length} sales transactions to Supabase...`);

                const rows = salesHistory.map((s) => ({
                    listing_id: String(s.listingId ?? ''),
                    buyer: s.buyer,
                    seller: s.seller || null,
                    quantity: String(s.quantity ?? '1'),
                    total_price: String(s.totalPrice ?? '0'),
                    payment_token: s.paymentToken || null,
                    transaction_hash: s.transactionHash,
                    block_number: s.blockNumber || null,
                    timestamp: s.timestamp,
                    sale_type: s.type || 'sale'
                }));

                const CHUNK = 500;
                for (let i = 0; i < rows.length; i += CHUNK) {
                    const chunk = rows.slice(i, i + CHUNK);
                    const { error } = await supabase
                        .from('sales_history')
                        .upsert(chunk, { onConflict: 'transaction_hash', ignoreDuplicates: true });

                    if (error) {
                        debugWarn('❌ Database sales cache error:', error);
                        updateCacheStats('errors');
                    } else {
                        debugLog(`✅ Cached ${chunk.length} sales [${i + 1}-${i + chunk.length}]`);
                    }
                }

                setCache('sales_history', salesHistory, 'sales');
            } catch (error) {
                debugWarn('❌ Error caching sales history:', error);
                updateCacheStats('errors');
            }
        },
        [supabase]
    );

    const getCachedSalesHistory = useCallback(async () => {
        const mem = getCache('sales_history');
        if (mem) return mem;

        if (!supabase) return [];

        try {
            const { data, error } = await supabase
                .from('sales_history')
                .select('*')
                .order('timestamp', { ascending: false })
                .limit(1000);

            if (error) {
                debugWarn('Error fetching cached sales history:', error);
                updateCacheStats('errors');
                return [];
            }

            const sales = data.map((item) => ({
                listingId: item.listing_id,
                buyer: item.buyer,
                seller: item.seller,
                quantity: item.quantity,
                totalPrice: item.total_price,
                paymentToken: item.payment_token,
                transactionHash: item.transaction_hash,
                blockNumber: item.block_number,
                timestamp: item.timestamp,
                type: item.sale_type
            }));

            setCache('sales_history', sales, 'sales');
            return sales;
        } catch (error) {
            debugWarn('Error retrieving cached sales history:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase]);

    // Real-time subscriptions
    const subscribeToListings = (callback) => {
        if (!supabase) return null;
        try {
            debugLog('🔄 Setting up real-time subscription for listings...');
            const subscription = supabase
                .channel('marketplace_listings')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'marketplace_listings' },
                    (payload) => {
                        debugLog('📡 Real-time listing update:', payload);
                        clearCache('listing');
                        clearCache('all_listings');
                        if (callback) callback(payload);
                    }
                )
                .subscribe();

            subscriptions.current.set('listings', subscription);
            return subscription;
        } catch (error) {
            debugWarn('Error setting up listings subscription:', error);
            return null;
        }
    };

    const subscribeToProfiles = useCallback(
        (callback) => {
            if (!supabase) return null;
            try {
                debugLog('🔄 Setting up real-time subscription for profiles...');
                const subscription = supabase
                    .channel('user_profiles')
                    .on(
                        'postgres_changes',
                        { event: '*', schema: 'public', table: 'user_profiles' },
                        (payload) => {
                            debugLog('📡 Real-time profile update:', payload);
                            clearCache('profile');
                            if (callback) setTimeout(() => callback(payload), 1000);
                        }
                    )
                    .subscribe();

                subscriptions.current.set('profiles', subscription);
                return subscription;
            } catch (error) {
                debugWarn('Error setting up profiles subscription:', error);
                return null;
            }
        },
        [supabase]
    );

    // Cleanup subscriptions on unmount
    useEffect(() => {
        return () => {
            subscriptions.current.forEach((subscription, key) => {
                debugLog(`🔌 Unsubscribing from ${key}`);
                try {
                    subscription.unsubscribe();
                } catch { }
            });
            subscriptions.current.clear();
        };
    }, []);

    // Auction management functions
    const cacheAuctions = useCallback(
        async (auctions, marketplaceAddress) => {
            if (!auctions?.length) return;

            // If no Supabase, use in-memory cache only
            if (!supabase) {
                debugLog(`💾 Caching ${auctions.length} auctions to memory for marketplace ${marketplaceAddress}...`);
                
                // Cache each individual auction
                auctions.forEach((auction) => {
                    const id = auction.id?.toString() || auction.auctionId?.toString();
                    if (id) {
                        const key = getCacheKey('auction', id);
                        setCache(key, auction, 'auctions');
                    }
                });
                
                // Cache all auctions
                setCache('all_auctions', auctions, 'auctions');
                
                // Cache auctions filtered by seller and marketplace
                const sellerAuctions = auctions.filter(a => a.seller);
                const sellerGroups = {};
                sellerAuctions.forEach(auction => {
                    const seller = auction.seller.toLowerCase();
                    if (!sellerGroups[seller]) sellerGroups[seller] = [];
                    sellerGroups[seller].push(auction);
                });
                
                Object.entries(sellerGroups).forEach(([seller, auctionList]) => {
                    let cacheKey = `auctions_${seller}`;
                    if (marketplaceAddress) {
                        cacheKey += `_${marketplaceAddress.toLowerCase()}`;
                    }
                    setCache(cacheKey, auctionList, 'auctions');
                });
                
                debugLog(`✅ Cached ${auctions.length} auctions to memory`);
                return;
            }

            try {
                debugLog(`💾 Caching ${auctions.length} auctions to Supabase for marketplace ${marketplaceAddress}...`);

                const rows = auctions.map((auction) => {
                    // Generate a valid auction ID if missing
                    const auctionId = auction.id?.toString() || 
                                    auction.auctionId?.toString() || 
                                    `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    
                    return {
                        auction_id: auctionId,
                        marketplace_address: marketplaceAddress?.toLowerCase() || '0x0000000000000000000000000000000000000000',
                        seller: auction.seller || '0x0000000000000000000000000000000000000000',
                        nft_contract: auction.nftContract || '0x0000000000000000000000000000000000000000',
                        token_id: auction.tokenId?.toString() || '0',
                        quantity: auction.quantity?.toString() || '1',
                        reserve_price: auction.reservePrice?.toString() || '0',
                        start_price: auction.startPrice?.toString() || '0', 
                        end_time: auction.endTime || Math.floor(Date.now() / 1000) + 86400,
                        payment_token: auction.paymentToken || '0x0000000000000000000000000000000000000000',
                        min_bid_increment_bps: auction.minBidIncrementBps || 500,
                        anti_snipe_seconds: auction.antiSnipeSeconds || 300,
                        highest_bid: auction.highestBid?.toString() || '0',
                        highest_bidder: auction.highestBidder || '0x0000000000000000000000000000000000000000',
                        settled: auction.settled || false,
                        transaction_hash: auction.transactionHash || `0x${'0'.repeat(64)}`,
                        block_number: auction.blockNumber || 0,
                        log_index: auction.logIndex || 0,
                        timestamp: auction.timestamp || Math.floor(Date.now() / 1000),
                        metadata: auction.metadata || {}
                    };
                });

                // Filter invalid rows - ensure all required fields are present
                const toSave = rows.filter(
                    (r) =>
                        r.auction_id &&
                        r.auction_id !== 'undefined' &&
                        r.marketplace_address &&
                        r.seller &&
                        r.seller !== '0x0000000000000000000000000000000000000000' &&
                        r.nft_contract &&
                        r.nft_contract !== '0x0000000000000000000000000000000000000000' &&
                        r.token_id &&
                        r.reserve_price &&
                        r.start_price &&
                        r.end_time &&
                        r.payment_token &&
                        r.timestamp
                );

                if (toSave.length === 0) {
                    debugWarn('⚠️ No valid auction rows to upsert');
                    return;
                }

                debugLog(`💾 Upserting ${toSave.length} auctions to Supabase...`);

                // Chunked upserts with metadata fallback
                const CHUNK = 100;
                for (let i = 0; i < toSave.length; i += CHUNK) {
                    const chunk = toSave.slice(i, i + CHUNK);
                    
                    // Try with metadata first, fallback without metadata if column doesn't exist
                    let { data, error } = await supabase
                        .from('auctions')
                        .upsert(chunk, { onConflict: 'auction_id', ignoreDuplicates: false });

                    // If metadata column error, retry without metadata
                    if (error && error.message?.includes("metadata") && error.code === 'PGRST204') {
                        debugWarn('⚠️ Metadata column not found, retrying without metadata...');
                        const chunkWithoutMetadata = chunk.map(({ metadata, ...item }) => item);
                        
                        const fallbackResult = await supabase
                            .from('auctions')
                            .upsert(chunkWithoutMetadata, { onConflict: 'auction_id', ignoreDuplicates: false });
                        
                        data = fallbackResult.data;
                        error = fallbackResult.error;
                    }

                    if (error) {
                        debugWarn('❌ Database auction cache error:', error);
                        updateCacheStats('errors');
                        
                        // If Supabase fails, continue with localStorage caching
                        debugLog('💾 Supabase failed, using localStorage for auction persistence...');
                        chunk.forEach((auction) => {
                            try {
                                const id = auction.auction_id;
                                const key = getCacheKey('auction', id);
                                setCache(key, auction, 'auctions');
                                localStorage.setItem(`auction_${id}`, JSON.stringify(auction));
                            } catch (e) {
                                debugWarn('localStorage auction cache error:', e);
                            }
                        });
                    } else {
                        debugLog(`✅ Cached ${chunk.length} auctions [${i + 1}-${i + chunk.length}]`);
                        // Cache in memory
                        chunk.forEach((dbRow) => {
                            const id = dbRow.auction_id;
                            const key = getCacheKey('auction', id);
                            setCache(key, dbRow, 'auctions');
                        });
                    }
                }

                setCache('all_auctions', auctions, 'auctions');
            } catch (error) {
                debugWarn('❌ Error caching auctions:', error);
                updateCacheStats('errors');
            }
        },
        [supabase]
    );

    const getCachedAuctions = useCallback(async (sellerAddress = null, marketplaceAddress = null) => {
        // Always try memory cache first
        let cacheKey = sellerAddress ? `auctions_${sellerAddress.toLowerCase()}` : 'all_auctions';
        if (marketplaceAddress) {
            cacheKey += `_${marketplaceAddress.toLowerCase()}`;
        }
        const cachedData = getCache(cacheKey);
        
        if (cachedData && cachedData.length > 0) {
            debugLog(`📦 Retrieved ${cachedData.length} auctions from memory cache`);
            return cachedData;
        }

        // Fallback to localStorage if no Supabase
        if (!supabase) {
            debugLog('🔍 Supabase unavailable, checking localStorage for auctions...');
            try {
                const keys = Object.keys(localStorage).filter(key => key.startsWith('auction_') || key.startsWith('cache_auction'));
                const localAuctions = keys.map(key => {
                    try {
                        const auctionData = JSON.parse(localStorage.getItem(key));
                        
                        // Normalize auction data structure
                        const normalizedAuction = {
                            id: auctionData.id || auctionData.auctionId || auctionData.auction_id,
                            auctionId: auctionData.auctionId || auctionData.id || auctionData.auction_id,
                            seller: auctionData.seller || '0x0000000000000000000000000000000000000000',
                            nftContract: auctionData.nftContract || auctionData.nft_contract || '0x0000000000000000000000000000000000000000',
                            tokenId: auctionData.tokenId || auctionData.token_id || '0',
                            quantity: auctionData.quantity || '1',
                            reservePrice: auctionData.reservePrice || auctionData.reserve_price || '0',
                            startPrice: auctionData.startPrice || auctionData.start_price || auctionData.startingBid || '0',
                            endTime: auctionData.endTime || auctionData.end_time || Math.floor(Date.now() / 1000) + 86400,
                            paymentToken: auctionData.paymentToken || auctionData.payment_token || ethers.ZeroAddress,
                            minBidIncrementBps: auctionData.minBidIncrementBps || auctionData.min_bid_increment_bps || 500,
                            antiSnipeSeconds: auctionData.antiSnipeSeconds || auctionData.anti_snipe_seconds || 300,
                            highestBid: auctionData.highestBid || auctionData.highest_bid || '0',
                            highestBidder: auctionData.highestBidder || auctionData.highest_bidder || '0x0000000000000000000000000000000000000000',
                            settled: auctionData.settled || false,
                            transactionHash: auctionData.transactionHash || auctionData.transaction_hash || `0x${'0'.repeat(64)}`,
                            blockNumber: auctionData.blockNumber || auctionData.block_number || 0,
                            timestamp: auctionData.timestamp || Math.floor(Date.now() / 1000),
                            metadata: auctionData.metadata || {}
                        };
                        
                        return normalizedAuction;
                    } catch (e) {
                        debugWarn('Error parsing localStorage auction:', e);
                        return null;
                    }
                }).filter(auction => {
                    if (!auction) return false;
                    
                    // Ensure auction has valid ID and is not undefined
                    const hasValidId = auction.id && 
                                     auction.id !== 'undefined' && 
                                     auction.id !== 'null' && 
                                     auction.id !== undefined &&
                                     auction.id !== null;
                    
                    // Filter by seller if specified
                    if (sellerAddress && auction.seller && auction.seller.toLowerCase() !== sellerAddress.toLowerCase()) {
                        return false;
                    }
                    
                    return hasValidId;
                });
                
                debugLog(`📦 Retrieved ${localAuctions.length} auctions from localStorage fallback`);
                if (localAuctions.length > 0) {
                    setCache(cacheKey, localAuctions, 'auctions');
                    
                    // Log auction IDs for debugging
                    const auctionIds = localAuctions.map(a => a.id || a.auctionId).filter(Boolean);
                    debugLog(`🆔 Auction IDs found: [${auctionIds.join(', ')}]`);
                }
                return localAuctions;
            } catch (e) {
                debugWarn('localStorage auction retrieval error:', e);
                return [];
            }
        }

        try {
            debugLog(`🔍 Fetching cached auctions from Supabase${sellerAddress ? ` for seller ${sellerAddress}` : ''}${marketplaceAddress ? ` for marketplace ${marketplaceAddress}` : ''}...`);
            
            let query = supabase
                .from('auctions')
                .select('*');

            if (sellerAddress) {
                query = query.eq('seller', sellerAddress.toLowerCase());
            }

            if (marketplaceAddress) {
                // Ensure marketplace address is properly formatted and valid
                const validMarketplaceAddress = marketplaceAddress.toLowerCase();
                if (validMarketplaceAddress && validMarketplaceAddress !== 'undefined' && validMarketplaceAddress !== 'null') {
                    query = query.eq('marketplace_address', validMarketplaceAddress);
                }
            }

            // Try different ordering strategies based on available columns
            let { data, error } = await query.order('created_at', { ascending: false });

            // If created_at fails, try id ordering as fallback
            if (error && error.message?.includes('created_at')) {
                debugWarn('⚠️ created_at column not found, trying id ordering...');
                query = supabase.from('auctions').select('*');
                
                if (sellerAddress) {
                    query = query.eq('seller', sellerAddress.toLowerCase());
                }
                if (marketplaceAddress) {
                    const validMarketplaceAddress = marketplaceAddress.toLowerCase();
                    if (validMarketplaceAddress && validMarketplaceAddress !== 'undefined' && validMarketplaceAddress !== 'null') {
                        query = query.eq('marketplace_address', validMarketplaceAddress);
                    }
                }
                
                const fallbackResult = await query.order('id', { ascending: false });
                data = fallbackResult.data;
                error = fallbackResult.error;
            }

            if (error) {
                debugWarn('Error fetching cached auctions:', error);
                updateCacheStats('errors');
                
                // Fallback to localStorage on Supabase error
                debugLog('🔄 Supabase error, falling back to localStorage...');
                try {
                    const keys = Object.keys(localStorage).filter(key => key.startsWith('auction_') || key.startsWith('cache_auction'));
                    const localAuctions = keys.map(key => {
                        try {
                            const auctionData = JSON.parse(localStorage.getItem(key));
                            // Normalize auction data structure
                            const normalizedAuction = {
                                id: auctionData.id || auctionData.auctionId || auctionData.auction_id,
                                auctionId: auctionData.auctionId || auctionData.id || auctionData.auction_id,
                                seller: auctionData.seller || '0x0000000000000000000000000000000000000000',
                                nftContract: auctionData.nftContract || auctionData.nft_contract || '0x0000000000000000000000000000000000000000',
                                tokenId: auctionData.tokenId || auctionData.token_id || '0',
                                quantity: auctionData.quantity || '1',
                                reservePrice: auctionData.reservePrice || auctionData.reserve_price || '0',
                                startPrice: auctionData.startPrice || auctionData.start_price || auctionData.startingBid || '0',
                                endTime: auctionData.endTime || auctionData.end_time || Math.floor(Date.now() / 1000) + 86400,
                                paymentToken: auctionData.paymentToken || auctionData.payment_token || ethers.ZeroAddress,
                                minBidIncrementBps: auctionData.minBidIncrementBps || auctionData.min_bid_increment_bps || 500,
                                antiSnipeSeconds: auctionData.antiSnipeSeconds || auctionData.anti_snipe_seconds || 300,
                                highestBid: auctionData.highestBid || auctionData.highest_bid || '0',
                                highestBidder: auctionData.highestBidder || auctionData.highest_bidder || '0x0000000000000000000000000000000000000000',
                                settled: auctionData.settled || false,
                                transactionHash: auctionData.transactionHash || auctionData.transaction_hash || `0x${'0'.repeat(64)}`,
                                blockNumber: auctionData.blockNumber || auctionData.block_number || 0,
                                timestamp: auctionData.timestamp || Math.floor(Date.now() / 1000),
                                metadata: auctionData.metadata || {}
                            };
                            
                            return normalizedAuction;
                        } catch (e) {
                            debugWarn('Error parsing localStorage auction:', e);
                            return null;
                        }
                    }).filter(auction => {
                        if (!auction) return false;
                        
                        // Ensure auction has valid ID and is not undefined
                        const hasValidId = auction.id && 
                                         auction.id !== 'undefined' && 
                                         auction.id !== 'null' && 
                                         auction.id !== undefined &&
                                         auction.id !== null;
                        
                        // Filter by seller if specified
                        if (sellerAddress && auction.seller && auction.seller.toLowerCase() !== sellerAddress.toLowerCase()) {
                            return false;
                        }
                        
                        return hasValidId;
                    });
                    
                    debugLog(`📦 Retrieved ${localAuctions.length} auctions from localStorage fallback`);
                    if (localAuctions.length > 0) {
                        setCache(cacheKey, localAuctions, 'auctions');
                        
                        // Log auction IDs for debugging
                        const auctionIds = localAuctions.map(a => a.id || a.auctionId).filter(Boolean);
                        debugLog(`🆔 Auction IDs found: [${auctionIds.join(', ')}]`);
                    }
                    return localAuctions;
                } catch (e) {
                    debugWarn('localStorage fallback error:', e);
                    return [];
                }
            }

            debugLog(`📦 Retrieved ${data.length} cached auctions from database`);

            const auctions = data.map((item) => {
                // Ensure auction ID is properly set and not undefined
                let auctionId = item.auction_id;
                if (!auctionId || auctionId === 'undefined' || auctionId === 'null') {
                    auctionId = `db_${item.id}`;
                }
                
                return {
                    id: auctionId,
                    auctionId: auctionId,
                    seller: item.seller || '0x0000000000000000000000000000000000000000',
                    nftContract: item.nft_contract || '0x0000000000000000000000000000000000000000',
                    tokenId: item.token_id || '0',
                    quantity: item.quantity || '1',
                    reservePrice: item.reserve_price || '0',
                    startPrice: item.start_price || item.starting_bid || '0',
                    endTime: item.end_time || Math.floor(Date.now() / 1000) + 86400,
                    paymentToken: item.payment_token || '0x0000000000000000000000000000000000000000',
                    minBidIncrementBps: item.min_bid_increment_bps || 500,
                    antiSnipeSeconds: item.anti_snipe_seconds || 300,
                    highestBid: item.highest_bid || '0',
                    highestBidder: item.highest_bidder || '0x0000000000000000000000000000000000000000',
                    settled: item.settled || false,
                    transactionHash: item.transaction_hash || `0x${'0'.repeat(64)}`,
                    blockNumber: item.block_number || 0,
                    timestamp: item.timestamp || Math.floor(Date.now() / 1000),
                    metadata: item.metadata || {}
                };
            }).filter(auction => {
                // Ensure auction ID is valid and not undefined/null
                return auction.id && 
                       auction.id !== 'undefined' && 
                       auction.id !== 'null' &&
                       auction.id !== undefined &&
                       auction.id !== null;
            });

            const cacheKey = sellerAddress ? `auctions_${sellerAddress.toLowerCase()}` : 'all_auctions';
            setCache(cacheKey, auctions, 'auctions');
            return auctions;
        } catch (error) {
            debugWarn('Error retrieving cached auctions:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase]);

    const getAuctionBids = useCallback(async (auctionId) => {
        if (!supabase) {
            const cachedData = getCache(`auction_bids_${auctionId}`);
            return cachedData || [];
        }

        try {
            debugLog(`🔍 Fetching bids for auction ${auctionId}...`);
            
            // Handle undefined auctionId
            if (!auctionId || auctionId === 'undefined') {
                debugWarn('⚠️ Invalid auction ID provided to getAuctionBids');
                return [];
            }
            
            let query = supabase
                .from('auction_bids')
                .select('*')
                .eq('auction_id', auctionId);

            // Try different ordering strategies based on available columns
            let { data, error } = await query.order('created_at', { ascending: false });

            // If created_at fails, try id ordering as fallback
            if (error && error.message?.includes('created_at')) {
                debugWarn('⚠️ created_at column not found in auction_bids, trying id ordering...');
                query = supabase
                    .from('auction_bids')
                    .select('*')
                    .eq('auction_id', auctionId);
                    
                const fallbackResult = await query.order('id', { ascending: false });
                data = fallbackResult.data;
                error = fallbackResult.error;
            }

            if (error) {
                debugWarn('Error fetching auction bids:', error);
                updateCacheStats('errors');
                return [];
            }

            debugLog(`📦 Retrieved ${data.length} bids for auction ${auctionId}`);

            const bids = data.map((item) => ({
                auctionId: item.auction_id,
                bidder: item.bidder,
                amount: item.amount,
                newEndTime: item.new_end_time,
                isNative: item.is_native,
                transactionHash: item.transaction_hash,
                blockNumber: item.block_number,
                timestamp: item.timestamp
            }));

            setCache(`auction_bids_${auctionId}`, bids, 'auctions');
            return bids;
        } catch (error) {
            debugWarn('Error retrieving auction bids:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase]);

    const subscribeToAuctions = useCallback((callback) => {
        if (!supabase) return null;
        try {
            debugLog('🔄 Setting up real-time subscription for auctions...');
            const subscription = supabase
                .channel('auctions')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'auctions' },
                    (payload) => {
                        debugLog('📡 Real-time auction update:', payload);
                        clearCache('auction');
                        clearCache('all_auctions');
                        if (callback) callback(payload);
                    }
                )
                .subscribe();

            subscriptions.current.set('auctions', subscription);
            return subscription;
        } catch (error) {
            debugWarn('Error setting up auctions subscription:', error);
            return null;
        }
    }, [supabase]);

    const value = {
        supabase,
        isConnected,
        cacheStats,

        // Cache ops
        setCache,
        getCache,
        clearCache,

        // DB ops
        cacheListings,
        getCachedListings,
        cacheProfileData,
        getCachedProfile,
        cacheSalesHistory,
        getCachedSalesHistory,
        markListingAsSold,
        removeSoldListings,

        // Enhanced sale tracking and analytics
        recordSaleEvent,
        batchUpdateListingStatus,
        updateCollectionStats,
        getMarketplaceAnalytics,

        // Auction ops
        cacheAuctions,
        getCachedAuctions,
        getAuctionBids,

        // Realtime
        subscribeToListings,
        subscribeToProfiles,
        subscribeToAuctions,

        // Utils
        ensureSupabaseReady
    };

    return <SupabaseContext.Provider value={value}>{children}</SupabaseContext.Provider>;
}

export function useSupabase() {
    const ctx = useContext(SupabaseContext);
    if (!ctx) throw new Error('useSupabase must be used within a SupabaseProvider');
    return ctx;
}
