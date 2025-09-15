// Debug script to test ERC-404 detection and scanning
import { ethers } from 'ethers';

const ERC404_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function erc721BalanceOf(address owner) view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function getOwnedTokens(address owner) view returns (uint256[])',
    'function getERC721QueueLength() view returns (uint256)',
    'function getERC721TokensInQueue(uint256 start, uint256 count) view returns (uint256[])',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

async function debugERC404Contract() {
    try {
        // Connect to Vitruveo RPC
        const provider = new ethers.JsonRpcProvider('https://rpc.vitruveo.xyz');
        
        // Crocodeal-404 contract address
        const contractAddress = '0x30dA83269Da1Dfe17253Bf07F92056c2adCcA453';
        
        // Test wallet address (using a real address for testing)
        const testWallet = '0x0000000000000000000000000000000000000000'; // Using zero address for initial test
        
        console.log('=== ERC-404 Debug Test ===');
        console.log(`Contract: ${contractAddress}`);
        console.log(`Wallet: ${testWallet}`);
        console.log('');
        
        const contract = new ethers.Contract(contractAddress, ERC404_ABI, provider);
        
        // Test basic contract info
        console.log('1. Testing basic contract info...');
        try {
            const name = await contract.name();
            const symbol = await contract.symbol();
            console.log(`✅ Name: ${name}`);
            console.log(`✅ Symbol: ${symbol}`);
        } catch (e) {
            console.log(`❌ Basic info error: ${e.message}`);
        }
        
        // Test ERC-20 balance
        console.log('\n2. Testing ERC-20 balance...');
        try {
            const balance = await contract.balanceOf(testWallet);
            console.log(`✅ ERC-20 Balance: ${balance.toString()}`);
        } catch (e) {
            console.log(`❌ ERC-20 balance error: ${e.message}`);
        }
        
        // Test ERC-721 balance
        console.log('\n3. Testing ERC-721 balance...');
        try {
            const erc721Balance = await contract.erc721BalanceOf(testWallet);
            console.log(`✅ ERC-721 Balance: ${erc721Balance.toString()}`);
        } catch (e) {
            console.log(`❌ ERC-721 balance error: ${e.message}`);
        }
        
        // Test getOwnedTokens
        console.log('\n4. Testing getOwnedTokens...');
        try {
            const ownedTokens = await contract.getOwnedTokens(testWallet);
            console.log(`✅ Owned tokens: ${ownedTokens.map(t => t.toString()).join(', ')}`);
        } catch (e) {
            console.log(`❌ getOwnedTokens error: ${e.message}`);
        }
        
        // Test queue methods
        console.log('\n5. Testing queue methods...');
        try {
            const queueLength = await contract.getERC721QueueLength();
            console.log(`✅ Queue length: ${queueLength.toString()}`);
            
            if (queueLength > 0) {
                const queueTokens = await contract.getERC721TokensInQueue(0, Math.min(Number(queueLength), 10));
                console.log(`✅ Queue tokens (first 10): ${queueTokens.map(t => t.toString()).join(', ')}`);
            }
        } catch (e) {
            console.log(`❌ Queue methods error: ${e.message}`);
        }
        
        // Test Transfer events
        console.log('\n6. Testing Transfer events...');
        try {
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - 10000); // Last 10k blocks
            
            const transferTopic = ethers.id('Transfer(address,address,uint256)');
            const toWalletTopic = ethers.zeroPadValue(testWallet.toLowerCase(), 32);
            
            const filter = {
                address: contractAddress,
                topics: [transferTopic, null, toWalletTopic],
                fromBlock: fromBlock,
                toBlock: currentBlock
            };
            
            const logs = await provider.getLogs(filter);
            console.log(`✅ Found ${logs.length} Transfer events to wallet in last 10k blocks`);
            
            // Check the format of transfer events
            if (logs.length > 0) {
                const firstLog = logs[0];
                console.log(`   First log topics count: ${firstLog.topics.length}`);
                if (firstLog.topics.length === 4) {
                    console.log(`   Token ID from first log: ${ethers.toBigInt(firstLog.topics[3]).toString()}`);
                }
            }
        } catch (e) {
            console.log(`❌ Transfer events error: ${e.message}`);
        }
        
        // Test ownership of token ID 1
        console.log('\n7. Testing ownership of token ID 1...');
        try {
            const owner = await contract.ownerOf(1);
            console.log(`✅ Owner of token 1: ${owner}`);
        } catch (e) {
            console.log(`❌ ownerOf(1) error: ${e.message}`);
        }
        
        // Test tokenURI of token ID 1
        console.log('\n8. Testing tokenURI of token ID 1...');
        try {
            const tokenURI = await contract.tokenURI(1);
            console.log(`✅ Token URI of token 1: ${tokenURI}`);
        } catch (e) {
            console.log(`❌ tokenURI(1) error: ${e.message}`);
        }
        
        console.log('\n=== Debug Complete ===');
        
    } catch (error) {
        console.error('Fatal error:', error);
    }
}

debugERC404Contract().catch(console.error);