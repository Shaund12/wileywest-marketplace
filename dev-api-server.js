// Simple development API server for testing sync-user-collections endpoint
const express = require('express');
const cors = require('cors');
const app = express();
const port = 3001;

// Mock the sync-user-collections endpoint functionality
app.use(cors());
app.use(express.json());

// Mock sync endpoint
app.post('/api/sync-user-collections', async (req, res) => {
    const { walletAddress, immediate } = req.body;
    
    console.log(`[DEV API] Sync request for wallet: ${walletAddress}, immediate: ${immediate}`);
    
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Mock response with some test data
    const mockNFTs = [
        {
            contractAddress: '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906',
            tokenId: '1',
            type: 'ERC721',
            tokenURI: 'ipfs://QmTestHash1',
            balance: 1
        },
        {
            contractAddress: '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906',
            tokenId: '2',
            type: 'ERC721',
            tokenURI: 'ipfs://QmTestHash2',
            balance: 1
        }
    ];
    
    const response = {
        success: true,
        timestamp: new Date().toISOString(),
        duration: '1000ms',
        type: 'immediate',
        stats: {
            synced: 1,
            errors: 0,
            total: 1,
            nfts: mockNFTs.length,
            wallet: walletAddress,
            message: `Successfully scanned and cached ${mockNFTs.length} NFTs`
        }
    };
    
    console.log(`[DEV API] Returning response:`, response);
    res.json(response);
});

app.listen(port, () => {
    console.log(`[DEV API] Mock API server running on http://localhost:${port}`);
    console.log(`[DEV API] Available endpoints:`);
    console.log(`  POST /api/sync-user-collections`);
});