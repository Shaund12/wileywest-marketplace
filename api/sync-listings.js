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
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'uint256', name: 'listingId', type: 'uint256' },
            { indexed: true, internalType: 'address', name: 'buyer', type: 'address' },
            { indexed: false, internalType: 'uint256', name: 'quantity', type: 'uint256' },
            { indexed: false, internalType: 'uint256', name: 'totalPrice', type: 'uint256' },
            { indexed: false, internalType: 'address', name: 'paymentToken', type: 'address' }
        ],
        name: 'NFTPurchased',
        type: 'event'
    }
];

const CONFIG = {
    LISTING_EVENT_CHUNK: parseInt(process.env.LISTING_EVENT_CHUNK || '6000', 10),
    METADATA_TIMEOUT: 12000,
    MAX_PARALLEL: 40
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
    for (let start = fromBlock; start <= toBlock; start += CONFIG.LISTING_EVENT_CHUNK) {
        const end = Math.min(start + CONFIG.LISTING_EVENT_CHUNK - 1, toBlock);
        try {
            const events = await marketplace.queryFilter(ev, start, end);
            events.forEach(e => ids.push(e.args.listingId.toString()));
        } catch (err) {
            // skip problematic chunk
        }
    }
    return ids;
}

async function fetchCanceledListings(fromBlock, toBlock) {
    const cancelEv = marketplace.filters.ListingCanceled();
    const canceled = new Set();
    for (let start = fromBlock; start <= toBlock; start += CONFIG.LISTING_EVENT_CHUNK) {
        const end = Math.min(start + CONFIG.LISTING_EVENT_CHUNK - 1, toBlock);
        try {
            const events = await marketplace.queryFilter(cancelEv, start, end);
            events.forEach(e => canceled.add(e.args.listingId.toString()));
        } catch { }
    }
    return canceled;
}

async function fetchPurchasedListings(fromBlock, toBlock) {
    const purchaseEv = marketplace.filters.NFTPurchased();
    const purchased = new Set();
    for (let start = fromBlock; start <= toBlock; start += CONFIG.LISTING_EVENT_CHUNK) {
        const end = Math.min(start + CONFIG.LISTING_EVENT_CHUNK - 1, toBlock);
        try {
            const events = await marketplace.queryFilter(purchaseEv, start, end);
            events.forEach(e => purchased.add(e.args.listingId.toString()));
        } catch { }
    }
    return purchased;
}

async function fetchListingOnChain(listingId) {
    try {
        const data = await marketplace.listings(listingId);
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
    } catch {
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
        try {
            tokenURI = await c.tokenURI(tokenId);
        } catch {
            tokenURI = await c.uri(tokenId);
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
    } catch {
        return {};
    }
}

async function syncListings(fullRescan = false) {
    const latest = await provider.getBlockNumber();
    let fromBlock = 0;
    const meta = await getLastSyncMeta();
    if (meta && !fullRescan) {
        fromBlock = meta.last_block + 1;
    }
    const newIds = await discoverNewListingIds(fullRescan ? 0 : fromBlock, latest);
    const canceled = await fetchCanceledListings(fullRescan ? 0 : fromBlock, latest);
    const purchased = await fetchPurchasedListings(fullRescan ? 0 : fromBlock, latest);
    // Fetch on-chain details
    const listingsMap = new Map();
    const chunks = [];
    for (let i = 0; i < newIds.length; i += CONFIG.MAX_PARALLEL) {
        chunks.push(newIds.slice(i, i + CONFIG.MAX_PARALLEL));
    }
    for (const chunk of chunks) {
        await Promise.allSettled(chunk.map(async (id) => {
            const onchain = await fetchListingOnChain(id);
            if (onchain) listingsMap.set(id, onchain);
        }));
    }
    // Attach metadata
    const listingArr = [...listingsMap.values()];
    const metaChunks = [];
    for (let i = 0; i < listingArr.length; i += CONFIG.MAX_PARALLEL) {
        metaChunks.push(listingArr.slice(i, i + CONFIG.MAX_PARALLEL));
    }
    for (const chunk of metaChunks) {
        await Promise.allSettled(chunk.map(async (l) => {
            const md = await fetchNFTMetadata(l.nftContract, l.tokenId);
            Object.assign(l, md);
        }));
    }

    // Upsert active listings
    const upsertRows = listingArr.map(l => ({
        listing_id: l.id,
        seller: l.seller.toLowerCase(),
        nft_contract: l.nftContract.toLowerCase(),
        token_id: l.tokenId,
        quantity: l.quantity,
        price_per_unit: l.pricePerUnit,
        payment_token: l.paymentToken.toLowerCase(),
        is_erc1155: l.isERC1155,
        active: l.active && !canceled.has(l.id) && !purchased.has(l.id),
        metadata: l.metadata || {},
        image_url: l.image || null,
        name: l.name || null,
        description: l.description || null,
        updated_at: new Date().toISOString()
    }));

    if (upsertRows.length) {
        const { error } = await supabase.from('marketplace_listings').upsert(upsertRows, { onConflict: 'listing_id' });
        if (error) throw new Error(error.message);
    }

    // Mark newly canceled (only if listing exists and active)
    if (canceled.size) {
        for (const cId of canceled) {
            await supabase.from('marketplace_listings')
                .update({ active: false, updated_at: new Date().toISOString() })
                .eq('listing_id', cId);
        }
    }

    // Mark newly purchased (only if listing exists and active)
    if (purchased.size) {
        for (const pId of purchased) {
            await supabase.from('marketplace_listings')
                .update({ 
                    active: false, 
                    sale_status: 'sold',
                    updated_at: new Date().toISOString() 
                })
                .eq('listing_id', pId);
        }
    }

    await setLastSyncMeta(latest);
    return {
        newListingIds: newIds.length,
        upserted: upsertRows.length,
        canceled: canceled.size,
        purchased: purchased.size,
        latestBlock: latest,
        fromBlock
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
        const stats = await syncListings(fullRescan);
        return res.status(200).json({
            success: true,
            mode: fullRescan ? 'full' : 'incremental',
            stats,
            durationMs: Date.now() - start
        });
    } catch (e) {
        return res.status(500).json({ error: e.message, durationMs: Date.now() - start });
    }
};