/**
 * Listings sync (ported from api/sync-listings.js — Vercel → Express/pg).
 * Discovers ListingCreated / ListingCanceled events, reads on-chain listing
 * state, fetches metadata, and upserts into marketplace_listings. Incremental
 * progress is tracked in marketplace_sync_meta.
 *
 * The only change from the original is the storage layer: Supabase upserts
 * became parameterized pg queries.
 */
const { ethers } = require('ethers');
const { pool } = require('../db/pgClient');

const MARKETPLACE_ABI = [
    { inputs: [{ internalType: 'uint256', name: 'listingId', type: 'uint256' }], name: 'listings', outputs: [
        { internalType: 'address', name: 'seller', type: 'address' },
        { internalType: 'address', name: 'nftContract', type: 'address' },
        { internalType: 'uint256', name: 'tokenId', type: 'uint256' },
        { internalType: 'uint256', name: 'quantity', type: 'uint256' },
        { internalType: 'uint256', name: 'pricePerUnit', type: 'uint256' },
        { internalType: 'address', name: 'paymentToken', type: 'address' },
        { internalType: 'bool', name: 'isERC1155', type: 'bool' },
        { internalType: 'bool', name: 'active', type: 'bool' },
    ], stateMutability: 'view', type: 'function' },
    { anonymous: false, inputs: [
        { indexed: true, name: 'listingId', type: 'uint256' },
        { indexed: true, name: 'seller', type: 'address' },
        { indexed: true, name: 'nftContract', type: 'address' },
        { indexed: false, name: 'tokenId', type: 'uint256' },
        { indexed: false, name: 'quantity', type: 'uint256' },
        { indexed: false, name: 'pricePerUnit', type: 'uint256' },
        { indexed: false, name: 'paymentToken', type: 'address' },
        { indexed: false, name: 'isERC1155', type: 'bool' },
    ], name: 'ListingCreated', type: 'event' },
    { anonymous: false, inputs: [
        { indexed: true, name: 'listingId', type: 'uint256' },
        { indexed: true, name: 'seller', type: 'address' },
    ], name: 'ListingCanceled', type: 'event' },
];

const CONFIG = {
    LISTING_EVENT_CHUNK: parseInt(process.env.LISTING_EVENT_CHUNK || '6000', 10),
    METADATA_TIMEOUT: 8000,
    MAX_PARALLEL: 20,
    MAX_EXECUTION_TIME: 240000,
    MAX_BLOCK_RANGE: 50000,
};

let provider, marketplace;

function init() {
    const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
    provider = new ethers.JsonRpcProvider(rpcUrl);
    const marketplaceAddress = process.env.VITE_MARKETPLACE_ADDRESS;
    if (!marketplaceAddress || marketplaceAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error('Marketplace address not configured (VITE_MARKETPLACE_ADDRESS)');
    }
    marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);
}

async function getLastSyncMeta() {
    const { rows } = await pool.query(`SELECT last_block FROM marketplace_sync_meta WHERE key = 'listing_events'`);
    return rows[0] || null;
}
async function setLastSyncMeta(blockNumber) {
    await pool.query(
        `INSERT INTO marketplace_sync_meta (key, last_block, updated_at)
         VALUES ('listing_events', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = NOW()`,
        [blockNumber],
    );
}

async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(id); }
}

async function discoverNewListingIds(fromBlock, toBlock) {
    const ev = marketplace.filters.ListingCreated();
    const ids = [];
    for (let start = fromBlock; start <= toBlock; start += CONFIG.LISTING_EVENT_CHUNK) {
        const end = Math.min(start + CONFIG.LISTING_EVENT_CHUNK - 1, toBlock);
        try {
            const events = await marketplace.queryFilter(ev, start, end);
            events.forEach((e) => ids.push(e.args.listingId.toString()));
        } catch (err) { console.warn(`events ${start}-${end}:`, err.message); }
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
            events.forEach((e) => canceled.add(e.args.listingId.toString()));
        } catch (err) { console.warn(`cancel events ${start}-${end}:`, err.message); }
    }
    return canceled;
}

async function fetchListingOnChain(listingId) {
    try {
        const data = await marketplace.listings(listingId);
        if (data.seller === ethers.ZeroAddress) return null;
        return {
            id: listingId, seller: data.seller, nftContract: data.nftContract,
            tokenId: data.tokenId.toString(), quantity: data.quantity.toString(),
            pricePerUnit: data.pricePerUnit.toString(), paymentToken: data.paymentToken,
            isERC1155: data.isERC1155, active: data.active,
        };
    } catch (err) { console.warn(`listing ${listingId}:`, err.message); return null; }
}

async function fetchNFTMetadata(nftContract, tokenId) {
    const nftAbi = ['function tokenURI(uint256) view returns (string)', 'function uri(uint256) view returns (string)'];
    try {
        const c = new ethers.Contract(nftContract, nftAbi, provider);
        let tokenURI;
        try { tokenURI = await c.tokenURI(tokenId); } catch { tokenURI = await c.uri(tokenId); }
        if (!tokenURI) return {};
        if (tokenURI.startsWith('ipfs://')) tokenURI = `https://ipfs.io/ipfs/${tokenURI.slice(7)}`;
        const meta = await fetchJson(tokenURI, CONFIG.METADATA_TIMEOUT);
        if (meta.image?.startsWith('ipfs://')) meta.image = `https://ipfs.io/ipfs/${meta.image.slice(7)}`;
        return { metadata: meta, name: meta.name || `Token #${tokenId}`, description: meta.description || null, image: meta.image || null };
    } catch (err) { console.warn(`metadata ${nftContract}:${tokenId}:`, err.message); return {}; }
}

