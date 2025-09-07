# PROFILE CREATION SETUP INSTRUCTIONS

The profile creation system requires proper Supabase configuration. Follow these steps:

## 1. Set Correct Environment Variables

You mentioned you added the Supabase table migrations. Now you need to set the correct environment variables in your `.env` file:

```env
# Replace with your ACTUAL Supabase project details
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-from-supabase-dashboard

# Other required variables
VITE_RPC_URL=https://rpc.vitruveo.xyz
VITE_MARKETPLACE_ADDRESS=0x0000000000000000000000000000000000000000
VITE_CHAIN_ID=1490
```

## 2. Find Your Supabase Details

1. Go to your Supabase project dashboard
2. Navigate to Settings → API
3. Copy the "Project URL" → use as `VITE_SUPABASE_URL`
4. Copy the "anon public" key → use as `VITE_SUPABASE_ANON_KEY`

## 3. Test Profile Creation

With the correct environment variables:

1. Start the development server: `npm run dev`
2. Navigate to `/my-collections`
3. Click "Setup Profile"
4. The system will:
   - Try Edge Functions first (will fail if not deployed - this is normal)
   - Fall back to direct database access (should work if tables exist)
   - Show detailed debug logs in the browser console

## 4. Debugging

Open browser developer tools (F12) and check the console for debug messages starting with "DEBUG:". This will show you exactly where the profile creation is failing.

## 5. Common Issue: RLS Policy Error

If you get this error:
```
❌ Profile setup failed: Profile creation failed: new row violates row-level security policy for table "profiles"
```

This means you need to run the RLS policy fix migration. See `RLS_POLICY_FIX.md` for detailed instructions, or quickly fix it by:

1. Go to Supabase Dashboard → SQL Editor
2. Run the contents of `supabase/migrations/20240907_fix_profile_creation_rls.sql`
3. Try profile creation again

## 6. Expected Behavior

If tables exist but Edge Functions aren't deployed:
- ✅ Profile creation should work via fallback (after RLS fix)
- ✅ Wallet record should be created
- ⚠️ Background NFT syncing won't work (requires Edge Functions)
- ✅ You should see "Profile created successfully! Database tables detected and working."

## 6. Common Issues

- **CORS errors**: Check your Supabase URL and anon key
- **Table not found**: Ensure migrations were run successfully
- **Unauthorized**: Check anon key and RLS policies
- **Network errors**: Verify Supabase project is active

Run the updated code and check the browser console for detailed debug output.