# Supabase Setup Guide for Auction Functionality

This guide provides step-by-step instructions for setting up Supabase to support the complete auction system in BlockDust Marketplace.

## Critical Updates ⚠️

**Important**: This guide includes fixes for database schema errors that were causing auction display issues. Please follow the schema migration steps if you have an existing deployment.

## Prerequisites

- Supabase account (free tier is sufficient)
- Basic understanding of SQL
- Access to your Supabase project dashboard

## 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up/log in
2. Click "New Project"
3. Choose your organization
4. Set project name (e.g., "wileywest-marketplace")
5. Set database password (save this securely)
6. Choose region (closest to your users)
7. Click "Create new project"

## 2. Get API Credentials

Once your project is created:

1. Go to **Settings** → **API**
2. Copy the following values:
   - **Project URL** (e.g., `https://abcdefghijklmnop.supabase.co`)
   - **anon/public key** (starts with `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`)

## 3. Update Environment Variables

Create or update your `.env` file with your Supabase credentials:

```env
# Replace these with your actual Supabase values
VITE_SUPABASE_URL=https://your-project-url.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here

# Marketplace Configuration - Updated Address
VITE_MARKETPLACE_ADDRESS=0xE4C31bCA890dcC1Dc038ac07a3d720A6A26877D1
VITE_ENABLE_AUCTIONS=1
```

**Important:** If you're using dummy values, auction functionality will not work properly.

## 4. Fixed Database Schema - CRITICAL UPDATE ⚠️

### Issues Resolved:
- ✅ Fixed "column auctions.timestamp does not exist" error
- ✅ Fixed "Could not find the 'metadata' column" error  
- ✅ Fixed auction ID validation and null value handling
- ✅ Enhanced error handling for production deployment

### Schema Migration

**IMPORTANT:** If you're updating an existing auction table, you MUST add the metadata column:

```sql
-- Add metadata column to existing auctions table
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
```

### Required Tables for Auction System

The schema creates these auction-specific tables:

- **`auctions`** - Main auction data (seller, NFT, prices, timing, **metadata**)
- **`auction_bids`** - All bid events with timestamps
- **`auction_settlements`** - Final auction results
- **`auction_breakdowns`** - Fee distribution details
- **`vibe_flows`** - VTRU → VIBE conversion tracking
- **`fee_conversions`** - ERC20 token conversion events
- **`royalty_payments`** - Creator royalty distributions

### Copy and Execute Schema

1. Open the **SQL Editor** in your Supabase dashboard
2. Copy the entire contents of `supabase-schema.sql`
3. Paste into the SQL editor
4. Click **Run** to execute

The schema includes:
- All table definitions with proper indexes
- Row Level Security (RLS) policies
- Public read access for transparency
- Automated timestamp triggers

## 5. Verify Setup

### Test Database Connection

1. Start your development server: `npm run dev`
2. Check the browser console for:
   ```
   ✅ Supabase client initialized for caching
   ```

### Test Auction Functionality

1. **Create an auction:**
   - Go to `/auctions/create`
   - Fill out the form with valid NFT details
   - Submit the transaction

2. **Check data persistence:**
   - Go to Supabase dashboard → **Table Editor**
   - Check the `auctions` table for your new entry
   - Verify the auction appears in `/my-auctions`

3. **Test VIBE dashboard:**
   - Navigate to `/vibe-dashboard`
   - Should show real data instead of "No data available"

## 6. Troubleshooting

### Common Issues

**"Auction not found" errors:**
- Verify the `marketplace_address` field matches your contract
- Check that the auction was properly cached during creation

**Empty VIBE dashboard:**
- Ensure your marketplace contract is generating the expected events
- Verify the event listener is running and caching data

**"Supabase not configured" warnings:**
- Double-check your environment variables
- Ensure `.env` file is in the project root
- Restart your development server after changing env vars

**RLS policy errors:**
- The schema enables Row Level Security with public read access
- No authentication is required for reading auction data
- Writing data requires the anon key to be properly configured

### Debug Logging

Enable debug mode to see detailed Supabase operations:

```env
VITE_DEBUG_MODE=true
```

Look for these console messages:
- `📦 Cached auction to Supabase...`
- `🔍 Loading auctions from cache...`
- `📡 Real-time auction update received:`

## 7. Production Considerations

### Security

- **Never expose your service_role key** - only use the anon key
- RLS policies ensure data security without authentication
- All auction data is publicly readable for transparency

### Performance

- Indexes are automatically created for optimal query performance
- Background caching reduces blockchain API calls by ~80%
- Real-time subscriptions provide instant updates

### Scaling

- Free tier supports up to 500MB database size
- Upgrade to Pro tier for larger datasets
- Consider archiving old auction data periodically

## 8. Supabase Dashboard Usage

### Monitoring Auctions

1. **Table Editor** → `auctions` - View all auction records
2. **Table Editor** → `auction_bids` - Monitor bidding activity  
3. **Table Editor** → `vibe_flows` - Track VIBE conversions

### Real-time Updates

1. Go to **Database** → **Realtime**
2. Enable realtime for auction tables if needed
3. Monitor live updates in the interface

### Data Management

- **SQL Editor** - Run custom queries and reports
- **Authentication** - Not required for auction functionality
- **Storage** - Not used by auction system

## 9. Testing Checklist

Before going live, verify:

- [ ] Supabase project created and accessible
- [ ] Environment variables set correctly
- [ ] Complete schema executed successfully
- [ ] Auction creation works and data persists
- [ ] My Auctions page loads user's auctions
- [ ] VIBE dashboard shows real data
- [ ] Bidding events are properly recorded
- [ ] Real-time updates work across browser tabs

## Support

If you encounter issues:

1. Check the browser console for error messages
2. Verify your Supabase project is active (not paused)
3. Ensure your environment variables are correctly set
4. Review the RLS policies in your Supabase dashboard

The auction system is designed to gracefully handle Supabase connection issues, but full functionality requires a properly configured database.