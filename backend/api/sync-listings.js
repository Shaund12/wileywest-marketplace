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
    RPC_RETRIES: 2,
};

let provider, marketplaces;
const syncStatus = {
    chainId: Number(process.env.VITE_CHAIN_ID || 7847),
    lastSuccessfulRange: null,
    failedRange: null,
    retryCount: 0,
    lastError: null,
    discoveredListings: 0,
    persistedListings: 0,
    metadataFailures: 0,
};

function init() {
    const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
    const fallbackUrl = process.env.MARKETPLACE_RPC_FALLBACK_URL ||
        (process.env.VITE_CHAIN_ID === '1490'
            ? 'https://explorer.vitruveo.ai/api/eth-rpc'
            : 'https://explorer.hyvechain.com/api/eth-rpc');
    const providers = [...new Set([rpcUrl, fallbackUrl])].map((url) => new ethers.JsonRpcProvider(url));
    provider = new ethers.FallbackProvider(providers, undefined, { quorum: 1 });
    const marketplaceAddress = process.env.VITE_MARKETPLACE_ADDRESS;
    if (!marketplaceAddress || marketplaceAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error('Marketplace address not configured (VITE_MARKETPLACE_ADDRESS)');
    }
    marketplaces = providers.map((rpcProvider) => new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, rpcProvider));
}

async function queryEvents(filterName, fromBlock, toBlock) {
    let lastError;
    for (let attempt = 0; attempt <= CONFIG.RPC_RETRIES; attempt += 1) {
        for (const contract of marketplaces) {
            try {
                return await contract.queryFilter(contract.filters[filterName](), fromBlock, toBlock);
            } catch (error) {
                lastError = error;
            }
        }
    }
    syncStatus.failedRange = { fromBlock, toBlock };
    syncStatus.retryCount = (CONFIG.RPC_RETRIES + 1) * marketplaces.length;
    syncStatus.lastError = lastError?.message || 'RPC unavailable';
    throw new Error(`${filterName} ${fromBlock}-${toBlock} failed: ${lastError?.message || 'RPC unavailable'}`);
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
    const ids = [];
    for (let start = fromBlock; start <= toBlock; start += CONFIG.LISTING_EVENT_CHUNK) {
        const end = Math.min(start + CONFIG.LISTING_EVENT_CHUNK - 1, toBlock);
        const events = await queryEvents('ListingCreated', start, end);
        events.forEach((e) => ids.push(e.args.listingId.toString()));
    }
    return ids;
}

async function fetchCanceledListings(fromBlock, toBlock) {
    const canceled = new Set();
    for (let start = fromBlock; start <= toBlock; start += CONFIG.LISTING_EVENT_CHUNK) {
        const end = Math.min(start + CONFIG.LISTING_EVENT_CHUNK - 1, toBlock);
        const events = await queryEvents('ListingCanceled', start, end);
        events.forEach((e) => canceled.add(e.args.listingId.toString()));
    }
    return canceled;
}

async function fetchListingOnChain(listingId) {
    let lastError;
    for (const contract of marketplaces) {
        try {
            const data = await contract.listings(listingId);
            if (data.seller === ethers.ZeroAddress) throw new Error('listing returned an empty seller');
            return {
                id: listingId, seller: data.seller, nftContract: data.nftContract,
                tokenId: data.tokenId.toString(), quantity: data.quantity.toString(),
                pricePerUnit: data.pricePerUnit.toString(), paymentToken: data.paymentToken,
                isERC1155: data.isERC1155, active: data.active,
            };
        } catch (error) { lastError = error; }
    }
    throw new Error(`listing ${listingId} failed: ${lastError?.message || 'RPC unavailable'}`);
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
    } catch (err) {
        syncStatus.metadataFailures += 1;
        console.warn(`metadata ${nftContract}:${tokenId}:`, err.message);
        return {};
    }
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

