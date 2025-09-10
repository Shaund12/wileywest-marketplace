/**
 * Instant sync endpoint for immediate listing updates
 * This endpoint is optimized for real-time updates and should be called
 * whenever new listings are created or purchases are made
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
            { indexed: true, internalType: 'address', name: 'buyer', type: 'address' },
            { indexed: false, internalType: 'uint256', name: 'quantity', type: 'uint256' },
            { indexed: false, internalType: 'uint256', name: 'totalPrice', type: 'uint256' },
            { indexed: false, internalType: 'address', name: 'paymentToken', type: 'address' }
        ],
        name: 'NFTPurchased',
        type: 'event'
    }
];

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

async function instantSync(options = {}) {
    const { 
        listingId = null, 
        checkRecentBlocks = 100,
        broadcastUpdate = true 
    } = options;
    
    const latest = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - checkRecentBlocks);
    
    // If specific listing ID provided, update just that one
    if (listingId) {
        try {
            const onchainData = await marketplace.listings(listingId);
            if (onchainData.seller === ethers.ZeroAddress) {
                // Listing doesn't exist or was deleted, mark as inactive
                await supabase
                    .from('marketplace_listings')
                    .update({ 
                        active: false, 
                        sale_status: 'canceled',
                        updated_at: new Date().toISOString() 
                    })
                    .eq('listing_id', listingId);
                    
                if (broadcastUpdate) {
                    // Broadcast the update
                    supabase.channel('marketplace_listings')
                        .send({
                            type: 'broadcast',
                            event: 'listing_updated',
                            payload: {
                                listing_id: listingId,
                                active: false,
                                timestamp: new Date().toISOString()
                            }
                        });
                }
                
                return { listingId, status: 'deleted', updated: true };
            } else {
                // Update the listing with current blockchain state
                const updateData = {
                    seller: onchainData.seller.toLowerCase(),
                    nft_contract: onchainData.nftContract.toLowerCase(),
                    token_id: onchainData.tokenId.toString(),
                    quantity: onchainData.quantity.toString(),
                    price_per_unit: onchainData.pricePerUnit.toString(),
                    payment_token: onchainData.paymentToken.toLowerCase(),
                    is_erc1155: onchainData.isERC1155,
                    active: onchainData.active,
                    sale_status: onchainData.active ? 'active' : 'sold',
                    updated_at: new Date().toISOString()
                };
                
                await supabase
                    .from('marketplace_listings')
                    .upsert([{
                        listing_id: listingId,
                        ...updateData
                    }], { onConflict: 'listing_id' });
                
                if (broadcastUpdate) {
                    // Broadcast the update
                    supabase.channel('marketplace_listings')
                        .send({
                            type: 'broadcast',
                            event: 'listing_updated',
                            payload: {
                                listing_id: listingId,
                                ...updateData,
                                timestamp: new Date().toISOString()
                            }
                        });
                }
                
                return { listingId, status: 'updated', data: updateData };
            }
        } catch (error) {
            console.error(`Failed to sync listing ${listingId}:`, error);
            return { listingId, status: 'error', error: error.message };
        }
    }
    
    // Otherwise, scan recent blocks for any new events
    try {
        const [createdEvents, purchasedEvents] = await Promise.all([
            marketplace.queryFilter(marketplace.filters.ListingCreated(), fromBlock, latest),
            marketplace.queryFilter(marketplace.filters.NFTPurchased(), fromBlock, latest)
        ]);
        
        const updates = [];
        
        // Process new listings
        for (const event of createdEvents) {
            const listingId = event.args.listingId.toString();
            try {
                const onchainData = await marketplace.listings(listingId);
                const updateData = {
                    listing_id: listingId,
                    seller: onchainData.seller.toLowerCase(),
                    nft_contract: onchainData.nftContract.toLowerCase(),
                    token_id: onchainData.tokenId.toString(),
                    quantity: onchainData.quantity.toString(),
                    price_per_unit: onchainData.pricePerUnit.toString(),
                    payment_token: onchainData.paymentToken.toLowerCase(),
                    is_erc1155: onchainData.isERC1155,
                    active: onchainData.active,
                    sale_status: 'active',
                    updated_at: new Date().toISOString()
                };
                
                await supabase
                    .from('marketplace_listings')
                    .upsert([updateData], { onConflict: 'listing_id' });
                
                updates.push({ type: 'created', listingId });
                
                if (broadcastUpdate) {
                    supabase.channel('marketplace_listings')
                        .send({
                            type: 'broadcast',
                            event: 'listing_created',
                            payload: updateData
                        });
                }
            } catch (error) {
                console.error(`Failed to process created listing ${listingId}:`, error);
            }
        }
        
        // Process purchases (mark listings as sold)
        for (const event of purchasedEvents) {
            const listingId = event.args.listingId.toString();
            try {
                await supabase
                    .from('marketplace_listings')
                    .update({ 
                        active: false, 
                        sale_status: 'sold',
                        sale_transaction_hash: event.transactionHash,
                        updated_at: new Date().toISOString() 
                    })
                    .eq('listing_id', listingId);
                
                updates.push({ type: 'sold', listingId, txHash: event.transactionHash });
                
                if (broadcastUpdate) {
                    supabase.channel('marketplace_listings')
                        .send({
                            type: 'broadcast',
                            event: 'listing_sold',
                            payload: {
                                listing_id: listingId,
                                transaction_hash: event.transactionHash,
                                timestamp: new Date().toISOString()
                            }
                        });
                }
            } catch (error) {
                console.error(`Failed to process sold listing ${listingId}:`, error);
            }
        }
        
        return {
            scannedBlocks: { from: fromBlock, to: latest },
            updates,
            totalUpdates: updates.length
        };
        
    } catch (error) {
        console.error('Failed to scan recent blocks:', error);
        throw error;
    }
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
        
        const body = req.method === 'POST' ? req.body || {} : {};
        const query = req.query || {};
        
        const options = {
            listingId: body.listingId || query.listingId || null,
            checkRecentBlocks: parseInt(body.checkRecentBlocks || query.checkRecentBlocks || '100', 10),
            broadcastUpdate: body.broadcastUpdate !== false // Default to true
        };
        
        const result = await instantSync(options);
        
        return res.status(200).json({
            success: true,
            result,
            durationMs: Date.now() - start,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Instant sync error:', error);
        return res.status(500).json({ 
            success: false,
            error: error.message, 
            durationMs: Date.now() - start,
            timestamp: new Date().toISOString()
        });
    }
};