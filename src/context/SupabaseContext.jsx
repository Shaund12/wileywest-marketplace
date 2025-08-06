import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
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
            
            // Try a simple query to test connectivity
            const { data, error } = await client
                .from('marketplace_listings')
                .select('count')
                .limit(1);
                
            if (error) {
                console.warn('⚠️ Supabase connection test failed:', error.message);
                console.log('📝 Make sure your Supabase tables are created and RLS policies are set correctly');
            } else {
                console.log('✅ Supabase connection test successful');
            }
        } catch (error) {
            console.warn('⚠️ Supabase connection test error:', error.message);
        }
    };

    // Cache utility functions
    const getCacheKey = (type, id) => `${type}:${id}`;
    
    const isExpired = (item) => {
        if (!item.timestamp) return true;
        const now = Date.now();
        const ttl = CACHE_CONFIG[`${item.type.toUpperCase()}_TTL`] || CACHE_CONFIG.LISTINGS_TTL;
        return (now - item.timestamp) > ttl;
    };

    const updateCacheStats = (type) => {
        setCacheStats(prev => ({
            ...prev,
            [type]: prev[type] + 1
        }));
    };

    // Generic cache operations
    const setCache = (key, data, type = 'listings') => {
        try {
            const item = {
                data,
                type,
                timestamp: Date.now()
            };
            
            cache.current.set(key, item);
            updateCacheStats('updates');
            
            // Prevent memory leaks by limiting cache size
            if (cache.current.size > CACHE_CONFIG.MAX_CACHE_SIZE) {
                const oldestKey = cache.current.keys().next().value;
                cache.current.delete(oldestKey);
            }
            
            console.log(`📦 Cached ${type}:`, key);
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
            console.log(`🎯 Cache hit for:`, key);
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
                // Clear specific cache pattern
                for (const key of cache.current.keys()) {
                    if (key.includes(pattern)) {
                        cache.current.delete(key);
                    }
                }
                console.log(`🧹 Cleared cache pattern: ${pattern}`);
            } else {
                // Clear all cache
                cache.current.clear();
                console.log('🧹 Cleared all cache');
            }
        } catch (error) {
            console.warn('Cache clear error:', error);
        }
    };

    // Database operations for persistent caching
    const cacheListings = async (listings) => {
        if (!supabase) {
            console.log('⚠️ Supabase not available - skipping listings cache');
            return;
        }
        
        if (!listings || listings.length === 0) {
            console.log('⚠️ No listings to cache');
            return;
        }
        
        try {
            console.log(`💾 Caching ${listings.length} listings to Supabase...`);
            console.log('📊 Sample listing data:', listings[0]);
            
            // Prepare data for database
            const dbListings = listings.map(listing => ({
                listing_id: listing.id.toString(),
                seller: listing.seller,
                nft_contract: listing.nftContract,
                token_id: listing.tokenId,
                quantity: listing.quantity,
                price_per_unit: listing.pricePerUnit,
                payment_token: listing.paymentToken,
                is_erc1155: listing.isERC1155,
                active: listing.active,
                metadata: listing.metadata || {},
                image_url: listing.image || listing.imageUrl,
                name: listing.name || listing.title,
                description: listing.description,
                updated_at: new Date().toISOString()
            }));

            console.log('📊 Sample DB listing data:', dbListings[0]);

            // Upsert listings (insert or update if exists)
            const { data, error } = await supabase
                .from('marketplace_listings')
                .upsert(dbListings, { 
                    onConflict: 'listing_id',
                    ignoreDuplicates: false 
                });

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
                console.log(`✅ Successfully cached ${listings.length} listings to database`);
                console.log('📊 Cache result:', data);
                
                // Also cache in memory for immediate access
                listings.forEach(listing => {
                    const key = getCacheKey('listing', listing.id);
                    setCache(key, listing, 'listings');
                });
            }
        } catch (error) {
            console.warn('❌ Error caching listings:', error);
            updateCacheStats('errors');
        }
    };

    const getCachedListings = async () => {
        if (!supabase) {
            // Return in-memory cache if Supabase unavailable
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
            
            // Convert back to frontend format
            const listings = data.map(item => ({
                id: parseInt(item.listing_id),
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

            // Cache in memory for faster subsequent access
            setCache('all_listings', listings, 'listings');
            
            return listings;
        } catch (error) {
            console.warn('Error retrieving cached listings:', error);
            updateCacheStats('errors');
            return [];
        }
    };

    const cacheProfileData = async (address, profileData) => {
        if (!supabase || !address) return;

        try {
            console.log(`💾 Caching profile data for ${address}...`);
            
            const profileRecord = {
                wallet_address: address.toLowerCase(),
                nfts: profileData.nfts || [],
                listings: profileData.listings || [],
                balance: profileData.balance || '0',
                updated_at: new Date().toISOString()
            };

            const { error } = await supabase
                .from('user_profiles')
                .upsert(profileRecord, { 
                    onConflict: 'wallet_address',
                    ignoreDuplicates: false 
                });

            if (error) {
                console.warn('Profile cache error:', error);
                updateCacheStats('errors');
            } else {
                console.log(`✅ Cached profile for ${address}`);
                
                // Cache in memory
                const key = getCacheKey('profile', address.toLowerCase());
                setCache(key, profileData, 'profile');
            }
        } catch (error) {
            console.warn('Error caching profile:', error);
            updateCacheStats('errors');
        }
    };

    const getCachedProfile = async (address) => {
        if (!address) return null;

        // Check memory cache first
        const memoryKey = getCacheKey('profile', address.toLowerCase());
        const memoryData = getCache(memoryKey);
        if (memoryData) return memoryData;

        if (!supabase) return null;

        try {
            console.log(`🔍 Fetching cached profile for ${address}...`);
            
            const { data, error } = await supabase
                .from('user_profiles')
                .select('*')
                .eq('wallet_address', address.toLowerCase())
                .single();

            if (error || !data) {
                updateCacheStats('misses');
                return null;
            }

            const profileData = {
                nfts: data.nfts || [],
                listings: data.listings || [],
                balance: data.balance || '0'
            };

            // Cache in memory for faster access
            setCache(memoryKey, profileData, 'profile');
            
            console.log(`📦 Retrieved cached profile for ${address}`);
            return profileData;
        } catch (error) {
            console.warn('Error retrieving cached profile:', error);
            updateCacheStats('errors');
            return null;
        }
    };

    const cacheSalesHistory = async (salesHistory) => {
        if (!supabase) {
            console.log('⚠️ Supabase not available - skipping sales history cache');
            return;
        }
        
        if (!salesHistory || salesHistory.length === 0) {
            console.log('⚠️ No sales history to cache');
            return;
        }

        try {
            console.log(`💾 Caching ${salesHistory.length} sales transactions to Supabase...`);
            console.log('📊 Sample sales data:', salesHistory[0]);
            
            // Prepare data for database
            const dbSales = salesHistory.map(sale => ({
                listing_id: sale.listingId,
                buyer: sale.buyer,
                seller: sale.seller || null,
                quantity: sale.quantity,
                total_price: sale.totalPrice,
                payment_token: sale.paymentToken,
                transaction_hash: sale.transactionHash,
                block_number: sale.blockNumber || null,
                timestamp: sale.timestamp,
                sale_type: sale.type || 'sale'
            }));

            console.log('📊 Sample DB sales data:', dbSales[0]);

            // Upsert sales (insert or update if exists, avoid duplicates by transaction_hash)
            const { data, error } = await supabase
                .from('sales_history')
                .upsert(dbSales, { 
                    onConflict: 'transaction_hash',
                    ignoreDuplicates: true 
                });

            if (error) {
                console.warn('❌ Database sales cache error:', error);
                console.warn('🔍 Error details:', {
                    message: error.message,
                    details: error.details,
                    hint: error.hint,
                    code: error.code
                });
                updateCacheStats('errors');
            } else {
                console.log(`✅ Successfully cached ${salesHistory.length} sales to database`);
                console.log('📊 Cache result:', data);
                
                // Also cache in memory for immediate access
                setCache('sales_history', salesHistory, 'sales');
            }
        } catch (error) {
            console.warn('❌ Error caching sales history:', error);
            updateCacheStats('errors');
        }
    };

    const getCachedSalesHistory = async () => {
        // Check memory cache first
        const memoryData = getCache('sales_history');
        if (memoryData) return memoryData;

        if (!supabase) return [];

        try {
            console.log('🔍 Fetching cached sales history from Supabase...');
            
            const { data, error } = await supabase
                .from('sales_history')
                .select('*')
                .order('timestamp', { ascending: false })
                .limit(1000); // Limit to last 1000 sales

            if (error) {
                console.warn('Error fetching cached sales history:', error);
                updateCacheStats('errors');
                return [];
            }

            console.log(`📦 Retrieved ${data.length} cached sales from database`);
            
            // Convert back to frontend format
            const salesHistory = data.map(item => ({
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

            // Cache in memory for faster subsequent access
            setCache('sales_history', salesHistory, 'sales');
            
            return salesHistory;
        } catch (error) {
            console.warn('Error retrieving cached sales history:', error);
            updateCacheStats('errors');
            return [];
        }
    };

    // Real-time subscriptions
    const subscribeToListings = (callback) => {
        if (!supabase) return null;

        try {
            console.log('🔄 Setting up real-time subscription for listings...');
            
            const subscription = supabase
                .channel('marketplace_listings')
                .on('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'marketplace_listings'
                }, (payload) => {
                    console.log('📡 Real-time listing update:', payload);
                    
                    // Clear relevant cache entries
                    clearCache('listing');
                    clearCache('all_listings');
                    
                    // Notify callback
                    if (callback) callback(payload);
                })
                .subscribe();

            subscriptions.current.set('listings', subscription);
            return subscription;
        } catch (error) {
            console.warn('Error setting up listings subscription:', error);
            return null;
        }
    };

    const subscribeToProfiles = (callback) => {
        if (!supabase) return null;

        try {
            console.log('🔄 Setting up real-time subscription for profiles...');
            
            const subscription = supabase
                .channel('user_profiles')
                .on('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'user_profiles'
                }, (payload) => {
                    console.log('📡 Real-time profile update:', payload);
                    
                    // Clear relevant cache entries
                    clearCache('profile');
                    
                    // Notify callback
                    if (callback) callback(payload);
                })
                .subscribe();

            subscriptions.current.set('profiles', subscription);
            return subscription;
        } catch (error) {
            console.warn('Error setting up profiles subscription:', error);
            return null;
        }
    };

    // Cleanup subscriptions on unmount
    useEffect(() => {
        return () => {
            subscriptions.current.forEach((subscription, key) => {
                console.log(`🔌 Unsubscribing from ${key}`);
                subscription.unsubscribe();
            });
            subscriptions.current.clear();
        };
    }, []);

    const value = {
        supabase,
        isConnected,
        cacheStats,
        
        // Cache operations
        setCache,
        getCache,
        clearCache,
        
        // Database operations
        cacheListings,
        getCachedListings,
        cacheProfileData,
        getCachedProfile,
        cacheSalesHistory,
        getCachedSalesHistory,
        
        // Real-time subscriptions
        subscribeToListings,
        subscribeToProfiles
    };

    return (
        <SupabaseContext.Provider value={value}>
            {children}
        </SupabaseContext.Provider>
    );
}

export function useSupabase() {
    const context = useContext(SupabaseContext);
    if (!context) {
        throw new Error('useSupabase must be used within a SupabaseProvider');
    }
    return context;
}