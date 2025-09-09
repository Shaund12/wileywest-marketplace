# VIBE Dashboard Tracking Fix

## Problem
The VIBE dashboard was not tracking fees correctly because:
1. The `VITE_VIBE_SINK_ADDRESS` in the environment was pointing to the wrong address
2. No mechanism existed to sync VIBE fees from blockchain transactions into the dashboard tables

## Transaction Analysis
From the provided transaction trace, VIBE fees are being sent to `0x327fab0f5a79c884b9e3fc611d490a19147d235` with amounts:
- `0x1feb3dd067660000` = 2.3 VTRU
- `0x22b1c8c1227a0000` = 2.5 VTRU  
- `0x270801d946c940000` = 2.9 VTRU
**Total: ~7.7 VTRU in VIBE fees**

## Changes Made

### 1. Updated VIBE Sink Address
**File**: `.env.example`
```diff
- VITE_VIBE_SINK_ADDRESS=0x8e7C7f0DF435Be6773641f8cf62C590d7Dde5a8a
+ VITE_VIBE_SINK_ADDRESS=0x327fab0f5a79c884b9e3fc611d490a19147d235
```

### 2. Created VIBE Fee Sync API
**File**: `api/sync-vibe-fees.js`
- Scans blockchain for ERC20 transfers to the VIBE sink address
- Populates `sale_breakdowns` table with fee data
- Tracks sync progress in `marketplace_sync_meta` table
- Provides detailed logging matching cron job format

### 3. Enhanced Database Schema
**File**: `supabase-schema.sql`
- Added `vibe_portion_in_payment`, `token_address`, `from_address`, `to_address` fields to `sale_breakdowns`
- Added `last_vibe_fee_block` and `last_vibe_fee_sync` to `marketplace_sync_meta`

### 4. Improved Dashboard Logic
**File**: `src/pages/VibeDashboardPage.jsx`
- Enhanced `getVibeAmount()` function to prioritize `vibe_portion_in_payment` field
- Added fallback to `vibe_amount` field for backward compatibility
- Updated UI to show the correct VIBE sink address and sync instructions

## Usage

### To Sync VIBE Fees
Call the new API endpoint:
```bash
curl -X GET https://your-domain.com/api/sync-vibe-fees
```

### Expected Response
```json
{
  "success": true,
  "summary": {
    "blocksScanned": 5000,
    "feesFound": 12,
    "totalAmount": "15.4200",
    "lastBlock": 1234567
  }
}
```

### Dashboard Updates
- Navigate to `/vibe-dashboard` to see real-time VIBE fee statistics
- Dashboard now shows the correct VIBE sink address
- Displays instructions for populating data

## Testing
1. Deploy the updated schema to your Supabase database
2. Update your environment variables with the correct VIBE sink address
3. Call `/api/sync-vibe-fees` to populate historical data
4. Check the VIBE dashboard for accurate fee tracking

## Cron Job Integration
To automatically sync fees, add this to your cron jobs:
```bash
# Sync VIBE fees every 10 minutes
*/10 * * * * curl -X GET https://your-domain.com/api/sync-vibe-fees
```

The sync is incremental and will only process new blocks since the last sync.