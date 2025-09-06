import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

// ERC721 and ERC1155 ABIs for NFT scanning
const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

const ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
    'function uri(uint256 id) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
];

// Known NFT contracts to scan
const KNOWN_NFT_CONTRACTS = [
    '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906', // Pixel Ninja Cats
];

// IPFS gateways for metadata resolution
const IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
];

// Configuration
const COLLECTION_CONFIG = {
    MAX_BLOCKS_BACK: 500000, // ~6 months of blocks
    BATCH_SIZE: 50,
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000,
    MAX_CONCURRENT_USERS: 5, // Process max 5 users per cron run
    METADATA_TIMEOUT: 10000
};

// Initialize providers
let provider;
let supabase;

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
    
    console.log('✅ Initialized clients for user collection sync');
}

// Fetch NFT metadata from tokenURI
async function fetchNFTMetadata(nftContract, tokenId) {
    try {
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
            try {
                tokenURI = await nft.uri(tokenId);
            } catch {
                return null;
            }
        }
        
        if (!tokenURI) return null;
        
        // Resolve IPFS URLs with multiple gateway attempts
        if (tokenURI.startsWith('ipfs://')) {
            const cid = tokenURI.slice(7);
            
            for (const gateway of IPFS_GATEWAYS) {
                try {
                    const response = await fetch(`${gateway}${cid}`, { 
                        timeout: COLLECTION_CONFIG.METADATA_TIMEOUT,
                        headers: { 'Accept': 'application/json' }
                    });
                    
                    if (response.ok) {
                        const metadata = await response.json();
                        
                        // Resolve image URLs
                        if (metadata.image?.startsWith('ipfs://')) {
                            metadata.image = `${gateway}${metadata.image.slice(7)}`;
                        }
                        
                        return metadata;
                    }
                } catch (e) {
                    // Try next gateway
                    continue;
                }
            }
        } else {
            // Direct HTTP URL
            try {
                const response = await fetch(tokenURI, { 
                    timeout: COLLECTION_CONFIG.METADATA_TIMEOUT,
                    headers: { 'Accept': 'application/json' }
                });
                
                if (response.ok) {
                    const metadata = await response.json();
                    return metadata;
                }
            } catch (e) {
                // Ignore and return null
            }
        }
        
        return null;
    } catch (error) {
        console.warn(`Failed to fetch metadata for ${nftContract}:${tokenId}:`, error.message);
        return null;
    }
}

// Detect if contract is ERC721 or ERC1155
async function detectNftStandard(contractAddress) {
    try {
        // Try ERC721 first
        const erc721Contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
        await erc721Contract.supportsInterface('0x80ac58cd'); // ERC721 interface ID
        return 'ERC721';
    } catch (e) {
        try {
            // Try ERC1155
            const erc1155Contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider);
            await erc1155Contract.supportsInterface('0xd9b67a26'); // ERC1155 interface ID
            return 'ERC1155';
        } catch (e) {
            return null; // Not a standard NFT contract
        }
    }
}

// Get contract info (name/symbol)
async function getContractInfo(contractAddress, contractType) {
    try {
        const abi = contractType === 'ERC721' ? ERC721_ABI : ERC1155_ABI;
        const contract = new ethers.Contract(contractAddress, abi, provider);
        
        let name = '';
        let symbol = '';
        
        try {
            name = await contract.name();
        } catch { /* optional */ }
        
        try {
            symbol = await contract.symbol();
        } catch { /* optional */ }
        
        if (!name) {
            name = `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;
        }
        
        return { name, symbol };
    } catch (e) {
        return {
            name: `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`,
            symbol: ''
        };
    }
}

// Scan for ERC721 NFTs owned by user
async function scanERC721(contractAddress, walletAddress) {
    try {
        const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
        const balance = await contract.balanceOf(walletAddress);
        
        if (balance.toString() === '0') return [];
        
        const nfts = [];
        const balanceNum = Number(balance.toString());
        
        // Fetch contract info
        const contractInfo = await getContractInfo(contractAddress, 'ERC721');
        
        for (let i = 0; i < Math.min(balanceNum, 100); i++) { // Limit to 100 NFTs per contract
            try {
                const tokenId = await contract.tokenOfOwnerByIndex(walletAddress, i);
                
                let tokenURI = null;
                try {
                    tokenURI = await contract.tokenURI(tokenId);
                } catch { /* optional */ }
                
                // Fetch metadata in background
                const metadata = await fetchNFTMetadata(contractAddress, tokenId.toString());
                
                nfts.push({
                    contractAddress: contractAddress.toLowerCase(),
                    tokenId: tokenId.toString(),
                    type: 'ERC721',
                    tokenURI,
                    balance: '1',
                    metadata: metadata || {},
                    name: metadata?.name || `Token #${tokenId}`,
                    image: metadata?.image || null,
                    collection: contractInfo
                });
            } catch (e) {
                console.warn(`Failed to fetch ERC721 token ${i} from ${contractAddress}:`, e.message);
            }
        }
        
        return nfts;
    } catch (e) {
        console.warn(`Failed to scan ERC721 contract ${contractAddress}:`, e.message);
        return [];
    }
}

