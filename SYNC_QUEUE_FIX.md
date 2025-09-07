# Sync Queue Constraint Fix

## Issue
Users were getting this error when trying to request NFT sync:
```
❌ Sync function not available - backend features may not be deployed: there is no unique or exclusion constraint matching the ON CONFLICT specification
```

## Root Cause
The `queue_wallet_sync` function was trying to use `ON CONFLICT (wallet_address, chain_id)` but the `sync_queue` table didn't have a unique constraint on those columns.

## Solution
A new migration `20240907_fix_sync_queue_constraint.sql` adds the missing unique constraint:

```sql
ALTER TABLE sync_queue 
ADD CONSTRAINT sync_queue_wallet_chain_unique 
UNIQUE (wallet_address, chain_id);
```

## How to Apply the Fix

### Option 1: Supabase Dashboard (Recommended)
1. Go to your Supabase Dashboard
2. Navigate to SQL Editor
3. Copy and paste the contents of `supabase/migrations/20240907_fix_sync_queue_constraint.sql`
4. Run the migration

### Option 2: Supabase CLI
```bash
# If you have Supabase CLI set up
supabase db push
```

## Expected Behavior After Fix
- ✅ "Refresh" button in My Collections page works without errors
- ✅ Profile setup automatically queues wallet sync
- ✅ Background sync requests work properly
- ✅ No more constraint violation errors

## Technical Details
The `queue_wallet_sync` function performs an upsert operation to:
- Insert new sync requests
- Update existing requests with higher priority
- Reset failed/completed requests to pending

This requires a unique constraint on `(wallet_address, chain_id)` to work properly with PostgreSQL's `ON CONFLICT` clause.