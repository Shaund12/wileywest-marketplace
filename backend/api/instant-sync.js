/**
 * Instant sync (ported from api/instant-sync.js → pg). Updates a single
 * listing or scans recent blocks for ListingCreated / NFTPurchased events and
 * reconciles marketplace_listings. Supabase realtime broadcasts are dropped
 * (no-op) since the self-hosted client does not use realtime channels.
 */
const { ethers } = require('ethers');
const { pool } = require('../db/pgClient');

const MARKETPLACE_ABI = [
    { inputs: [{ name: 'listingId', type: 'uint256' }], name: 'listings', outputs: [
        { name: 'seller', type: 'address' }, { name: 'nftContract', type: 'address' },
        { name: 'tokenId', type: 'uint256' }, { name: 'quantity', type: 'uint256' },
        { name: 'pricePerUnit', type: 'uint256' }, { name: 'paymentToken', type: 'address' },
        { name: 'isERC1155', type: 'bool' }, { name: 'active', type: 'bool' },
    ], stateMutability: 'view', type: 'function' },
    { anonymous: false, inputs: [
        { indexed: true, name: 'listingId', type: 'uint256' }, { indexed: true, name: 'seller', type: 'address' },
        { indexed: true, name: 'nftContract', type: 'address' }, { indexed: false, name: 'tokenId', type: 'uint256' },
        { indexed: false, name: 'quantity', type: 'uint256' }, { indexed: false, name: 'pricePerUnit', type: 'uint256' },
        { indexed: false, name: 'paymentToken', type: 'address' }, { indexed: false, name: 'isERC1155', type: 'bool' },
    ], name: 'ListingCreated', type: 'event' },
    { anonymous: false, inputs: [
        { indexed: true, name: 'listingId', type: 'uint256' }, { indexed: true, name: 'buyer', type: 'address' },
        { indexed: false, name: 'quantity', type: 'uint256' }, { indexed: false, name: 'totalPrice', type: 'uint256' },
        { indexed: false, name: 'paymentToken', type: 'address' },
    ], name: 'NFTPurchased', type: 'event' },
];

let provider, marketplace;

function init() {
    const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
    provider = new ethers.JsonRpcProvider(rpcUrl);
    const marketplaceAddress = process.env.VITE_MARKETPLACE_ADDRESS;
    if (!marketplaceAddress || marketplaceAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error('Marketplace address not configured');
    }
    marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);
}

async function upsertListing(row) {
    await pool.query(
        `INSERT INTO marketplace_listings
           (listing_id, seller, nft_contract, token_id, quantity, price_per_unit,
            payment_token, is_erc1155, active, sale_status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (listing_id) DO UPDATE SET
           seller = EXCLUDED.seller, nft_contract = EXCLUDED.nft_contract, token_id = EXCLUDED.token_id,
           quantity = EXCLUDED.quantity, price_per_unit = EXCLUDED.price_per_unit,
           payment_token = EXCLUDED.payment_token, is_erc1155 = EXCLUDED.is_erc1155,
           active = EXCLUDED.active, sale_status = EXCLUDED.sale_status, updated_at = NOW()`,
        [row.listing_id, row.seller, row.nft_contract, row.token_id, row.quantity, row.price_per_unit,
            row.payment_token, row.is_erc1155, row.active, row.sale_status],
    );
}

async function instantSync(options = {}) {
    const { listingId = null, checkRecentBlocks = 100 } = options;
    const latest = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - checkRecentBlocks);

    if (listingId) {
        const onchainData = await marketplace.listings(listingId);
        if (onchainData.seller === ethers.ZeroAddress) {
            await pool.query(`UPDATE marketplace_listings SET active = false, sale_status = 'canceled', updated_at = NOW() WHERE listing_id = $1`, [String(listingId)]);
            return { listingId, status: 'deleted', updated: true };
        }
        const row = {
            listing_id: String(listingId), seller: onchainData.seller.toLowerCase(), nft_contract: onchainData.nftContract.toLowerCase(),
            token_id: onchainData.tokenId.toString(), quantity: onchainData.quantity.toString(), price_per_unit: onchainData.pricePerUnit.toString(),
            payment_token: onchainData.paymentToken.toLowerCase(), is_erc1155: onchainData.isERC1155, active: onchainData.active,
            sale_status: onchainData.active ? 'active' : 'sold',
        };
        await upsertListing(row);
        return { listingId, status: 'updated', data: row };
    }

    const [createdEvents, purchasedEvents] = await Promise.all([
        marketplace.queryFilter(marketplace.filters.ListingCreated(), fromBlock, latest),
        marketplace.queryFilter(marketplace.filters.NFTPurchased(), fromBlock, latest),
    ]);
    const updates = [];
    for (const event of createdEvents) {
        const lid = event.args.listingId.toString();
        try {
            const d = await marketplace.listings(lid);
            await upsertListing({
                listing_id: lid, seller: d.seller.toLowerCase(), nft_contract: d.nftContract.toLowerCase(),
                token_id: d.tokenId.toString(), quantity: d.quantity.toString(), price_per_unit: d.pricePerUnit.toString(),
                payment_token: d.paymentToken.toLowerCase(), is_erc1155: d.isERC1155, active: d.active, sale_status: 'active',
            });
            updates.push({ type: 'created', listingId: lid });
        } catch (e) { console.error(`created ${lid}:`, e.message); }
    }
    for (const event of purchasedEvents) {
        const lid = event.args.listingId.toString();
        try {
            await pool.query(`UPDATE marketplace_listings SET active = false, sale_status = 'sold', sale_transaction_hash = $2, updated_at = NOW() WHERE listing_id = $1`, [lid, event.transactionHash]);
            updates.push({ type: 'sold', listingId: lid, txHash: event.transactionHash });
        } catch (e) { console.error(`sold ${lid}:`, e.message); }
    }
    return { scannedBlocks: { from: fromBlock, to: latest }, updates, totalUpdates: updates.length };
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const start = Date.now();
    try {
        init();
        const body = req.method === 'POST' ? req.body || {} : {};
        const q = req.query || {};
        const requestedListingId = body.listingId || q.listingId || null;
        if (requestedListingId !== null && !/^\d+$/.test(String(requestedListingId))) {
            return res.status(400).json({ success: false, error: 'Invalid listing ID' });
        }
        const requestedBlocks = parseInt(body.checkRecentBlocks || q.checkRecentBlocks || '100', 10);
        const result = await instantSync({
            listingId: requestedListingId,
            checkRecentBlocks: Math.max(1, Math.min(200, Number.isFinite(requestedBlocks) ? requestedBlocks : 100)),
        });
        return res.status(200).json({ success: true, result, durationMs: Date.now() - start, timestamp: new Date().toISOString() });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message, durationMs: Date.now() - start, timestamp: new Date().toISOString() });
    }
};