// Scan for ERC1155 NFTs owned by user
async function scanERC1155(contractAddress, walletAddress) {
    try {
        const contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider);
        
        // Fetch contract info
        const contractInfo = await getContractInfo(contractAddress, 'ERC1155');
        
        // Get transfer events to find token IDs
        const transferSingleFilter = contract.filters.TransferSingle(null, null, walletAddress);
        const transferBatchFilter = contract.filters.TransferBatch(null, null, walletAddress);
        
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - COLLECTION_CONFIG.MAX_BLOCKS_BACK);
        
        const singleEvents = await contract.queryFilter(transferSingleFilter, fromBlock);
        const batchEvents = await contract.queryFilter(transferBatchFilter, fromBlock);
        
        const tokenIds = new Set();
        
        singleEvents.forEach(event => {
            tokenIds.add(event.args.id.toString());
        });
        
        batchEvents.forEach(event => {
            event.args.ids.forEach(id => tokenIds.add(id.toString()));
        });
        
        // Also try common token IDs 1-20
        for (let i = 1; i <= 20; i++) {
            tokenIds.add(i.toString());
        }
        
        const nfts = [];
        const tokenIdArray = [...tokenIds].slice(0, 100); // Limit to 100 tokens
        
        for (const tokenId of tokenIdArray) {
            try {
                const balance = await contract.balanceOf(walletAddress, tokenId);
                
                if (balance.toString() !== '0') {
                    let tokenURI = null;
                    try {
                        tokenURI = await contract.uri(tokenId);
                    } catch { /* optional */ }
                    
                    // Fetch metadata
                    const metadata = await fetchNFTMetadata(contractAddress, tokenId);
                    
                    nfts.push({
                        contractAddress: contractAddress.toLowerCase(),
                        tokenId,
                        type: 'ERC1155',
                        tokenURI,
                        balance: balance.toString(),
                        metadata: metadata || {},
                        name: metadata?.name || `Token #${tokenId}`,
                        image: metadata?.image || null,
                        collection: contractInfo
                    });
                }
            } catch (e) {
                console.warn(`Failed to check ERC1155 balance for ${contractAddress}:${tokenId}:`, e.message);
            }
        }
        
        return nfts;
    } catch (e) {
        console.warn(`Failed to scan ERC1155 contract ${contractAddress}:`, e.message);
        return [];
    }
}

// Find NFT contracts from Transfer events
async function findNFTContracts(walletAddress) {
    try {
        console.log(`🔍 Finding NFT contracts for ${walletAddress}...`);
        
        // ERC721 Transfer events
        const erc721TransferTopic = ethers.id('Transfer(address,address,uint256)');
        const toUserTopic = ethers.zeroPadValue(walletAddress.toLowerCase(), 32);
        
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - COLLECTION_CONFIG.MAX_BLOCKS_BACK);
        
        const filter = {
            topics: [erc721TransferTopic, null, toUserTopic],
            fromBlock,
            toBlock: 'latest'
        };
        
        const logs = await provider.getLogs(filter);
        const contracts = new Set([...KNOWN_NFT_CONTRACTS.map(addr => addr.toLowerCase())]);
        
        logs.forEach(log => {
            contracts.add(log.address.toLowerCase());
        });
        
        console.log(`📋 Found ${contracts.size} potential NFT contracts`);
        return [...contracts];
    } catch (e) {
        console.warn('Failed to find NFT contracts:', e.message);
        return [...KNOWN_NFT_CONTRACTS.map(addr => addr.toLowerCase())];
    }
}

