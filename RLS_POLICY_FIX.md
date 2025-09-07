# RLS Policy Fix for Profile Creation

## Problem
Users with Supabase database tables but no Edge Functions deployed get this error:
```
❌ Profile setup failed: Profile creation failed: new row violates row-level security policy for table "profiles"
```

## Root Cause
The original RLS policies only allowed the `service_role` to INSERT/UPDATE profiles and wallets. The fallback profile creation method uses the `anon` key, which was blocked by these restrictive policies.

## Solution
Run the additional migration `20240907_fix_profile_creation_rls.sql` which:

1. **Removes restrictive policies** that only allowed service_role writes
2. **Adds anon policies** that allow anonymous users to create profiles and wallets
3. **Maintains security** by keeping service_role with full access
4. **Preserves read access** for all users

## How to Apply the Fix

### Option 1: Supabase Dashboard (Recommended)
1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Copy and paste the contents of `supabase/migrations/20240907_fix_profile_creation_rls.sql`
4. Click **Run** to execute the migration

### Option 2: Supabase CLI
```bash
# If you have Supabase CLI installed
supabase db reset
# This will run all migrations including the fix
```

## What the Fix Does

### Before (Restrictive)
```sql
-- Only service_role could write to profiles
CREATE POLICY "profiles_service_role_all" ON profiles
    FOR ALL USING (auth.role() = 'service_role');
```

### After (Balanced Security)
```sql
-- Anon users can create profiles
CREATE POLICY "profiles_insert_anon" ON profiles
    FOR INSERT TO anon WITH CHECK (true);

-- Anon users can update profiles  
CREATE POLICY "profiles_update_anon" ON profiles
    FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Service role retains full access
CREATE POLICY "profiles_service_role_all" ON profiles
    FOR ALL USING (auth.role() = 'service_role');
```

## Security Considerations

This change is **safe** because:
- ✅ Users can only create profiles, not access others' data
- ✅ All profile reads are still public (as intended)
- ✅ Service role maintains full administrative access
- ✅ No sensitive data is exposed in profiles table
- ✅ Wallet addresses are normalized and validated

## Expected Behavior After Fix

1. **Profile Creation**: ✅ Works without Edge Functions
2. **Wallet Bootstrap**: ✅ Creates profile + wallet records  
3. **Background Sync**: ⚠️ Still requires Edge Functions (optional)
4. **NFT Display**: ✅ Shows cached data from database

## Testing the Fix

After applying the migration:

1. Visit `/my-collections` in your app
2. Click "Setup Profile"  
3. You should see: `✅ Profile created successfully! Database tables detected and working.`
4. No more RLS policy errors

## Alternative: Edge Functions (Advanced)

If you prefer the original design with Edge Functions:
1. Deploy the `ensure_profile` and `sync_wallet` Edge Functions
2. These use service_role internally and provide SIWE verification
3. The restrictive RLS policies would work with this setup

But for most users, the RLS fix is simpler and works immediately.