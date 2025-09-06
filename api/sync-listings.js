import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

// Import ABI and utilities - we'll need to duplicate some logic from the frontend
const MARKETPLACE_ABI = [
    {
        "inputs": [{"internalType": "uint256", "name": "listingId", "type": "uint256"}],
        "name": "listings",
        "outputs": [
            {"internalType": "address", "name": "seller", "type": "address"},
            {"internalType": "address", "name": "nftContract", "type": "address"},
            {"internalType": "uint256", "name": "tokenId", "type": "uint256"},
            {"internalType": "uint256", "name": "quantity", "type": "uint256"},
            {"internalType": "uint256", "name": "pricePerUnit", "type": "uint256"},
            {"internalType": "address", "name": "paymentToken", "type": "address"},
            {"internalType": "bool", "name": "isERC1155", "type": "bool"},
            {"internalType": "bool", "name": "active", "type": "bool"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "uint256", "name": "listingId", "type": "uint256"},
            {"indexed": true, "internalType": "address", "name": "seller", "type": "address"},
            {"indexed": true, "internalType": "address", "name": "nftContract", "type": "address"},
            {"indexed": false, "internalType": "uint256", "name": "tokenId", "type": "uint256"},
            {"indexed": false, "internalType": "uint256", "name": "quantity", "type": "uint256"},
            {"indexed": false, "internalType": "uint256", "name": "pricePerUnit", "type": "uint256"},
            {"indexed": false, "internalType": "address", "name": "paymentToken", "type": "address"},
            {"indexed": false, "internalType": "bool", "name": "isERC1155", "type": "bool"}
        ],
        "name": "ListingCreated",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "uint256", "name": "listingId", "type": "uint256"},
            {"indexed": true, "internalType": "address", "name": "seller", "type": "address"}
        ],
        "name": "ListingCanceled",
        "type": "event"
    }
];

// Configuration
const MARKETPLACE_CONFIG = {
    MAX_LISTING_SCAN: 2000,
    MIN_LISTING_SCAN: 1,
    BATCH_SIZE: 100,
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000
};

// Initialize providers
let provider;
let supabase;
let marketplace;

function initializeClients() {
    // Initialize Ethereum provider
    const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
    provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Initialize Supabase
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
        throw new Error('Supabase credentials not configured');
    }
    
    supabase = createClient(supabaseUrl, supabaseKey);
    
    // Initialize marketplace contract
    const marketplaceAddress = process.env.VITE_MARKETPLACE_ADDRESS;
    if (!marketplaceAddress) {
        throw new Error('Marketplace address not configured');
    }
    
    marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);
    
    console.log(`✅ Initialized clients - Marketplace: ${marketplaceAddress}`);
}

