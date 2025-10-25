# Environment Variables for Testing

Create a `.env` file in the root directory with the following variables for local testing:

```env
VITE_SUPABASE_URL=https://your-supabase-url.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_RPC_URL=https://rpc.vitruveo.xyz
VITE_MARKETPLACE_ADDRESS=your-marketplace-contract-address
```

For testing purposes without a Supabase setup, you can use placeholder values:

```env
VITE_SUPABASE_URL=https://dummy.supabase.co
VITE_SUPABASE_ANON_KEY=dummy-key-for-testing
VITE_RPC_URL=https://rpc.vitruveo.xyz
VITE_MARKETPLACE_ADDRESS=0x0000000000000000000000000000000000000000
```

## Price Fetching Testing

The token price fetching functionality has been improved with:

- Proper initialization sequencing
- Robust error handling for network issues
- Fallback mechanisms for missing liquidity pools
- Retry logic with exponential backoff
- Enhanced logging for debugging

The system will gracefully handle network restrictions and still display available price information.