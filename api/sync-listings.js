/**
 * Enhanced listings sync:
 * - Discovers listing IDs via ListingCreated events chunked from genesis
 * - Incremental: stores last_listing_event_block in marketplace_sync_meta (table must exist or will be created manually)
 * - Upsert listings instead of delete-all
 * - Marks inactive listings (canceled or on-chain inactive)
 */
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const MARKETPLACE_ABI = [
    {
        inputs: [{ internalType: 'uint256', name: 'listingId', type: 'uint256' }],
        name: 'listings',
        outputs: [
            { internalType: 'address', name: 'seller', type: 'address' },
            { internalType: 'address', name: 'nftContract', type: 'address' },
            { internalType: 'uint256', name: 'tokenId', type: 'uint256' },
            { internalType: 'uint256', name: 'quantity', type: 'uint256' },
            { internalType: 'uint256', name: 'pricePerUnit', type: 'uint256' },
            { internalType: 'address', name: 'paymentToken', type: 'address' },
            { internalType: 'bool', name: 'isERC1155', type: 'bool' },
            { internalType: 'bool', name: 'active', type: 'bool' }
        ],
        stateMutability: 'view',
        type: 'function'
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'uint256', name: 'listingId', type: 'uint256' },
            { indexed: true, internalType: 'address', name: 'seller', type: 'address' },
            { indexed: true, internalType: 'address', name: 'nftContract', type: 'address' },
            { indexed: false, internalType: 'uint256', name: 'tokenId', type: 'uint256' },
            { indexed: false, internalType: 'uint256', name: 'quantity', type: 'uint256' },
            { indexed: false, internalType: 'uint256', name: 'pricePerUnit', type: 'uint256' },
            { indexed: false, internalType: 'address', name: 'paymentToken', type: 'address' },
            { indexed: false, internalType: 'bool', name: 'isERC1155', type: 'bool' }
        ],
        name: 'ListingCreated',
        type: 'event'
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'uint256', name: 'listingId', type: 'uint256' },
            { indexed: true, internalType: 'address', name: 'seller', type: 'address' }
        ],
        name: 'ListingCanceled',
        type: 'event'
    }
];

const CONFIG = {
    LISTING_EVENT_CHUNK: parseInt(process.env.LISTING_EVENT_CHUNK || '6000', 10),
    METADATA_TIMEOUT: 8000, // Reduced from 12s to 8s
    MAX_PARALLEL: 20, // Reduced from 40 to 20 to prevent overwhelming services
    MAX_EXECUTION_TIME: 240000, // 4 minutes (240s) - leave 60s buffer before Vercel timeout
    MAX_BLOCK_RANGE: 50000, // Limit block range per execution to prevent infinite scans
    CHECKPOINT_INTERVAL: 10000 // Save progress every 10 seconds
};

let provider;
let supabase;
let marketplace;

function init() {
    const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
    provider = new ethers.JsonRpcProvider(rpcUrl);
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) throw new Error('Supabase credentials not configured');
    supabase = createClient(supabaseUrl, supabaseKey);
    const marketplaceAddress = process.env.VITE_MARKETPLACE_ADDRESS;
    if (!marketplaceAddress) throw new Error('Marketplace address not configured');
    marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);
}

async function getLastSyncMeta() {
    const { data, error } = await supabase
        .from('marketplace_sync_meta')
        .select('*')
        .eq('key', 'listing_events')
        .single();
    if (error) return null;
    return data;
}

async function setLastSyncMeta(blockNumber) {
    await supabase.from('marketplace_sync_meta').upsert({
        key: 'listing_events',
        last_block: blockNumber,
        updated_at: new Date().toISOString()
    });
}

async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        clearTimeout(id);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