async function persistRange(fromBlock, effectiveToBlock, liteSync = false) {
    const startTime = Date.now();
    const newIds = await discoverNewListingIds(fromBlock, effectiveToBlock);
    const canceled = await fetchCanceledListings(fromBlock, effectiveToBlock);

    const listingsMap = new Map();
    for (let i = 0; i < newIds.length; i += CONFIG.MAX_PARALLEL) {
        const chunk = newIds.slice(i, i + CONFIG.MAX_PARALLEL);
        await Promise.all(chunk.map(async (id) => {
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
    if (upsertRows.length !== newIds.length) throw new Error(`Persisted ${upsertRows.length} of ${newIds.length} discovered listings`);

    if (canceled.size > 0) {
        for (const cId of canceled) {
            await pool.query(`UPDATE marketplace_listings SET active = false, updated_at = NOW() WHERE listing_id = $1`, [cId]);
        }
    }

    return {
        newListingIds: newIds.length, processedListings: newIds.length,
        upserted: upsertRows.length, canceled: canceled.size,
        fromBlock, effectiveToBlock, executionTimeMs: Date.now() - startTime,
        liteMode: liteSync,
    };
}

async function commitCoveredRange(work, advance, endBlock) {
    const result = await work();
    await advance(endBlock);
    return result;
}

async function syncListings(fullRescan = false, liteSync = false) {
    const latest = await provider.getBlockNumber();
    const meta = await getLastSyncMeta();
    const fromBlock = fullRescan ? 0 : (meta ? Number(meta.last_block) + 1 : 0);
    const rangeLimit = liteSync ? Math.min(CONFIG.MAX_BLOCK_RANGE, 10000) : CONFIG.MAX_BLOCK_RANGE;
    const effectiveToBlock = Math.min(latest, fromBlock + rangeLimit - 1);
    if (fromBlock > latest) return { newListingIds: 0, processedListings: 0, upserted: 0, canceled: 0, latestBlock: latest, fromBlock, effectiveToBlock: latest, partialSync: false, liteMode: liteSync };
    let stats;
    try {
        stats = await commitCoveredRange(
            () => persistRange(fromBlock, effectiveToBlock, liteSync),
            setLastSyncMeta,
            effectiveToBlock,
        );
    } catch (error) {
        syncStatus.failedRange ||= { fromBlock, toBlock: effectiveToBlock };
        syncStatus.lastError = error.message;
        throw error;
    }
    syncStatus.lastSuccessfulRange = { fromBlock, toBlock: effectiveToBlock, completedAt: new Date().toISOString() };
    syncStatus.failedRange = null;
    syncStatus.retryCount = 0;
    syncStatus.lastError = null;
    syncStatus.discoveredListings = stats.newListingIds;
    syncStatus.persistedListings = stats.upserted;
    return { ...stats, latestBlock: latest, partialSync: effectiveToBlock < latest };
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const start = Date.now();
    try {
        init();
        const body = req.method === 'POST' ? req.body || {} : {};
        const repairFrom = Number(body.repairFromBlock);
        const repairTo = Number(body.repairToBlock);
        if (Number.isInteger(repairFrom) || Number.isInteger(repairTo)) {
            if (!Number.isInteger(repairFrom) || !Number.isInteger(repairTo) || repairFrom < 0 || repairTo < repairFrom || repairTo - repairFrom + 1 > CONFIG.MAX_BLOCK_RANGE) {
                return res.status(400).json({ error: `Repair range must be contiguous and at most ${CONFIG.MAX_BLOCK_RANGE} blocks` });
            }
            const stats = await persistRange(repairFrom, repairTo, body.liteSync === true);
            return res.status(200).json({ success: true, repair: true, stats, durationMs: Date.now() - start });
        }
        const fullRescan = body.fullRescan === true;
        const liteSync = body.liteSync === true;
        const stats = await syncListings(fullRescan, liteSync);
        return res.status(200).json({ success: true, stats, durationMs: Date.now() - start });
    } catch (e) {
        return res.status(500).json({ error: e.message, durationMs: Date.now() - start });
    }
};
module.exports.syncListings = async (opts = {}) => { init(); return syncListings(opts.fullRescan === true, opts.liteSync !== false); };
module.exports.commitCoveredRange = commitCoveredRange;
module.exports.getSyncStatus = () => ({ ...syncStatus });
