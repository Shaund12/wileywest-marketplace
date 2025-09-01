import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

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
            const { error } = await client.from('marketplace_listings').select('id').limit(1);
            if (error) {
                console.warn('⚠️ Supabase connection test failed:', error.message);
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
            const cacheItem = { data, type, timestamp: Date.now() };
            cache.current.set(key, cacheItem);
            
            // Also persist to localStorage for auctions to survive page refresh
            if (type === 'auctions') {
                try {
                    localStorage.setItem(`cache_${key}`, JSON.stringify(cacheItem));
                } catch (e) {
                    console.warn('localStorage error:', e);
                }
            }
            
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
                    console.warn('localStorage retrieval error:', e);
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
                        console.warn('localStorage removal error:', e);
                    }
                }
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

    // Auction management functions
    const cacheAuctions = useCallback(
        async (auctions, marketplaceAddress) => {
            if (!auctions?.length) return;

            // If no Supabase, use in-memory cache only
            if (!supabase) {
                console.log(`💾 Caching ${auctions.length} auctions to memory for marketplace ${marketplaceAddress}...`);
                
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
                
                console.log(`✅ Cached ${auctions.length} auctions to memory`);
                return;
            }

            try {
                console.log(`💾 Caching ${auctions.length} auctions to Supabase for marketplace ${marketplaceAddress}...`);

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
                    console.warn('⚠️ No valid auction rows to upsert');
                    return;
                }

                console.log(`💾 Upserting ${toSave.length} auctions to Supabase...`);

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
                        console.warn('⚠️ Metadata column not found, retrying without metadata...');
                        const chunkWithoutMetadata = chunk.map(({ metadata, ...item }) => item);
                        
                        const fallbackResult = await supabase
                            .from('auctions')
                            .upsert(chunkWithoutMetadata, { onConflict: 'auction_id', ignoreDuplicates: false });
                        
                        data = fallbackResult.data;
                        error = fallbackResult.error;
                    }

                    if (error) {
                        console.warn('❌ Database auction cache error:', error);
                        updateCacheStats('errors');
                        
                        // If Supabase fails, continue with localStorage caching
                        console.log('💾 Supabase failed, using localStorage for auction persistence...');
                        chunk.forEach((auction) => {
                            try {
                                const id = auction.auction_id;
                                const key = getCacheKey('auction', id);
                                setCache(key, auction, 'auctions');
                                localStorage.setItem(`auction_${id}`, JSON.stringify(auction));
                            } catch (e) {
                                console.warn('localStorage auction cache error:', e);
                            }
                        });
                    } else {
                        console.log(`✅ Cached ${chunk.length} auctions [${i + 1}-${i + chunk.length}]`);
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
                console.warn('❌ Error caching auctions:', error);
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
            console.log(`📦 Retrieved ${cachedData.length} auctions from memory cache`);
            return cachedData;
        }

        // Fallback to localStorage if no Supabase
        if (!supabase) {
            console.log('🔍 Supabase unavailable, checking localStorage for auctions...');
            try {
                const keys = Object.keys(localStorage).filter(key => key.startsWith('auction_'));
                const localAuctions = keys.map(key => {
                    try {
                        const auctionData = JSON.parse(localStorage.getItem(key));
                        // Ensure auction has valid ID and normalize structure
                        if (!auctionData.id && !auctionData.auctionId && auctionData.auction_id) {
                            auctionData.id = auctionData.auction_id;
                            auctionData.auctionId = auctionData.auction_id;
                        }
                        
                        // Ensure all required fields are present with defaults
                        return {
                            id: auctionData.id || auctionData.auctionId || `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                            auctionId: auctionData.auctionId || auctionData.id,
                            seller: auctionData.seller || '0x0000000000000000000000000000000000000000',
                            nftContract: auctionData.nftContract || auctionData.nft_contract || '0x0000000000000000000000000000000000000000',
                            tokenId: auctionData.tokenId || auctionData.token_id || '0',
                            quantity: auctionData.quantity || '1',
                            reservePrice: auctionData.reservePrice || auctionData.reserve_price || '0',
                            startPrice: auctionData.startPrice || auctionData.start_price || '0',
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
                    } catch (e) {
                        console.warn('Error parsing localStorage auction:', e);
                        return null;
                    }
                }).filter(auction => auction && auction.id && auction.id !== 'undefined');
                
                console.log(`📦 Retrieved ${localAuctions.length} auctions from localStorage`);
                if (localAuctions.length > 0) {
                    setCache(cacheKey, localAuctions, 'auctions');
                }
                return localAuctions;
            } catch (e) {
                console.warn('localStorage auction retrieval error:', e);
                return [];
            }
        }

        try {
            console.log(`🔍 Fetching cached auctions from Supabase${sellerAddress ? ` for seller ${sellerAddress}` : ''}${marketplaceAddress ? ` for marketplace ${marketplaceAddress}` : ''}...`);
            
            let query = supabase
                .from('auctions')
                .select('*');

            if (sellerAddress) {
                query = query.eq('seller', sellerAddress);
            }

            if (marketplaceAddress) {
                query = query.eq('marketplace_address', marketplaceAddress.toLowerCase());
            }

            // Try to order by timestamp, fallback to created_at if timestamp doesn't exist
            try {
                query = query.order('timestamp', { ascending: false });
            } catch (timestampError) {
                console.warn('⚠️ timestamp column not found, using created_at instead');
                query = query.order('created_at', { ascending: false });
            }

            const { data, error } = await query;

            if (error) {
                console.warn('Error fetching cached auctions:', error);
                updateCacheStats('errors');
                
                // Fallback to localStorage on Supabase error
                console.log('🔄 Supabase error, falling back to localStorage...');
                try {
                    const keys = Object.keys(localStorage).filter(key => key.startsWith('auction_'));
                    const localAuctions = keys.map(key => {
                        try {
                            const auctionData = JSON.parse(localStorage.getItem(key));
                            // Ensure auction has valid ID
                            if (!auctionData.id && !auctionData.auctionId && auctionData.auction_id) {
                                auctionData.id = auctionData.auction_id;
                                auctionData.auctionId = auctionData.auction_id;
                            }
                            return auctionData;
                        } catch (e) {
                            return null;
                        }
                    }).filter(auction => auction && (auction.id || auction.auctionId));
                    
                    console.log(`📦 Retrieved ${localAuctions.length} auctions from localStorage fallback`);
                    return localAuctions;
                } catch (e) {
                    console.warn('localStorage fallback error:', e);
                    return [];
                }
            }

            console.log(`📦 Retrieved ${data.length} cached auctions from database`);

            const auctions = data.map((item) => {
                // Ensure auction ID is properly set
                const auctionId = item.auction_id || `db_${item.id}`;
                
                return {
                    id: auctionId,
                    auctionId: auctionId,
                    seller: item.seller || '0x0000000000000000000000000000000000000000',
                    nftContract: item.nft_contract || '0x0000000000000000000000000000000000000000',
                    tokenId: item.token_id || '0',
                    quantity: item.quantity || '1',
                    reservePrice: item.reserve_price || '0',
                    startPrice: item.start_price || '0',
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
            }).filter(auction => auction.id && auction.id !== 'undefined');

            const cacheKey = sellerAddress ? `auctions_${sellerAddress.toLowerCase()}` : 'all_auctions';
            setCache(cacheKey, auctions, 'auctions');
            return auctions;
        } catch (error) {
            console.warn('Error retrieving cached auctions:', error);
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
            console.log(`🔍 Fetching bids for auction ${auctionId}...`);
            
            // Handle undefined auctionId
            if (!auctionId || auctionId === 'undefined') {
                console.warn('⚠️ Invalid auction ID provided to getAuctionBids');
                return [];
            }
            
            let query = supabase
                .from('auction_bids')
                .select('*')
                .eq('auction_id', auctionId);

            // Try to order by timestamp, fallback to created_at if timestamp doesn't exist
            try {
                query = query.order('timestamp', { ascending: false });
            } catch (timestampError) {
                console.warn('⚠️ timestamp column not found in auction_bids, using created_at instead');
                query = query.order('created_at', { ascending: false });
            }

            const { data, error } = await query;

            if (error) {
                console.warn('Error fetching auction bids:', error);
                updateCacheStats('errors');
                return [];
            }

            console.log(`📦 Retrieved ${data.length} bids for auction ${auctionId}`);

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
            console.warn('Error retrieving auction bids:', error);
            updateCacheStats('errors');
            return [];
        }
    }, [supabase]);

    const subscribeToAuctions = useCallback((callback) => {
        if (!supabase) return null;
        try {
            console.log('🔄 Setting up real-time subscription for auctions...');
            const subscription = supabase
                .channel('auctions')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'auctions' },
                    (payload) => {
                        console.log('📡 Real-time auction update:', payload);
                        clearCache('auction');
                        clearCache('all_auctions');
                        if (callback) callback(payload);
                    }
                )
                .subscribe();

            subscriptions.current.set('auctions', subscription);
            return subscription;
        } catch (error) {
            console.warn('Error setting up auctions subscription:', error);
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
