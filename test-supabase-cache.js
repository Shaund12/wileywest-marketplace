// Supabase Cache Test - Add this to your browser console to test caching functionality
// This script tests the caching operations without affecting the main application

async function testSupabaseCaching() {
    console.log('🧪 Starting Supabase Cache Test...');
    
    // Get the Supabase context from the app
    const supabaseContext = window.React?.createContext ? 
        'Please run this in the browser console while the app is loaded' : 
        'Testing...';
    
    // Test data
    const testListing = {
        id: 999999,
        seller: '0x1234567890123456789012345678901234567890',
        nftContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        tokenId: '999',
        quantity: '1',
        pricePerUnit: '1000000000000000000',
        paymentToken: '0x0000000000000000000000000000000000000000',
        isERC1155: false,
        active: true,
        image: 'https://via.placeholder.com/150',
        imageUrl: 'https://via.placeholder.com/150',
        name: 'Test NFT',
        title: 'Test NFT',
        description: 'Test listing for cache verification',
        metadata: {
            name: 'Test NFT',
            description: 'Test listing for cache verification',
            image: 'https://via.placeholder.com/150'
        }
    };
    
    const testSale = {
        listingId: '999999',
        buyer: '0x9876543210987654321098765432109876543210',
        seller: '0x1234567890123456789012345678901234567890',
        quantity: '1',
        totalPrice: '1000000000000000000',
        paymentToken: '0x0000000000000000000000000000000000000000',
        transactionHash: '0xtest123456789abcdef',
        blockNumber: 999999,
        timestamp: Date.now(),
        type: 'sale'
    };
    
    console.log('📊 Test listing:', testListing);
    console.log('📊 Test sale:', testSale);
    
    // Instructions for manual testing
    console.log(`
🔧 Manual Testing Instructions:

1. Open the WileyWest Marketplace app in your browser
2. Open the browser console (F12 -> Console tab)
3. Run the following commands one by one:

// Test Supabase connection
const { supabase, isConnected } = window.useSupabase ? window.useSupabase() : {};
console.log('Supabase connected:', isConnected);

// Test listing cache
const { cacheListings } = window.useSupabase ? window.useSupabase() : {};
if (cacheListings) {
    cacheListings([testListing]).then(() => {
        console.log('✅ Test listing cached successfully');
    }).catch(error => {
        console.error('❌ Test listing cache failed:', error);
    });
}

// Test sales history cache  
const { cacheSalesHistory } = window.useSupabase ? window.useSupabase() : {};
if (cacheSalesHistory) {
    cacheSalesHistory([testSale]).then(() => {
        console.log('✅ Test sale cached successfully');
    }).catch(error => {
        console.error('❌ Test sale cache failed:', error);
    });
}

4. Check your Supabase dashboard:
   - Go to Table Editor
   - Check 'marketplace_listings' table for the test listing (id: 999999)
   - Check 'sales_history' table for the test sale (transaction_hash: 0xtest123456789abcdef)

5. If the test data appears in Supabase, the caching is working correctly!
`);
    
    return {
        testListing,
        testSale,
        instructions: 'See console output above for testing instructions'
    };
}

// Auto-run if in browser
if (typeof window !== 'undefined') {
    testSupabaseCaching();
}

export default testSupabaseCaching;