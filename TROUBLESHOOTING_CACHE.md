# Troubleshooting Supabase Caching Issues

This guide helps diagnose and fix caching problems with the WileyWest Marketplace Supabase integration.

## Quick Diagnosis

1. **Open the app in your browser**
2. **Open Developer Tools (F12) and go to Console tab**
3. **Look for these log messages:**

### ✅ Good Signs (Caching Working)
```
✅ Supabase client initialized for caching
✅ Supabase connection test successful
💾 Caching X listings to Supabase...
✅ Successfully cached X listings to database
💾 Caching X sales transactions to Supabase...
✅ Successfully cached X sales to database
```

### ⚠️ Warning Signs (Caching Issues)
```
⚠️ Supabase not configured - running without cache
⚠️ Supabase connection test failed
❌ Database cache error
❌ Error caching listings
⚠️ Skipping listings cache due to
```

## Common Issues and Solutions

### 1. Environment Variables Not Set
**Symptom:** Console shows "Supabase not configured"
**Solution:** 
- Check your `.env` file has:
  ```env
  VITE_SUPABASE_URL=https://your-project.supabase.co
  VITE_SUPABASE_ANON_KEY=your-anon-key-here
  ```
- Restart your development server after adding environment variables

### 2. Database Tables Missing
**Symptom:** Console shows "relation 'marketplace_listings' does not exist"
**Solution:**
- Run the SQL from `supabase-schema.sql` in your Supabase SQL Editor
- Make sure all three tables are created: `marketplace_listings`, `user_profiles`, `sales_history`

### 3. Row Level Security (RLS) Issues
**Symptom:** Console shows "insufficient_privilege" or RLS policy errors
**Solution:**
- Check RLS policies in Supabase Dashboard -> Authentication -> Policies
- The schema includes public read policies that should work with anonymous access
- Re-run the RLS policies from `supabase-schema.sql`

### 4. Race Condition Issues
**Symptom:** Intermittent caching failures, works sometimes but not always
**Solution:**
- The latest code includes `ensureSupabaseReady()` to prevent race conditions
- Make sure you're using the latest version of the code

### 5. Network/Connectivity Issues
**Symptom:** Connection test fails, timeouts
**Solution:**
- Check your Supabase project is running (not paused)
- Verify the SUPABASE_URL is correct
- Check network connectivity to Supabase

## Manual Testing

### Test Caching Functions Directly

1. **Open browser console while app is running**
2. **Get the Supabase context:**
   ```javascript
   // This won't work - contexts are not exposed to window
   // Instead, check the console logs for cache operations
   ```

3. **Watch for cache operations in the console:**
   - Load the marketplace page and watch for listing cache logs
   - Check the profile page and watch for profile cache logs
   - Wait for sales history scanning and watch for sales cache logs

### Test Database Directly

1. **Go to your Supabase Dashboard**
2. **Table Editor -> marketplace_listings**
   - Should show cached listings after visiting marketplace
3. **Table Editor -> sales_history**
   - Should show cached sales after blockchain scanning completes
4. **Table Editor -> user_profiles**
   - Should show cached profile after visiting profile page

## Debug Mode

Add this to your browser console for verbose debugging:

```javascript
// Enable verbose logging for Supabase operations
localStorage.setItem('debug', 'supabase:*');
```

## Cache Status Indicator

The app shows cache status in the footer:
- ✅ "Real-time caching active" = Working correctly
- ❌ "Supabase caching disabled - running in direct mode" = Not configured

## Performance Verification

If caching is working correctly, you should see:
1. **First page load:** Slow (fetching from blockchain)
2. **Subsequent loads:** Fast (loading from cache)
3. **Real-time updates:** New data appears without full page refresh

## Still Having Issues?

1. **Check the complete console logs** for any error messages
2. **Verify your Supabase project settings** and make sure it's not paused
3. **Test with a fresh browser session** to rule out cache corruption
4. **Check Supabase logs** in your dashboard for server-side errors

The caching system is designed to gracefully degrade - if Supabase is unavailable, the app continues to work normally without caching.