// Fetch NFT metadata from tokenURI
async function fetchNFTMetadata(nftContract, tokenId) {
    try {
        // Standard ERC721/ERC1155 metadata interface
        const nftAbi = [
            'function tokenURI(uint256 tokenId) external view returns (string memory)',
            'function uri(uint256 id) external view returns (string memory)' // ERC1155
        ];
        
        const nft = new ethers.Contract(nftContract, nftAbi, provider);
        let tokenURI;
        
        try {
            tokenURI = await nft.tokenURI(tokenId);
        } catch {
            // Try ERC1155 uri method
            tokenURI = await nft.uri(tokenId);
        }
        
        if (!tokenURI) return null;
        
        // Resolve IPFS URLs
        if (tokenURI.startsWith('ipfs://')) {
            tokenURI = `https://ipfs.io/ipfs/${tokenURI.slice(7)}`;
        }
        
        // Fetch metadata
        const response = await fetch(tokenURI, { 
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const metadata = await response.json();
        
        // Resolve image URLs
        if (metadata.image?.startsWith('ipfs://')) {
            metadata.image = `https://ipfs.io/ipfs/${metadata.image.slice(7)}`;
        }
        
        return metadata;
    } catch (error) {
        console.warn(`Failed to fetch metadata for ${nftContract}:${tokenId}:`, error.message);
        return null;
    }
}

// Get canceled listings from events
async function getCanceledListings() {
    try {
        const cancelFilter = marketplace.filters.ListingCanceled();
        const cancelEvents = await marketplace.queryFilter(cancelFilter, -50000); // Last ~50k blocks
        
        return new Set(cancelEvents.map(event => event.args.listingId.toString()));
    } catch (error) {
        console.warn('Failed to fetch canceled listings:', error.message);
        return new Set();
    }
}

// Scan blockchain for listings
async function scanBlockchainListings() {
    console.log('🔍 Starting blockchain scan for listings...');
    
    const canceledSet = await getCanceledListings();
    console.log(`📋 Found ${canceledSet.size} canceled listings`);
    
    const activeListings = [];
    const maxScan = MARKETPLACE_CONFIG.MAX_LISTING_SCAN;
    let processed = 0;
    
    for (let i = MARKETPLACE_CONFIG.MIN_LISTING_SCAN; i <= maxScan; i += MARKETPLACE_CONFIG.BATCH_SIZE) {
        const batchEnd = Math.min(i + MARKETPLACE_CONFIG.BATCH_SIZE - 1, maxScan);
        const batchIds = Array.from({ length: batchEnd - i + 1 }, (_, idx) => i + idx);
        
        try {
            // Batch fetch listing data
            const batchPromises = batchIds.map(async (listingId) => {
                try {
                    const listing = await marketplace.listings(listingId);
                    
                    // Check if listing exists and is active
                    if (listing.seller === '0x0000000000000000000000000000000000000000') {
                        return null; // Listing doesn't exist
                    }
                    
                    const isCanceled = canceledSet.has(listingId.toString());
                    const isActive = listing.active && !isCanceled;
                    
                    if (!isActive) return null;
                    
                    // Fetch metadata in parallel
                    const metadata = await fetchNFTMetadata(listing.nftContract, listing.tokenId.toString());
                    
                    return {
                        id: listingId.toString(),
                        seller: listing.seller,
                        nftContract: listing.nftContract,
                        tokenId: listing.tokenId.toString(),
                        quantity: listing.quantity.toString(),
                        pricePerUnit: listing.pricePerUnit.toString(),
                        paymentToken: listing.paymentToken,
                        isERC1155: listing.isERC1155,
                        active: true,
                        metadata: metadata || {},
                        name: metadata?.name || `Token #${listing.tokenId}`,
                        description: metadata?.description || null,
                        image: metadata?.image || null
                    };
                } catch (error) {
                    console.warn(`Failed to fetch listing ${listingId}:`, error.message);
                    return null;
                }
            });
            
            const batchResults = await Promise.allSettled(batchPromises);
            const batchListings = batchResults
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);
            
            activeListings.push(...batchListings);
            processed += batchIds.length;
            
            const progress = ((processed / maxScan) * 100).toFixed(1);
            console.log(`📊 Batch ${i}-${batchEnd}: Found ${batchListings.length} active listings (${progress}% complete)`);
            
        } catch (error) {
            console.error(`❌ Batch ${i}-${batchEnd} failed:`, error.message);
        }
    }
    
    console.log(`✅ Blockchain scan complete: ${activeListings.length} active listings found`);
    return activeListings;
}

// Cache listings to Supabase
async function cacheListingsToSupabase(listings) {
    try {
        console.log(`💾 Caching ${listings.length} listings to Supabase...`);
        
        const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
        
        const rows = listings.map(listing => ({
            listing_id: listing.id,
            seller: listing.seller.toLowerCase(),
            nft_contract: listing.nftContract.toLowerCase(),
            token_id: listing.tokenId,
            quantity: listing.quantity,
            price_per_unit: listing.pricePerUnit,
            payment_token: listing.paymentToken.toLowerCase(),
            is_erc1155: listing.isERC1155,
            active: true,
            metadata: listing.metadata,
            image_url: listing.image,
            name: listing.name,
            description: listing.description,
            updated_at: new Date().toISOString()
        }));
        
        // Clear existing listings first
        await supabase
            .from('marketplace_listings')
            .delete()
            .neq('listing_id', 'impossible_id'); // Delete all
        
        // Insert new listings in batches
        const batchSize = 100;
        let inserted = 0;
        
        for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);
            
            const { error } = await supabase
                .from('marketplace_listings')
                .insert(batch);
            
            if (error) {
                console.error(`❌ Failed to insert batch ${i}-${i + batch.length}:`, error.message);
            } else {
                inserted += batch.length;
                console.log(`✅ Inserted batch ${i}-${i + batch.length} (${inserted}/${rows.length})`);
            }
        }
        
        console.log(`💾 Cached ${inserted} listings successfully`);
        return inserted;
        
    } catch (error) {
        console.error('❌ Failed to cache listings:', error.message);
        throw error;
    }
}

// Main handler
export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Only allow GET and POST methods
    if (!['GET', 'POST'].includes(req.method)) {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const startTime = Date.now();
    
    try {
        // Verify authorization for cron jobs
        const authHeader = req.headers.authorization;
        const cronSecret = process.env.CRON_SECRET;
        
        if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
            console.warn('❌ Unauthorized sync attempt');
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        console.log('🚀 Starting listings sync...');
        
        // Initialize clients
        initializeClients();
        
        // Scan blockchain for active listings
        const listings = await scanBlockchainListings();
        
        // Cache to Supabase
        const cached = await cacheListingsToSupabase(listings);
        
        const duration = Date.now() - startTime;
        const result = {
            success: true,
            timestamp: new Date().toISOString(),
            duration: `${duration}ms`,
            stats: {
                scanned: MARKETPLACE_CONFIG.MAX_LISTING_SCAN,
                found: listings.length,
                cached: cached
            }
        };
        
        console.log('✅ Sync completed:', result);
        
        return res.status(200).json(result);
        
    } catch (error) {
        console.error('❌ Sync failed:', error.message);
        
        const duration = Date.now() - startTime;
        return res.status(500).json({
            error: error.message,
            timestamp: new Date().toISOString(),
            duration: `${duration}ms`
        });
    }
}