// Scan all NFTs for a specific user
async function scanUserNFTs(walletAddress) {
    try {
        console.log(`🔍 Scanning NFTs for ${walletAddress}...`);
        
        const nftContracts = await findNFTContracts(walletAddress);
        const allNfts = [];
        
        for (const contractAddress of nftContracts) {
            try {
                // Detect contract type
                const contractType = await detectNftStandard(contractAddress);
                
                if (contractType === 'ERC721') {
                    const nfts = await scanERC721(contractAddress, walletAddress);
                    allNfts.push(...nfts);
                } else if (contractType === 'ERC1155') {
                    const nfts = await scanERC1155(contractAddress, walletAddress);
                    allNfts.push(...nfts);
                }
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (e) {
                console.warn(`Failed to scan contract ${contractAddress}:`, e.message);
            }
        }
        
        console.log(`✅ Found ${allNfts.length} NFTs for ${walletAddress}`);
        return allNfts;
    } catch (error) {
        console.error(`❌ Failed to scan NFTs for ${walletAddress}:`, error.message);
        return [];
    }
}

// Get users to sync (from recent activity or all users)
async function getUsersToSync() {
    try {
        // Get users with recent activity (marketplace listings, sales, etc.)
        const { data: recentUsers, error } = await supabase
            .from('marketplace_listings')
            .select('seller')
            .gte('updated_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) // Last 24 hours
            .limit(COLLECTION_CONFIG.MAX_CONCURRENT_USERS);
        
        if (error) {
            console.warn('Failed to fetch recent users, using fallback:', error.message);
            
            // Fallback: get any users from user_profiles table
            const { data: allUsers, error: profileError } = await supabase
                .from('user_profiles')
                .select('wallet_address')
                .limit(COLLECTION_CONFIG.MAX_CONCURRENT_USERS);
            
            if (profileError) {
                console.warn('Failed to fetch any users:', profileError.message);
                return [];
            }
            
            return (allUsers || []).map(u => u.wallet_address);
        }
        
        // Extract unique wallet addresses
        const wallets = [...new Set((recentUsers || []).map(u => u.seller))];
        console.log(`📋 Found ${wallets.length} users to sync collections for`);
        
        return wallets.slice(0, COLLECTION_CONFIG.MAX_CONCURRENT_USERS);
    } catch (error) {
        console.error('Failed to get users to sync:', error.message);
        return [];
    }
}

// Cache user NFTs to Supabase
async function cacheUserNFTs(walletAddress, nfts) {
    try {
        console.log(`💾 Caching ${nfts.length} NFTs for ${walletAddress}...`);
        
        // Use upsert to update or insert user profile
        const { error } = await supabase
            .from('user_profiles')
            .upsert({
                wallet_address: walletAddress.toLowerCase(),
                nfts: nfts,
                updated_at: new Date().toISOString()
            });
        
        if (error) {
            console.error(`❌ Failed to cache NFTs for ${walletAddress}:`, error.message);
            return false;
        }
        
        console.log(`✅ Cached ${nfts.length} NFTs for ${walletAddress}`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to cache NFTs for ${walletAddress}:`, error.message);
        return false;
    }
}

// Main sync function
async function syncUserCollections() {
    console.log('🚀 Starting user collections sync...');
    
    const users = await getUsersToSync();
    if (users.length === 0) {
        console.log('📋 No users found to sync');
        return { synced: 0, errors: 0 };
    }
    
    let synced = 0;
    let errors = 0;
    
    for (const walletAddress of users) {
        try {
            console.log(`🔄 Syncing collections for ${walletAddress}...`);
            
            const nfts = await scanUserNFTs(walletAddress);
            const cached = await cacheUserNFTs(walletAddress, nfts);
            
            if (cached) {
                synced++;
            } else {
                errors++;
            }
            
            // Small delay between users
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error(`❌ Failed to sync collections for ${walletAddress}:`, error.message);
            errors++;
        }
    }
    
    console.log(`✅ Collections sync complete: ${synced} users synced, ${errors} errors`);
    return { synced, errors, total: users.length };
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
        // Verify authorization for cron jobs (but allow manual syncs without auth)
        const authHeader = req.headers.authorization;
        const cronSecret = process.env.CRON_SECRET;
        const isCronJob = authHeader === `Bearer ${cronSecret}`;
        
        // For manual sync requests, check if specific wallet is provided
        const requestBody = req.method === 'POST' ? req.body : {};
        const targetWallet = requestBody?.walletAddress;
        const isImmediateSync = requestBody?.immediate === true;
        
        console.log(`🚀 Starting ${isCronJob ? 'scheduled' : 'manual'} collections sync...`);
        
        // Initialize clients
        initializeClients();
        
        let result;
        
        if (targetWallet && isImmediateSync) {
            // Immediate sync for specific wallet
            console.log(`🔄 Immediate sync for wallet: ${targetWallet}`);
            
            const nfts = await scanUserNFTs(targetWallet);
            const cached = await cacheUserNFTs(targetWallet, nfts);
            
            result = {
                synced: cached ? 1 : 0,
                errors: cached ? 0 : 1,
                total: 1,
                nfts: nfts.length,
                wallet: targetWallet
            };
        } else {
            // Batch sync for multiple users (cron job or general sync)
            result = await syncUserCollections();
        }
        
        const duration = Date.now() - startTime;
        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            duration: `${duration}ms`,
            type: isCronJob ? 'cron' : (targetWallet ? 'immediate' : 'batch'),
            stats: result
        };
        
        console.log('✅ User collections sync completed:', response);
        
        return res.status(200).json(response);
        
    } catch (error) {
        console.error('❌ User collections sync failed:', error.message);
        
        const duration = Date.now() - startTime;
        return res.status(500).json({
            error: error.message,
            timestamp: new Date().toISOString(),
            duration: `${duration}ms`
        });
    }
}