async function discoverNewListingIds(fromBlock, toBlock) {
    const ev = marketplace.filters.ListingCreated();
    const ids = [];
    console.log(`Discovering listing events from block ${fromBlock} to ${toBlock}`);
    
    for (let start = fromBlock; start <= toBlock; start += CONFIG.LISTING_EVENT_CHUNK) {
        const end = Math.min(start + CONFIG.LISTING_EVENT_CHUNK - 1, toBlock);
        try {
            // Add timeout for event queries (can be slow on large ranges)
            const queryTimeout = 15000; // 15 seconds per chunk
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Event query timeout')), queryTimeout)
            );
            
            const events = await Promise.race([
                marketplace.queryFilter(ev, start, end),
                timeoutPromise
            ]);
            
            events.forEach(e => ids.push(e.args.listingId.toString()));
            
            if (start % (CONFIG.LISTING_EVENT_CHUNK * 5) === 0) {
                console.log(`Processed events up to block ${end}, found ${ids.length} total listings`);
            }
        } catch (err) {
            console.warn(`Failed to query events for blocks ${start}-${end}:`, err.message);
            // Continue with next chunk instead of failing completely
        }
    }
    
    console.log(`Found ${ids.length} total listing events`);
    return ids;
}

async function fetchCanceledListings(fromBlock, toBlock) {
    const cancelEv = marketplace.filters.ListingCanceled();
    const canceled = new Set();
    console.log(`Discovering canceled events from block ${fromBlock} to ${toBlock}`);
    
    for (let start = fromBlock; start <= toBlock; start += CONFIG.LISTING_EVENT_CHUNK) {
        const end = Math.min(start + CONFIG.LISTING_EVENT_CHUNK - 1, toBlock);
        try {
            // Add timeout for cancel event queries
            const queryTimeout = 15000; // 15 seconds per chunk
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Cancel event query timeout')), queryTimeout)
            );
            
            const events = await Promise.race([
                marketplace.queryFilter(cancelEv, start, end),
                timeoutPromise
            ]);
            
            events.forEach(e => canceled.add(e.args.listingId.toString()));
        } catch (err) {
            console.warn(`Failed to query cancel events for blocks ${start}-${end}:`, err.message);
            // Continue with next chunk
        }
    }
    
    console.log(`Found ${canceled.size} canceled listings`);
    return canceled;
}

async function fetchListingOnChain(listingId) {
    const timeout = CONFIG.METADATA_TIMEOUT;
    try {
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), timeout)
        );
        
        const data = await Promise.race([
            marketplace.listings(listingId),
            timeoutPromise
        ]);
        
        if (data.seller === ethers.ZeroAddress) return null;
        return {
            id: listingId,
            seller: data.seller,
            nftContract: data.nftContract,
            tokenId: data.tokenId.toString(),
            quantity: data.quantity.toString(),
            pricePerUnit: data.pricePerUnit.toString(),
            paymentToken: data.paymentToken,
            isERC1155: data.isERC1155,
            active: data.active
        };
    } catch (err) {
        console.warn(`Failed to fetch listing ${listingId}:`, err.message);
        return null;
    }
}

async function fetchNFTMetadata(nftContract, tokenId) {
    const nftAbi = [
        'function tokenURI(uint256 tokenId) view returns (string)',
        'function uri(uint256 id) view returns (string)'
    ];
    try {
        const c = new ethers.Contract(nftContract, nftAbi, provider);
        let tokenURI;
        
        // Add timeout protection to contract calls
        const contractTimeout = 5000; // 5 seconds for contract calls
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Contract call timeout')), contractTimeout)
        );
        
        try {
            tokenURI = await Promise.race([c.tokenURI(tokenId), timeoutPromise]);
        } catch {
            tokenURI = await Promise.race([c.uri(tokenId), timeoutPromise]);
        }
        
        if (!tokenURI) return {};
        if (tokenURI.startsWith('ipfs://')) {
            tokenURI = `https://ipfs.io/ipfs/${tokenURI.slice(7)}`;
        }
        
        const meta = await fetchJson(tokenURI, CONFIG.METADATA_TIMEOUT);
        if (meta.image?.startsWith('ipfs://')) {
            meta.image = `https://ipfs.io/ipfs/${meta.image.slice(7)}`;
        }
        return {
            metadata: meta,
            name: meta.name || `Token #${tokenId}`,
            description: meta.description || null,
            image: meta.image || null
        };
    } catch (err) {
        console.warn(`Failed to fetch metadata for ${nftContract}:${tokenId}:`, err.message);
        return {};
    }
}

