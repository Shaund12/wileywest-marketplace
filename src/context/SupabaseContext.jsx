import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    useRef,
    useCallback
} from 'react';
import { createClient } from '@supabase/supabase-js';

const SupabaseContext = createContext();

// Cache configuration
const CACHE_CONFIG = {
    LISTINGS_TTL: 5 * 60 * 1000,  // 5 minutes for listings
    PROFILE_TTL: 10 * 60 * 1000,  // 10 minutes for profile data
    SALES_TTL: 60 * 60 * 1000,  // 1 hour for sales history
    MAX_CACHE_SIZE: 1000          // Maximum number of cached items
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

    // In-memory cache for fast reads
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
            const { error } = await client
                .from('marketplace_listings')
                .select('listing_id')
                .limit(1);
            if (error) {
                console.warn('⚠️ Supabase connection test failed:', error.message);
                console.log('📝 Ensure tables exist and RLS policies are configured.');
            } else {
                console.log('✅ Supabase connection test successful');
            }
        } catch (error) {
            console.warn('⚠️ Supabase connection test error:', error.message);
        }
    };

    // Wait for Supabase client
    const ensureSupabaseReady = () =>
        new Promise((resolve) => {
            if (supabase && isConnected) return resolve(true);
            const check = () => (supabase && isConnected ? resolve(true) : setTimeout(check, 100));
            setTimeout(check, 100);
        });

    // Cache helpers
    const getCacheKey = (type, id) => `${type}:${id}`;

    const ttlForType = (type) => {
        switch ((type || '').toLowerCase()) {
            case 'listings': return CACHE_CONFIG.LISTINGS_TTL;
            case 'profile': return CACHE_CONFIG.PROFILE_TTL;
            case 'sales': return CACHE_CONFIG.SALES_TTL;
            default: return CACHE_CONFIG.LISTINGS_TTL;
        }
    };

    const isExpired = (item) => {
        if (!item?.timestamp) return true;
        const now = Date.now();
        const ttl = ttlForType(item.type);
        return now - item.timestamp > ttl;
    };

    const updateCacheStats = (type) => {
        setCacheStats((prev) => ({ ...prev, [type]: prev[type] + 1 }));
    };

    const setCache = (key, data, type = 'listings') => {
        try {
            cache.current.set(key, { data, type, timestamp: Date.now() });
            updateCacheStats('updates');

            // Limit memory usage
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
            // console.log('🎯 Cache hit:', key);
            return item.data;
        } catch (error) {
            console.warn('Cache get error:', error);
            updateCacheStats('errors');
            return null;
        }
    };

    const clearCache = (pattern) => {
        try {
            if (!pattern) {
                cache.current.clear();
                console.log('🧹 Cleared all cache');
                return;
            }
            for (const key of cache.current.keys()) {
                if (key.includes(pattern)) cache.current.delete(key);
            }
            console.log(`🧹 Cleared cache pattern: ${pattern}`);
        } catch (error) {
            console.warn('Cache clear error:', error);
        }
    };

    /**
     * Cache marketplace listings to Supabase (chunked upserts, BigInt-safe).
     * Optionally pass canceledIds (Set<string|number>) to set active=false.
     */
    const cacheListings = useCallback(
        async (listings, canceledIds = new Set()) => {
            try {
                await ensureSupabaseReady();
                if (!supabase) {
                    console.log('⚠️ Supabase not available - skipping listings cache');
                    return;
                }
                if (!listings || listings.length === 0) {
                    console.log('⚠️ No listings to cache');
                    return;
                }

                console.log(`💾 Caching ${listings.length} listings to Supabase (chunked)...`);

                // Normalize every field (strings for ids/prices, lower-case addresses)
                const dbListings = listings.map((l) => {
                    const img =
                        l.image ||
                        l.imageUrl ||
                        l.metadata?.image ||
                        l.metadata?.image_url ||
                        null;

                    const qty =
                        typeof l.quantity === 'bigint'
                            ? l.quantity.toString()
                            : l.quantity ?? 1;

                    const ppu =
                        typeof l.pricePerUnit === 'bigint'
                            ? l.pricePerUnit.toString()
                            : l.pricePerUnit != null
                                ? String(l.pricePerUnit)
                                : '0';

                    const listingId = String(l.id);
                    const isCanceled = canceledIds?.has?.(listingId) || canceledIds?.has?.(l.id);

                    return {
                        listing_id: listingId,
                        seller: l.seller ?? null,
                        nft_contract: (l.nftContract || '').toLowerCase(),
                        token_id: String(l.tokenId),
                        quantity: qty,
                        price_per_unit: ppu,
                        payment_token: l.paymentToken ?? null,
                        is_erc1155: !!l.isERC1155,
                        active: isCanceled ? false : !!l.active,
                        metadata: l.metadata || {},
                        image_url: img,
                        name: l.name || l.title || l.metadata?.name || null,
                        description: l.description || l.metadata?.description || null,
                        updated_at: new Date().toISOString()
                    };
                });

                // Upsert in chunks to avoid payload limits
                const CHUNK = 500;
                for (let i = 0; i < dbListings.length; i += CHUNK) {
                    const slice = dbListings.slice(i, i + CHUNK);
                    const { error } = await supabase
                        .from('marketplace_listings')
                        .upsert(slice, {
                            onConflict: 'listing_id',
                            ignoreDuplicates: false
                        });
                    if (error) throw error;
                }

                // Additionally mark any canceled IDs inactive (covers rows not present in `listings`)
                if (canceledIds && canceledIds.size > 0) {
                    const ids = [...canceledIds].map(String);
                    const { error: updErr } = await supabase
                        .from('marketplace_listings')
                        .update({ active: false, updated_at: new Date().toISOString() })
                        .in('listing_id', ids);
                    if (updErr) throw updErr;
                }

                // Refresh memory cache
                setCache('all_listings', listings, 'listings');
                listings.forEach((l) =>
                    setCache(getCacheKey('listing', String(l.id)), l, 'listings')
                );

                console.log(`✅ Cached ${listings.length} listings to DB & memory`);
                updateCacheStats('updates');
            } catch (error) {
                console.warn('❌ Error caching listings:', error);
                updateCacheStats('errors');
            }
        },
        [supabase]
    );

    const getCachedListings = useCallback(async () => {
        // Memory first
        const mem = getCache('all_listings');
        if (mem) return mem;

        if (!supabase) return [];

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

            console.log(`📦 Retrieved ${data.length} cached listings from DB`);

            // Map back to app shape (keep pricePerUnit as string for BigInt safety)
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

    const cacheProfileData = useCallback(
        async (address, profileData) => {
            if (!supabase || !address) return;

            try {
                console.log(`💾 Caching profile data for ${address}...`);
                const lower = address.toLowerCase();

                const record = {
                    wallet_address: lower,
                    nfts: profileData.nfts || [],
                    listings: profileData.listings || [],
                    balance: profileData.balance || '0',
                    updated_at: new Date().toISOString()
                };

                const { error } = await supabase
                    .from('user_profiles')
                    .upsert(record, { onConflict: 'wallet_address', ignoreDuplicates: false });

                if (error) {
                    console.warn('Profile cache error:', error);
                    updateCacheStats('errors');
                } else {
                    console.log(`✅ Cached profile for ${address}`);
                    setCache(getCacheKey('profile', lower), profileData, 'profile');
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

            const key = getCacheKey('profile', address.toLowerCase());
            const mem = getCache(key);
            if (mem) return mem;

            if (!supabase) return null;

            try {
                console.log(`🔍 Fetching cached profile for ${address}...`);
                const { data, error } = await supabase
                    .from('user_profiles')
                    .select('*')
                    .eq('wallet_address', address.toLowerCase())
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

                setCache(key, profileData, 'profile');
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

    const cacheSalesHistory = useCallback(
        async (salesHistory) => {
            try {
                await ensureSupabaseReady();
                if (!supabase) {
                    console.log('⚠️ Supabase not available - skipping sales history cache');
                    return;
                }
                if (!salesHistory || salesHistory.length === 0) {
                    console.log('⚠️ No sales history to cache');
                    return;
                }

                console.log(`💾 Caching ${salesHistory.length} sales to Supabase...`);

                const dbSales = salesHistory.map((s) => ({
                    listing_id: s.listingId != null ? String(s.listingId) : null,
                    buyer: s.buyer,
                    seller: s.seller || null,
                    quantity: typeof s.quantity === 'bigint' ? s.quantity.toString() : s.quantity ?? 1,
                    total_price:
                        typeof s.totalPrice === 'bigint'
                            ? s.totalPrice.toString()
                            : s.totalPrice != null
                                ? String(s.totalPrice)
                                : '0',
                    payment_token: s.paymentToken || null,
                    transaction_hash: s.transactionHash,
                    block_number: s.blockNumber ?? null,
                    timestamp: s.timestamp,
                    sale_type: s.type || 'sale'
                }));

                // Upsert by unique transaction_hash
                const CHUNK = 500;
                for (let i = 0; i < dbSales.length; i += CHUNK) {
                    const slice = dbSales.slice(i, i + CHUNK);
                    const { error } = await supabase
                        .from('sales_history')
                        .upsert(slice, {
                            onConflict: 'transaction_hash',
                            ignoreDuplicates: true
                        });
                    if (error) throw error;
                }

                setCache('sales_history', salesHistory, 'sales');
                console.log(`✅ Cached ${salesHistory.length} sales to DB & memory`);
                updateCacheStats('updates');
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

            console.log(`📦 Loaded ${data.length} sales from DB cache`);

            const sales = data.map((r) => ({
                listingId: r.listing_id != null ? Number(r.listing_id) : null,
                buyer: r.buyer,
                seller: r.seller,
                quantity: r.quantity,
                totalPrice: r.total_price,
                paymentToken: r.payment_token,
                transactionHash: r.transaction_hash,
                blockNumber: r.block_number,
                timestamp: r.timestamp,
                type: r.sale_type
            }));

            setCache('sales_history', sales, 'sales');
            return sales;
        } catch (error) {
            console.warn('Error retrieving cached sales history:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase]);

    // Real-time subscriptions (invalidate memory caches)
    const subscribeToListings = (callback) => {
        if (!supabase) return null;
        try {
            console.log('🔄 Subscribing to listings changes...');
            const subscription = supabase
                .channel('marketplace_listings')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'marketplace_listings' },
                    (payload) => {
                        console.log('📡 Listing change:', payload);
                        clearCache('listing');
                        clearCache('all_listings');
                        callback && callback(payload);
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
                console.log('🔄 Subscribing to profiles changes...');
                const subscription = supabase
                    .channel('user_profiles')
                    .on(
                        'postgres_changes',
                        { event: '*', schema: 'public', table: 'user_profiles' },
                        (payload) => {
                            console.log('📡 Profile change:', payload);
                            clearCache('profile');
                            if (callback) setTimeout(() => callback(payload), 1000); // light throttle
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
            subscriptions.current.forEach((sub, key) => {
                try {
                    console.log(`🔌 Unsubscribing from ${key}`);
                    sub.unsubscribe();
                } catch { }
            });
            subscriptions.current.clear();
        };
    }, []);

    const value = {
        supabase,
        isConnected,

        cacheStats,
        setCache,
        getCache,
        clearCache,

        cacheListings,
        getCachedListings,

        cacheProfileData,
        getCachedProfile,

        cacheSalesHistory,
        getCachedSalesHistory,

        subscribeToListings,
        subscribeToProfiles,

        ensureSupabaseReady
    };

    return (
        <SupabaseContext.Provider value={value}>
            {children}
        </SupabaseContext.Provider>
    );
}

export function useSupabase() {
    const ctx = useContext(SupabaseContext);
    if (!ctx) throw new Error('useSupabase must be used within a SupabaseProvider');
    return ctx;
}
