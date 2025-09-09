/**
 * Sync VIBE fees from blockchain transactions
 * Tracks ERC20 transfers to the VIBE sink address and populates sale_breakdowns/auction_breakdowns
 */
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

// VIBE Sink address that receives fees (corrected to actual VIBE sink)
const VIBE_SINK_ADDRESS = '0x8e7C7f0DF435Be6773641f8cf62C590d7Dde5a8a';

// ERC20 Transfer event signature
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// WVTRU contract address  
const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9';

// Initialize provider
let provider = null;
function initProvider() {
    if (!provider) {
        const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
        provider = new ethers.JsonRpcProvider(rpcUrl);
    }
    return provider;
}

// Initialize Supabase client
let supabase = null;
function initSupabase() {
    if (!supabase) {
        const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
        
        if (supabaseUrl && supabaseKey && supabaseUrl !== 'https://dummy.supabase.co') {
            supabase = createClient(supabaseUrl, supabaseKey);
        }
    }
    return supabase;
}

/**
 * Main handler for vibe fee syncing
 */
module.exports = async (req, res) => {
    try {
        console.log('🚀 Starting VIBE fee sync...');
        
        const client = initSupabase();
        if (!client) {
            console.log('❌ Supabase not configured');
            return res.status(503).json({ error: 'Database not configured' });
        }
        
        const web3Provider = initProvider();
        
        // Get the last synced block
        const lastBlock = await getLastSyncedBlock(client);
        const currentBlock = await web3Provider.getBlockNumber();
        
        console.log(`📊 Syncing from block ${lastBlock + 1} to ${currentBlock}`);
        
        let totalFeesFound = 0;
        let totalAmountSynced = 0;
        
        // Sync in batches to avoid RPC limits
        const BATCH_SIZE = 2000;
        
        for (let fromBlock = lastBlock + 1; fromBlock <= currentBlock; fromBlock += BATCH_SIZE) {
            const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, currentBlock);
            
            console.log(`🔍 Scanning blocks ${fromBlock} to ${toBlock}...`);
            
            // Get transfer events to VIBE sink address (ERC20 transfers)
            const erc20Logs = await web3Provider.getLogs({
                fromBlock,
                toBlock,
                topics: [
                    ERC20_TRANSFER_TOPIC,
                    null, // from address (any)
                    ethers.zeroPadValue(VIBE_SINK_ADDRESS.toLowerCase(), 32) // to VIBE sink
                ]
            });
            
            console.log(`📋 Found ${erc20Logs.length} ERC20 transfers to VIBE sink in blocks ${fromBlock}-${toBlock}`);
            
            // Process ERC20 transfers
            for (const log of erc20Logs) {
                try {
                    const amount = ethers.formatEther(log.data);
                    const amountNum = parseFloat(amount);
                    
                    if (amountNum > 0) {
                        await processVibeTransfer(client, log, amount, amountNum, 'erc20', web3Provider);
                        totalFeesFound++;
                        totalAmountSynced += amountNum;
                    }
                } catch (error) {
                    console.warn(`⚠️ Error processing ERC20 log ${log.transactionHash}:`, error);
                }
            }
            
            // Also scan for native VTRU transfers to VIBE sink
            for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
                try {
                    const block = await web3Provider.getBlock(blockNum, true);
                    if (block && block.transactions) {
                        for (const tx of block.transactions) {
                            // Check if transaction is to VIBE sink address with value
                            if (tx.to && tx.to.toLowerCase() === VIBE_SINK_ADDRESS.toLowerCase() && tx.value && tx.value !== '0') {
                                const amount = ethers.formatEther(tx.value);
                                const amountNum = parseFloat(amount);
                                
                                if (amountNum > 0) {
                                    await processVibeTransfer(client, {
                                        transactionHash: tx.hash,
                                        blockNumber: tx.blockNumber,
                                        logIndex: 0, // Native transfers don't have log index
                                        address: 'native', // Indicate this is native VTRU
                                        topics: [null, ethers.zeroPadValue(tx.from, 32)] // from address
                                    }, amount, amountNum, 'native', web3Provider);
                                    totalFeesFound++;
                                    totalAmountSynced += amountNum;
                                    console.log(`💰 Recorded ${amount} native VTRU fee from tx ${tx.hash.slice(0, 10)}...`);
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.warn(`⚠️ Error scanning block ${blockNum} for native transfers:`, error);
                }
            }
        }
        
        // Update last synced block
        await updateLastSyncedBlock(client, currentBlock);
        
        console.log(`✅ VIBE fee sync complete:`);
        console.log(`📊 Blocks synced: ${lastBlock + 1} to ${currentBlock}`);
        console.log(`💰 Total fees found: ${totalFeesFound}`);
        console.log(`💎 Total amount synced: ${totalAmountSynced.toFixed(4)} VTRU`);
        
        return res.json({
            success: true,
            summary: {
                blocksScanned: currentBlock - lastBlock,
                feesFound: totalFeesFound,
                totalAmount: totalAmountSynced.toFixed(4),
                lastBlock: currentBlock
            }
        });
        
    } catch (error) {
        console.error('❌ VIBE fee sync error:', error);
        return res.status(500).json({
            error: 'Failed to sync VIBE fees',
            message: error.message
        });
    }
};

/**
 * Process a VIBE transfer (ERC20 or native) and store it in the database
 */
async function processVibeTransfer(client, log, amount, amountNum, transferType, web3Provider) {
    try {
        // Get transaction details if we don't have them
        const block = await web3Provider.getBlock(log.blockNumber);
        
        // Decode from address
        const fromAddress = log.topics && log.topics[1] ? 
            ethers.getAddress('0x' + log.topics[1].slice(26)) : 
            'unknown';
        
        // Store as a sale breakdown (we can't easily distinguish sale vs auction from just transfer logs)
        const breakdown = {
            listing_id: `vibe_${transferType}_${log.transactionHash}_${log.logIndex}`,
            platform_fee: '0', // We don't know the breakdown from just transfers
            royalty: '0',
            proceeds: '0', 
            vibe_amount: amount,
            vibe_portion_in_payment: amount, // This is the actual VIBE fee
            transaction_hash: log.transactionHash,
            block_number: log.blockNumber,
            log_index: log.logIndex,
            timestamp: block.timestamp,
            token_address: log.address === 'native' ? 'VTRU' : log.address,
            from_address: fromAddress,
            to_address: VIBE_SINK_ADDRESS,
            transfer_type: transferType // Track whether this was ERC20 or native
        };
        
        // Insert into sale_breakdowns table
        const { error } = await client
            .from('sale_breakdowns')
            .upsert(breakdown, {
                onConflict: 'transaction_hash,log_index'
            });
        
        if (error) {
            console.warn(`⚠️ Failed to insert ${transferType} breakdown for ${log.transactionHash}:`, error);
        } else {
            console.log(`💰 Recorded ${amount} ${transferType} VTRU fee from tx ${log.transactionHash.slice(0, 10)}...`);
        }
    } catch (error) {
        console.warn(`⚠️ Error processing ${transferType} transfer ${log.transactionHash}:`, error);
    }
}

/**
 * Get the last synced block number for VIBE fees
 */
async function getLastSyncedBlock(client) {
    try {
        const { data, error } = await client
            .from('marketplace_sync_meta')
            .select('last_vibe_fee_block')
            .eq('id', 1)
            .single();
            
        if (error || !data) {
            console.log('📍 No previous VIBE fee sync found, starting from recent blocks');
            // Start from 7 days ago to avoid scanning entire history
            const provider = initProvider();
            const currentBlock = await provider.getBlockNumber();
            return Math.max(0, currentBlock - 100000); // ~7 days of blocks
        }
        
        return data.last_vibe_fee_block || 0;
    } catch (error) {
        console.warn('⚠️ Error getting last synced block:', error);
        return 0;
    }
}

/**
 * Update the last synced block number for VIBE fees
 */
async function updateLastSyncedBlock(client, blockNumber) {
    try {
        const { error } = await client
            .from('marketplace_sync_meta')
            .upsert({
                id: 1,
                last_vibe_fee_block: blockNumber,
                last_vibe_fee_sync: new Date().toISOString()
            }, {
                onConflict: 'id'
            });
            
        if (error) {
            console.warn('⚠️ Failed to update last synced block:', error);
        }
    } catch (error) {
        console.warn('⚠️ Error updating last synced block:', error);
    }
}