async function syncListings(fullRescan = false, liteSync = false) {
    const startTime = Date.now();
    const latest = await provider.getBlockNumber();
    let fromBlock = 0;
    const meta = await getLastSyncMeta();
    if (meta && !fullRescan) {
        fromBlock = meta.last_block + 1;
    }
    
    // For lite sync mode, limit the scope further
    let maxBlockRange = CONFIG.MAX_BLOCK_RANGE;
    if (liteSync) {
        maxBlockRange = Math.min(maxBlockRange, 10000); // Even smaller range for lite mode
    }
    
    // Limit block range to prevent timeouts
    const maxToBlock = Math.min(latest, fromBlock + maxBlockRange);
    const effectiveToBlock = fullRescan ? maxToBlock : latest;
    
    console.log(`Starting sync: fromBlock=${fromBlock}, toBlock=${effectiveToBlock}, latest=${latest}, fullRescan=${fullRescan}, liteSync=${liteSync}`);
    
    // Check time budget before expensive operations
    const checkTimeLimit = () => {
        const elapsed = Date.now() - startTime;
        const maxTime = liteSync ? CONFIG.MAX_EXECUTION_TIME / 2 : CONFIG.MAX_EXECUTION_TIME; // Shorter time for lite mode
        if (elapsed > maxTime) {
            throw new Error(`Execution time limit exceeded: ${elapsed}ms (limit: ${maxTime}ms)`);
        }
        return elapsed;
    };
    
    const newIds = await discoverNewListingIds(fromBlock, effectiveToBlock);
    checkTimeLimit(); // Check after event discovery
    
    const canceled = await fetchCanceledListings(fromBlock, effectiveToBlock);
    checkTimeLimit(); // Check after canceled listings
    
    console.log(`Discovered ${newIds.length} new listings, ${canceled.size} canceled`);
    
    // For lite sync, limit the number of listings processed
    let limitedNewIds = newIds;
    if (liteSync && newIds.length > 100) {
        limitedNewIds = newIds.slice(0, 100); // Process only first 100 in lite mode
        console.log(`Lite mode: limiting to ${limitedNewIds.length} listings`);
    }
    
    // Fetch on-chain details with time checking
    const listingsMap = new Map();
    const chunks = [];
    for (let i = 0; i < limitedNewIds.length; i += CONFIG.MAX_PARALLEL) {
        chunks.push(limitedNewIds.slice(i, i + CONFIG.MAX_PARALLEL));
    }
    
    let processedChunks = 0;
    for (const chunk of chunks) {
        await Promise.allSettled(chunk.map(async (id) => {
            try {
                const onchain = await fetchListingOnChain(id);
                if (onchain) listingsMap.set(id, onchain);
            } catch (err) {
                console.warn(`Failed to fetch listing ${id}:`, err.message);
            }
        }));
        
        processedChunks++;
        
        // Check time limit and save checkpoint every few chunks
        if (processedChunks % 5 === 0) {
            checkTimeLimit();
            console.log(`Processed ${processedChunks}/${chunks.length} on-chain chunks`);
        }
    }
    
    checkTimeLimit(); // Check before metadata phase
    
    // Attach metadata with time checking and reduced batch size for heavy operations
    const listingArr = [...listingsMap.values()];
    
    // For lite sync, skip metadata for faster execution
    if (!liteSync && listingArr.length > 0) {
        const metaChunks = [];
        const metaBatchSize = Math.min(CONFIG.MAX_PARALLEL, 15); // Smaller batches for metadata
        for (let i = 0; i < listingArr.length; i += metaBatchSize) {
            metaChunks.push(listingArr.slice(i, i + metaBatchSize));
        }
        
        let processedMetaChunks = 0;
        for (const chunk of metaChunks) {
            await Promise.allSettled(chunk.map(async (l) => {
                try {
                    const md = await fetchNFTMetadata(l.nftContract, l.tokenId);
                    Object.assign(l, md);
                } catch (err) {
                    console.warn(`Failed to fetch metadata for ${l.nftContract}:${l.tokenId}:`, err.message);
                }
            }));
            
            processedMetaChunks++;
            
            // Check time limit more frequently during metadata phase (most expensive)
            if (processedMetaChunks % 3 === 0) {
                checkTimeLimit();
                console.log(`Processed ${processedMetaChunks}/${metaChunks.length} metadata chunks`);
            }
        }
    } else if (liteSync && listingArr.length > 0) {
        console.log('Lite mode: skipping metadata fetch for faster execution');
        // Add minimal metadata for lite mode
        listingArr.forEach(l => {
            l.name = l.name || `Token #${l.tokenId}`;
            l.metadata = {};
            l.image = null;
            l.description = null;
        });
    }

    checkTimeLimit(); // Final check before database operations

    // Upsert active listings in smaller batches to avoid database timeouts
    const upsertRows = listingArr.map(l => ({
        listing_id: l.id,
        seller: l.seller.toLowerCase(),
        nft_contract: l.nftContract.toLowerCase(),
        token_id: l.tokenId,
        quantity: l.quantity,
        price_per_unit: l.pricePerUnit,
        payment_token: l.paymentToken.toLowerCase(),
        is_erc1155: l.isERC1155,
        active: l.active && !canceled.has(l.id),
        metadata: l.metadata || {},
        image_url: l.image || null,
        name: l.name || null,
        description: l.description || null,
        updated_at: new Date().toISOString()
    }));

    // Batch database operations to prevent timeouts
    if (upsertRows.length > 0) {
        const batchSize = 100; // Supabase recommended batch size
        for (let i = 0; i < upsertRows.length; i += batchSize) {
            const batch = upsertRows.slice(i, i + batchSize);
            const { error } = await supabase.from('marketplace_listings').upsert(batch, { onConflict: 'listing_id' });
            if (error) throw new Error(`Batch upsert failed: ${error.message}`);
            console.log(`Upserted batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(upsertRows.length/batchSize)}`);
        }
    }

    // Mark newly canceled in batches
    if (canceled.size > 0) {
        const canceledArray = Array.from(canceled);
        const batchSize = 50;
        for (let i = 0; i < canceledArray.length; i += batchSize) {
            const batch = canceledArray.slice(i, i + batchSize);
            await Promise.allSettled(batch.map(async (cId) => {
                await supabase.from('marketplace_listings')
                    .update({ active: false, updated_at: new Date().toISOString() })
                    .eq('listing_id', cId);
            }));
        }
    }

    // Save progress - use effectiveToBlock to ensure incremental progress
    await setLastSyncMeta(effectiveToBlock);
    
    const totalTime = Date.now() - startTime;
    console.log(`Sync completed in ${totalTime}ms`);
    
    return {
        newListingIds: newIds.length,
        processedListings: limitedNewIds.length, // Show actual processed count
        upserted: upsertRows.length,
        canceled: canceled.size,
        latestBlock: latest,
        fromBlock,
        effectiveToBlock,
        executionTimeMs: totalTime,
        partialSync: effectiveToBlock < latest, // Indicates if more work remains
        liteMode: liteSync,
        skippedListings: liteSync ? Math.max(0, newIds.length - limitedNewIds.length) : 0
    };
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

    const start = Date.now();
    try {
        init();
        const authHeader = req.headers.authorization;
        const cronSecret = process.env.CRON_SECRET;
        if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const body = req.method === 'POST' ? req.body || {} : {};
        const fullRescan = body.fullRescan === true;
        const liteSync = body.liteSync === true; // New lite mode for faster cron execution
        
        // For cron jobs, use lite sync by default unless explicitly requested
        const isCronRequest = authHeader && authHeader.startsWith('Bearer ');
        const syncMode = fullRescan ? 'full' : (liteSync || isCronRequest ? 'lite' : 'incremental');
        
        console.log(`Starting sync in ${syncMode} mode`);
        const stats = await syncListings(fullRescan, liteSync);
        
        return res.status(200).json({
            success: true,
            mode: syncMode,
            stats,
            durationMs: Date.now() - start
        });
    } catch (e) {
        return res.status(500).json({ error: e.message, durationMs: Date.now() - start });
    }
};