# Cron-Based Marketplace Architecture

This document describes the new architecture that replaces frontend blockchain scanning with a Vercel cron job approach.

## Overview

The marketplace now uses a **serverless backend approach** where:
- Frontend only loads from cached Supabase data (instant loading)
- Vercel cron job syncs blockchain data every 5 minutes 
- Manual sync available via API endpoint for immediate updates

## Architecture Components

### 1. Vercel Serverless Function (`/api/sync-listings.js`)
- Scans blockchain for active marketplace listings (1-2000 range)
- Fetches NFT metadata from contract tokenURI/uri methods
- Caches results to Supabase `marketplace_listings` table
- Handles IPFS resolution with reliable gateways

### 2. Vercel Cron Job (`vercel.json`)
- Runs every 5 minutes: `"schedule": "*/5 * * * *"`
- Calls `/api/sync-listings` endpoint automatically
- Keeps listings fresh without frontend performance impact

### 3. Frontend Changes (`MarketplaceContext.jsx`)
- `fetchListings()` now only reads from Supabase cache
- `triggerManualSync()` calls API for immediate updates
- Removed heavy blockchain scanning from user browsers

## Benefits

✅ **Instant Loading**: Cache displays in 1-2 seconds instead of 30+ seconds
✅ **Reduced RPC Load**: Single backend sync vs hundreds of user browser requests  
✅ **Better UX**: No more waiting for blockchain scans on page load
✅ **Scalable**: Works for any number of concurrent users
✅ **Fresh Data**: 5-minute intervals ensure reasonably current listings

## Configuration

### Environment Variables
```env
# Supabase (for cached data)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# Blockchain (for cron job scanning)
VITE_RPC_URL=https://rpc.vitruveo.xyz
VITE_MARKETPLACE_ADDRESS=0xD3A29b4955531be1bf9a1F62c5dA278421c5CFc6
VITE_MAX_LISTING_SCAN=2000

# Security (optional)
CRON_SECRET=your-secure-random-secret
```

### Vercel Project Settings
1. Add all environment variables to Vercel dashboard
2. Deploy - cron job will start automatically
3. Monitor function logs for sync status

## Manual Testing

### Test Cron Function Locally
```bash
# Install Vercel CLI
npm i -g vercel

# Test function
vercel dev
curl http://localhost:3000/api/sync-listings
```

### Test Frontend
```bash
npm run dev
# Visit http://localhost:5173
# Should show cached listings immediately
# "Sync Data" button triggers manual refresh
```

## Monitoring

### Function Logs
Check Vercel dashboard → Functions → `/api/sync-listings` for:
- Sync duration (should be < 30 seconds)
- Listings found/cached counts
- Error logs if blockchain/Supabase issues

### Database
Check Supabase → `marketplace_listings` table:
- `updated_at` timestamps should be recent (< 5 minutes)
- Active listings should match marketplace contract

## Migration Notes

### Removed Components
- ❌ `fetchListingsFromBlockchain()` - replaced with API sync
- ❌ Progressive scanning UI - no longer needed
- ❌ "Deep Rescan" - replaced with "Sync Data" (API call)

### Preserved Features
- ✅ Metadata loading with IPFS fallbacks
- ✅ Collection name resolution
- ✅ Canceled listing detection
- ✅ Manual refresh capability

## Troubleshooting

### No Listings Showing
1. Check Supabase table has recent data
2. Verify cron job is running (Vercel dashboard)
3. Test manual sync: POST `/api/sync-listings`

### Slow Sync Performance  
1. Reduce `VITE_MAX_LISTING_SCAN` if too many listings
2. Check RPC endpoint latency
3. Monitor function timeout (max 60s on Hobby plan)

### Stale Data
1. Verify cron schedule in `vercel.json`
2. Check function logs for errors
3. Test manual API call to isolate issues