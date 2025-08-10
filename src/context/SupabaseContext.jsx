import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

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

            console.log('🔧 Supabase Config Check:', {
                hasUrl: !!supabaseUrl,
                hasKey: !!supabaseKey,
                url: supabaseUrl ? supabaseUrl.substring(0, 30) + '...' : 'not set',
                isDummy: supabaseUrl === 'https://dummy.supabase.co'
            });

            if (supabaseUrl && supabaseKey && supabaseUrl !== 'https://dummy.supabase.co') {
                const client = createClient(supabaseUrl, supabaseKey);
                setSupabase(client);
                setIsConnected(true);
                console.log('✅ Supabase client initialized for caching');

                // for quick console testing if you want:
                // @ts-ignore
                window.supabase = client;

                // Test the connection
                testSupabaseConnection(client);
            } else {
                console.log('⚠️ Supabase not configured - running without cache');
                setIsConnected(false);
            }
        } catch (error) {
            console.warn('❌ Supabase initialization failed:', error.message);
            setIsConnected(false);
        }
    }, []);

    // Test Supabase connection
    const testSupabaseConnection = async (client) => {
        try {
            console.log('🧪 Testing Supabase connection...');
            const { error } = await client.from('marketplace_listings').select('id').limit(1);
            if (error) {
                console.warn('⚠️ Supabase connection test failed:', error.message);
                console.log('📝 Ensure tables exist and RLS policies allow inserts/updates with anon key');
            } else {
                console.log('✅ Supabase connection test successful');
            }
        } catch (error) {
            console.warn('⚠️ Supabase connection test error:', error.message);
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
            cache.current.set(key, { data, type, timestamp: Date.now() });
            updateCacheStats('updates');
            if (cache.current.size > CACHE_CONFIG.MAX_CACHE_SIZE) {
                const oldestKey = cache.current.keys().next().value;
                cache.current.delete(oldestKey);
            }
            // console.log(`📦 Cached ${type}:`, key);
        } catch (error) {
            console.warn('Cache set error:', error);
            updateCacheStats('errors');
        }
    };

    const getCache = (key) => {
        try {
            const item = cache.current.get(key);
            if (!item) {
                updateCacheStats('misses');
                return null;
            }
            if (isExpired(item)) {
                cache.current.delete(key);
                updateCacheStats('misses');
                return null;
            }
            updateCacheStats('hits');
            // console.log(`🎯 Cache hit: ${key}`);
            return item.data;
        } catch (error) {
            console.warn('Cache get error:', error);
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
                console.log(`🧹 Cleared cache pattern: ${pattern}`);
            } else {
                cache.current.clear();
                console.log('🧹 Cleared all cache');
            }
        } catch (error) {
            console.warn('Cache clear error:', error);
        }
    };

    // ========== LISTINGS CACHE (DB) ==========
    const cacheListings = useCallback(
        async (listings, canceledSet = new Set()) => {
            try {
                await ensureSupabaseReady();
                if (!supabase) {
                    console.log('⚠️ Supabase not available - skipping listings cache');
                    return;
                }
                if (!Array.isArray(listings) || listings.length === 0) {
                    console.log('⚠️ No listings to cache');
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
                    console.warn('⚠️ No valid rows to upsert (required fields missing). Example:', rows[0]);
                    return;
                }

                console.log(`💾 Upserting ${toSave.length} listings to Supabase...`);

                // Chunked upserts (avoid payload too large)
                const CHUNK = 500;
                for (let i = 0; i < toSave.length; i += CHUNK) {
                    const chunk = toSave.slice(i, i + CHUNK);
                    const { data, error } = await supabase
                        .from('marketplace_listings')
                        .upsert(chunk, { onConflict: 'listing_id', ignoreDuplicates: false });

                    if (error) {
                        console.warn('❌ Database cache error:', error);
                        console.warn('🔍 Error details:', {
                            message: error.message,
                            details: error.details,
                            hint: error.hint,
                            code: error.code
                        });
                        updateCacheStats('errors');
                    } else {
                        console.log(`✅ Cached ${chunk.length} listings [${i + 1}-${i + chunk.length}]`);
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
                console.warn('❌ Error caching listings:', error);
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
            console.log('🔍 Fetching cached listings from Supabase...');
            const { data, error } = await supabase
                .from('marketplace_listings')
                .select('*')
                .eq('active', true)
                .order('updated_at', { ascending: false });

            if (error) {
                console.warn('Error fetching cached listings:', error);
                updateCacheStats('errors');
                return [];
            }

            console.log(`📦 Retrieved ${data.length} cached listings from database`);

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
            console.warn('Error retrieving cached listings:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase]);

    // ========== PROFILE CACHE ==========
    const cacheProfileData = useCallback(
        async (address, profileData) => {
            if (!supabase || !address) return;
            try {
                console.log(`💾 Caching profile data for ${address}...`);
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
                    console.warn('Profile cache error:', error);
                    updateCacheStats('errors');
                } else {
                    console.log(`✅ Cached profile for ${address}`);
                    const key = getCacheKey('profile', String(address).toLowerCase());
                    setCache(key, profileData, 'profile');
                }
            } catch (error) {
                console.warn('Error caching profile:', error);
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
                console.log(`🔍 Fetching cached profile for ${address}...`);
                const { data, error } = await supabase
                    .from('user_profiles')
                    .select('*')
                    .eq('wallet_address', String(address).toLowerCase())
                    .maybeSingle();

                if (error) {
                    console.warn('Error fetching cached profile:', error);
                    updateCacheStats('misses');
                    return null;
                }
                if (!data) {
                    console.log(`📭 No cached profile found for ${address}`);
                    updateCacheStats('misses');
                    return null;
                }

                const profileData = {
                    nfts: data.nfts || [],
                    listings: data.listings || [],
                    balance: data.balance || '0'
                };
                setCache(memKey, profileData, 'profile');
                console.log(`📦 Retrieved cached profile for ${address}`);
                return profileData;
            } catch (error) {
                console.warn('Error retrieving cached profile:', error);
                updateCacheStats('errors');
                return null;
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
                    console.log('⚠️ Supabase not available - skipping sales history cache');
                    return;
                }
                if (!Array.isArray(salesHistory) || salesHistory.length === 0) {
                    console.log('⚠️ No sales history to cache');
                    return;
                }

                console.log(`💾 Caching ${salesHistory.length} sales transactions to Supabase...`);

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
                        console.warn('❌ Database sales cache error:', error);
                        updateCacheStats('errors');
                    } else {
                        console.log(`✅ Cached ${chunk.length} sales [${i + 1}-${i + chunk.length}]`);
                    }
                }

                setCache('sales_history', salesHistory, 'sales');
            } catch (error) {
                console.warn('❌ Error caching sales history:', error);
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
            console.log('🔍 Loading sales history from Supabase cache...');
            const { data, error } = await supabase
                .from('sales_history')
                .select('*')
                .order('timestamp', { ascending: false })
                .limit(1000);

            if (error) {
                console.warn('Error fetching cached sales history:', error);
                updateCacheStats('errors');
                return [];
            }

            console.log(`📦 Loaded ${data.length} sales from Supabase cache`);

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
            console.warn('Error retrieving cached sales history:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase]);

    // Real-time subscriptions
    const subscribeToListings = (callback) => {
        if (!supabase) return null;
        try {
            console.log('🔄 Setting up real-time subscription for listings...');
            const subscription = supabase
                .channel('marketplace_listings')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'marketplace_listings' },
                    (payload) => {
                        console.log('📡 Real-time listing update:', payload);
                        clearCache('listing');
                        clearCache('all_listings');
                        if (callback) callback(payload);
                    }
                )
                .subscribe();

            subscriptions.current.set('listings', subscription);
            return subscription;
        } catch (error) {
            console.warn('Error setting up listings subscription:', error);
            return null;
        }
    };

    const subscribeToProfiles = useCallback(
        (callback) => {
            if (!supabase) return null;
            try {
                console.log('🔄 Setting up real-time subscription for profiles...');
                const subscription = supabase
                    .channel('user_profiles')
                    .on(
                        'postgres_changes',
                        { event: '*', schema: 'public', table: 'user_profiles' },
                        (payload) => {
                            console.log('📡 Real-time profile update:', payload);
                            clearCache('profile');
                            if (callback) setTimeout(() => callback(payload), 1000);
                        }
                    )
                    .subscribe();

                subscriptions.current.set('profiles', subscription);
                return subscription;
            } catch (error) {
                console.warn('Error setting up profiles subscription:', error);
                return null;
            }
        },
        [supabase]
    );

    // Cleanup subscriptions on unmount
    useEffect(() => {
        return () => {
            subscriptions.current.forEach((subscription, key) => {
                console.log(`🔌 Unsubscribing from ${key}`);
                try {
                    subscription.unsubscribe();
                } catch { }
            });
            subscriptions.current.clear();
        };
    }, []);

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

        // Realtime
        subscribeToListings,
        subscribeToProfiles,

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
