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

    // NEW: Validate listings against blockchain to ensure they're still active
    const validateListingAgainstBlockchain = useCallback(async (listing, marketplaceContract) => {
        if (!marketplaceContract || !listing) return listing;
        
        try {
            // Check the listing directly on the blockchain
            const onchainData = await marketplaceContract.listings(listing.id);
            
            // If seller is zero address, the listing doesn't exist or was deleted
            if (!onchainData || onchainData.seller === '0x0000000000000000000000000000000000000000') {
                debugLog(`🚫 Listing ${listing.id} no longer exists on blockchain`);
                
                // Update database to mark as inactive
                if (supabase) {
                    try {
                        await supabase
                            .from('marketplace_listings')
                            .update({ 
                                active: false, 
                                sale_status: 'sold',
                                updated_at: new Date().toISOString() 
                            })
                            .eq('listing_id', listing.id);
                        debugLog(`✅ Updated database for sold listing ${listing.id}`);
                    } catch (dbError) {
                        debugWarn(`⚠️ Failed to update database for listing ${listing.id}:`, dbError);
                    }
                }
                
                return null; // Remove this listing from results
            }
            
            // Check if the blockchain active status differs from cached status
            const blockchainActive = Boolean(onchainData.active);
            if (blockchainActive !== listing.active) {
                debugLog(`🔄 Listing ${listing.id} status mismatch - blockchain: ${blockchainActive}, cache: ${listing.active}`);
                
                // Update database with correct status
                if (supabase) {
                    try {
                        await supabase
                            .from('marketplace_listings')
                            .update({ 
                                active: blockchainActive, 
                                sale_status: blockchainActive ? 'active' : 'sold',
                                updated_at: new Date().toISOString() 
                            })
                            .eq('listing_id', listing.id);
                        debugLog(`✅ Synced listing ${listing.id} status with blockchain`);
                    } catch (dbError) {
                        debugWarn(`⚠️ Failed to sync listing ${listing.id} status:`, dbError);
                    }
                }
                
                // If blockchain says it's inactive, exclude it
                if (!blockchainActive) {
                    return null;
                }
                
                // Update the listing object with correct status
                return {
                    ...listing,
                    active: blockchainActive,
                    saleStatus: blockchainActive ? 'active' : 'sold'
                };
            }
            
            // Listing is valid and status matches
            return listing;
            
        } catch (error) {
            debugWarn(`⚠️ Failed to validate listing ${listing.id} against blockchain:`, error.message);
            
            // On network error, return the cached listing but log the issue
            // This prevents the UI from breaking due to network issues
            if (error.message?.includes('network') || error.message?.includes('timeout')) {
                debugLog(`📡 Network issue validating listing ${listing.id}, using cached data`);
                return listing;
            }
            
            // For other errors, exclude the listing to be safe
            debugLog(`❌ Validation error for listing ${listing.id}, excluding from results`);
            return null;
        }
    }, [supabase]);

    const getCachedListings = useCallback(async (marketplaceContract = null) => {
        if (!supabase) {
            const cachedData = getCache('all_listings');
            return cachedData || [];
        }

        try {
            // Fix: Filter out sold and canceled listings properly
            const { data, error } = await supabase
                .from('marketplace_listings')
                .select('*')
                .eq('active', true)
                .neq('sale_status', 'sold')
                .neq('sale_status', 'canceled')
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

            debugLog(`📋 Fetched ${listings.length} cached listings`);

            // NEW: Validate each listing against blockchain if contract provided
            if (marketplaceContract && listings.length > 0) {
                debugLog(`🔍 Validating ${listings.length} listings against blockchain...`);
                
                // Validate all listings in parallel (with reasonable concurrency limit)
                const VALIDATION_BATCH_SIZE = 10; // Validate 10 listings at a time
                const validatedListings = [];
                
                for (let i = 0; i < listings.length; i += VALIDATION_BATCH_SIZE) {
                    const batch = listings.slice(i, i + VALIDATION_BATCH_SIZE);
                    
                    try {
                        const batchResults = await Promise.all(
                            batch.map(listing => validateListingAgainstBlockchain(listing, marketplaceContract))
                        );
                        
                        // Filter out null results (invalid/sold listings)
                        const validBatchListings = batchResults.filter(listing => listing !== null);
                        validatedListings.push(...validBatchListings);
                        
                        debugLog(`✅ Validated batch ${Math.floor(i / VALIDATION_BATCH_SIZE) + 1}: ${validBatchListings.length}/${batch.length} valid`);
                        
                    } catch (batchError) {
                        debugWarn(`⚠️ Batch validation error:`, batchError);
                        // On batch error, include original listings to prevent empty marketplace
                        validatedListings.push(...batch);
                    }
                }
                
                const removedCount = listings.length - validatedListings.length;
                if (removedCount > 0) {
                    debugLog(`🚫 Removed ${removedCount} sold/invalid listings after blockchain validation`);
                }
                
                debugLog(`✅ Blockchain validation complete: ${validatedListings.length} valid listings confirmed`);
                setCache('all_listings', validatedListings, 'listings');
                return validatedListings;
            }

            // No marketplace contract provided, return cached data
            debugLog(`✅ Loaded ${listings.length} cached listings (no blockchain validation)`);
            setCache('all_listings', listings, 'listings');
            return listings;
            
        } catch (error) {
            debugWarn('Error retrieving cached listings:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase, validateListingAgainstBlockchain]);

    // ========== PROFILE CACHE ==========
    const cacheProfileData = useCallback(
        async (address, profileData) => {
            if (!supabase || !address) return;
            try {
                debugLog(`💾 PRODUCTION: Caching profile data for ${address}...`);
                
                // PRODUCTION FIX: Get existing profile first to merge data intelligently
                let existingProfile = null;
                try {
                    const { data } = await supabase
                        .from('user_profiles')
                        .select('*')
                        .eq('wallet_address', String(address).toLowerCase())
                        .maybeSingle();
                    existingProfile = data;
                } catch (error) {
                    debugWarn('Error fetching existing profile for merge:', error);
                }
                
                // Merge new data with existing data intelligently
                const mergedProfile = {
                    wallet_address: String(address).toLowerCase(),
                    nfts: profileData.nfts || existingProfile?.nfts || [],
                    listings: profileData.listings || existingProfile?.listings || [],
                    balance: profileData.balance || existingProfile?.balance || '0',
                    // PRODUCTION: Always preserve and create essential profile fields
                    created_at: existingProfile?.created_at || new Date().toISOString(),
                    // Preserve additional fields from existing profile
                    ...(existingProfile || {}),
                    // Override with new data
                    ...profileData,
                    updated_at: new Date().toISOString()
                };

                // PRODUCTION FIX: Always create/update profile, even with 0 NFTs (essential for production)
                const { error } = await supabase
                    .from('user_profiles')
                    .upsert(mergedProfile, { onConflict: 'wallet_address', ignoreDuplicates: false });

                if (error) {
                    debugWarn('Profile cache error:', error);
                    updateCacheStats('errors');
                } else {
                    debugLog(`✅ PRODUCTION: Profile ${existingProfile ? 'updated' : 'created'} for ${address} (${mergedProfile.nfts.length} NFTs, ${mergedProfile.listings.length} listings)`);
                    const key = getCacheKey('profile', String(address).toLowerCase());
                    setCache(key, mergedProfile, 'profile');
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

    // ========== CLEANUP ORPHANED LISTINGS ==========
    const cleanupOrphanedListings = useCallback(
        async () => {
            if (!supabase) {
                debugLog('⚠️ Supabase not available for cleanup');
                return { cleaned: 0, errors: [] };
            }

            try {
                debugLog('🧹 Starting cleanup of orphaned active listings...');
                
                // Get all currently active listings from database
                const { data: activeListings, error: fetchError } = await supabase
                    .from('marketplace_listings')
                    .select('listing_id, sale_transaction_hash')
                    .eq('active', true)
                    .eq('sale_status', 'active');

                if (fetchError) {
                    throw new Error(`Failed to fetch active listings: ${fetchError.message}`);
                }

                if (!activeListings || activeListings.length === 0) {
                    debugLog('✅ No active listings to check');
                    return { cleaned: 0, errors: [] };
                }

                debugLog(`🔍 Checking ${activeListings.length} active listings for orphaned sales...`);
                
                // For listings that have a sale_transaction_hash but are still active, mark them as sold
                const listingsToClean = activeListings.filter(listing => 
                    listing.sale_transaction_hash && 
                    listing.sale_transaction_hash !== null &&
                    listing.sale_transaction_hash.length > 0
                );

                if (listingsToClean.length === 0) {
                    debugLog('✅ No orphaned listings found');
                    return { cleaned: 0, errors: [] };
                }

                debugLog(`🛠️ Found ${listingsToClean.length} orphaned listings with transaction hashes - marking as sold...`);
                
                const errors = [];
                let cleanedCount = 0;

                for (const listing of listingsToClean) {
                    try {
                        const { error: updateError } = await supabase
                            .from('marketplace_listings')
                            .update({
                                active: false,
                                sale_status: 'sold',
                                updated_at: new Date().toISOString()
                            })
                            .eq('listing_id', listing.listing_id);

                        if (updateError) {
                            errors.push(`Listing ${listing.listing_id}: ${updateError.message}`);
                        } else {
                            cleanedCount++;
                            debugLog(`✅ Cleaned orphaned listing ${listing.listing_id}`);
                        }
                    } catch (error) {
                        errors.push(`Listing ${listing.listing_id}: ${error.message}`);
                    }
                }

                if (cleanedCount > 0) {
                    // Clear cache after cleanup
                    cache.current.delete('all_listings');
                    updateCacheStats('updates');
                }

                debugLog(`🧹 Cleanup completed: ${cleanedCount} cleaned, ${errors.length} errors`);
                return { cleaned: cleanedCount, errors };

            } catch (error) {
                debugWarn('❌ Error during orphaned listings cleanup:', error);
                updateCacheStats('errors');
                return { cleaned: 0, errors: [error.message] };
            }
        },
        [supabase]
    );
    const markListingAsSold = useCallback(
        async (listingId, transactionHash = null, retryCount = 3) => {
            if (!supabase || !listingId) {
                debugLog('⚠️ Supabase not available or no listing ID provided');
                return false;
            }

            let attempt = 0;
            while (attempt < retryCount) {
                try {
                    debugLog(`🔄 Marking listing ${listingId} as sold (attempt ${attempt + 1}/${retryCount})...`);

                    const updateData = {
                        active: false,
                        sale_status: 'sold',
                        updated_at: new Date().toISOString()
                    };

                    if (transactionHash) {
                        updateData.sale_transaction_hash = transactionHash;
                    }

                    const { data, error } = await supabase
                        .from('marketplace_listings')
                        .update(updateData)
                        .eq('listing_id', String(listingId))
                        .select();

                    if (error) {
                        throw new Error(`Database error: ${error.message}`);
                    }

                    // Verify the update actually happened
                    if (!data || data.length === 0) {
                        throw new Error(`No rows updated - listing ${listingId} may not exist`);
                    }

                    debugLog(`✅ Successfully marked listing ${listingId} as sold in database`);
                    
                    // Update in-memory cache immediately
                    const key = getCacheKey('listing', listingId);
                    cache.current.delete(key);
                    
                    // Invalidate 'all_listings' cache to force refresh
                    cache.current.delete('all_listings');
                    
                    // Trigger immediate real-time notification if channel exists
                    try {
                        if (supabase) {
                            debugLog(`📡 Broadcasting real-time update for listing ${listingId}`);
                            // Send a custom broadcast to all connected clients
                            supabase.channel('marketplace_listings')
                                .send({
                                    type: 'broadcast',
                                    event: 'listing_sold',
                                    payload: {
                                        listing_id: listingId,
                                        transaction_hash: transactionHash,
                                        timestamp: new Date().toISOString()
                                    }
                                });
                        }
                    } catch (broadcastError) {
                        debugWarn('Failed to broadcast real-time update:', broadcastError);
                    }
                    
                    updateCacheStats('updates');
                    return true;

                } catch (error) {
                    attempt++;
                    debugWarn(`❌ Error marking listing ${listingId} as sold (attempt ${attempt}):`, error.message);
                    updateCacheStats('errors');
                    
                    if (attempt >= retryCount) {
                        debugWarn(`❌ Failed to mark listing ${listingId} as sold after ${retryCount} attempts`);
                        return false;
                    }
                    
                    // Wait before retrying with exponential backoff
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    debugLog(`⏱️ Waiting ${delay}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            
            return false;
        },
        [supabase]
    );

    const removeSoldListings = useCallback(
        async (salesHistory) => {
            if (!supabase || !Array.isArray(salesHistory) || salesHistory.length === 0) {
                return;
            }

            try {
                debugLog(`🧹 Removing ${salesHistory.length} sold listings from marketplace...`);

                // Get listing IDs from sales
                const soldListingIds = salesHistory.map(sale => sale.listingId).filter(Boolean);
                
                if (soldListingIds.length === 0) {
                    debugLog('⚠️ No valid listing IDs found in sales history');
                    return;
                }

                // Mark sold listings as inactive in Supabase
                const { data, error } = await supabase
                    .from('marketplace_listings')
                    .update({ 
                        active: false, 
                        sale_status: 'sold',
                        updated_at: new Date().toISOString() 
                    })
                    .in('listing_id', soldListingIds)
                    .select();

                if (error) {
                    debugWarn('❌ Error removing sold listings:', error);
                    updateCacheStats('errors');
                } else {
                    debugLog(`✅ Marked ${data?.length || 0} listings as sold in database`);
                    
                    // Update in-memory cache - remove sold listings
                    soldListingIds.forEach(listingId => {
                        const key = getCacheKey('listing', listingId);
                        cache.current.delete(key);
                    });
                    
                    // Invalidate 'all_listings' cache to force refresh
                    cache.current.delete('all_listings');
                    
                    updateCacheStats('updates');
                }

                // Also update user profiles to remove sold NFTs
                await updateUserProfilesAfterSales(salesHistory);

            } catch (error) {
                debugWarn('❌ Error in removeSoldListings:', error);
                updateCacheStats('errors');
            }
        },
        [supabase]
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
            debugLog('🔄 Setting up enhanced real-time subscription for instant listing updates...');
            const subscription = supabase
                .channel('marketplace_listings')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'marketplace_listings' },
                    (payload) => {
                        debugLog('📡 Real-time listing database change:', payload);
                        clearCache('listing');
                        clearCache('all_listings');
                        if (callback) callback(payload);
                    }
                )
                .on(
                    'broadcast',
                    { event: 'listing_sold' },
                    (payload) => {
                        debugLog('📡 Real-time listing sold broadcast:', payload);
                        clearCache('listing');
                        clearCache('all_listings');
                        if (callback) callback({ 
                            eventType: 'DELETE',
                            table: 'marketplace_listings',
                            new: payload.payload,
                            old: null 
                        });
                    }
                )
                .on(
                    'broadcast',
                    { event: 'listing_created' },
                    (payload) => {
                        debugLog('📡 Real-time listing created broadcast:', payload);
                        clearCache('listing');
                        clearCache('all_listings');
                        if (callback) callback({ 
                            eventType: 'INSERT',
                            table: 'marketplace_listings',
                            new: payload.payload,
                            old: null 
                        });
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
        validateListingAgainstBlockchain,
        cacheProfileData,
        getCachedProfile,
        cacheSalesHistory,
        getCachedSalesHistory,
        markListingAsSold,
        removeSoldListings,
        cleanupOrphanedListings,

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