async function upsertListingRows(rows) {
    for (const l of rows) {
        await pool.query(
            `INSERT INTO marketplace_listings
               (listing_id, seller, nft_contract, token_id, quantity, price_per_unit,
                payment_token, is_erc1155, active, metadata, image_url, name, description, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
             ON CONFLICT (listing_id) DO UPDATE SET
               seller = EXCLUDED.seller, nft_contract = EXCLUDED.nft_contract,
               token_id = EXCLUDED.token_id, quantity = EXCLUDED.quantity,
               price_per_unit = EXCLUDED.price_per_unit, payment_token = EXCLUDED.payment_token,
               is_erc1155 = EXCLUDED.is_erc1155, active = EXCLUDED.active,
               metadata = EXCLUDED.metadata, image_url = EXCLUDED.image_url,
               name = EXCLUDED.name, description = EXCLUDED.description, updated_at = NOW()`,
            [l.listing_id, l.seller, l.nft_contract, l.token_id, l.quantity, l.price_per_unit,
                l.payment_token, l.is_erc1155, l.active, l.metadata, l.image_url, l.name, l.description],
        );
    }
}

async function syncListings(fullRescan = false, liteSync = false) {
    const startTime = Date.now();
    const latest = await provider.getBlockNumber();
    let fromBlock = 0;
    const meta = await getLastSyncMeta();
    if (meta && !fullRescan) fromBlock = Number(meta.last_block) + 1;

    let maxBlockRange = CONFIG.MAX_BLOCK_RANGE;
    if (liteSync) maxBlockRange = Math.min(maxBlockRange, 10000);
    const maxToBlock = Math.min(latest, fromBlock + maxBlockRange);
    const effectiveToBlock = fullRescan ? maxToBlock : latest;

    const newIds = await discoverNewListingIds(fromBlock, effectiveToBlock);
    const canceled = await fetchCanceledListings(fromBlock, effectiveToBlock);

    let limitedNewIds = newIds;
    if (liteSync && newIds.length > 100) limitedNewIds = newIds.slice(0, 100);

    const listingsMap = new Map();
    for (let i = 0; i < limitedNewIds.length; i += CONFIG.MAX_PARALLEL) {
        const chunk = limitedNewIds.slice(i, i + CONFIG.MAX_PARALLEL);
        await Promise.allSettled(chunk.map(async (id) => {
            const onchain = await fetchListingOnChain(id);
            if (onchain) listingsMap.set(id, onchain);
        }));
    }

    const listingArr = [...listingsMap.values()];
    if (!liteSync && listingArr.length > 0) {
        const metaBatchSize = Math.min(CONFIG.MAX_PARALLEL, 15);
        for (let i = 0; i < listingArr.length; i += metaBatchSize) {
            const chunk = listingArr.slice(i, i + metaBatchSize);
            await Promise.allSettled(chunk.map(async (l) => Object.assign(l, await fetchNFTMetadata(l.nftContract, l.tokenId))));
        }
    } else {
        listingArr.forEach((l) => { l.name = l.name || `Token #${l.tokenId}`; l.metadata = {}; l.image = null; l.description = null; });
    }

    const upsertRows = listingArr.map((l) => ({
        listing_id: l.id, seller: l.seller.toLowerCase(), nft_contract: l.nftContract.toLowerCase(),
        token_id: l.tokenId, quantity: l.quantity, price_per_unit: l.pricePerUnit,
        payment_token: l.paymentToken.toLowerCase(), is_erc1155: l.isERC1155,
        active: l.active && !canceled.has(l.id), metadata: l.metadata || {},
        image_url: l.image || null, name: l.name || null, description: l.description || null,
    }));

    if (upsertRows.length > 0) await upsertListingRows(upsertRows);

    if (canceled.size > 0) {
        for (const cId of canceled) {
            await pool.query(`UPDATE marketplace_listings SET active = false, updated_at = NOW() WHERE listing_id = $1`, [cId]);
        }
    }

    await setLastSyncMeta(effectiveToBlock);
    return {
        newListingIds: newIds.length, processedListings: limitedNewIds.length,
        upserted: upsertRows.length, canceled: canceled.size, latestBlock: latest,
        fromBlock, effectiveToBlock, executionTimeMs: Date.now() - startTime,
        partialSync: effectiveToBlock < latest, liteMode: liteSync,
    };
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const start = Date.now();
    try {
        init();
        const body = req.method === 'POST' ? req.body || {} : {};
        const fullRescan = body.fullRescan === true;
        const liteSync = body.liteSync === true;
        const stats = await syncListings(fullRescan, liteSync);
        return res.status(200).json({ success: true, stats, durationMs: Date.now() - start });
    } catch (e) {
        return res.status(500).json({ error: e.message, durationMs: Date.now() - start });
    }
};
module.exports.syncListings = async (opts = {}) => { init(); return syncListings(opts.fullRescan === true, opts.liteSync !== false); };
