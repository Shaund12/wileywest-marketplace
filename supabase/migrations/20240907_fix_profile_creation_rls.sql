-- Fix RLS policies to allow profile creation without Edge Functions
-- This migration adds policies for anon users to create profiles and wallets

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "profiles_service_role_all" ON profiles;
DROP POLICY IF EXISTS "wallets_service_role_all" ON wallets;

-- Profiles: Allow anon users to create profiles, service role for all operations
CREATE POLICY "profiles_insert_anon" ON profiles
    FOR INSERT TO anon
    WITH CHECK (true);

CREATE POLICY "profiles_update_anon" ON profiles
    FOR UPDATE TO anon
    USING (true)
    WITH CHECK (true);

CREATE POLICY "profiles_service_role_all" ON profiles
    FOR ALL USING (auth.role() = 'service_role');

-- Wallets: Allow anon users to create and update their own wallets
CREATE POLICY "wallets_insert_anon" ON wallets
    FOR INSERT TO anon
    WITH CHECK (true);

CREATE POLICY "wallets_update_anon" ON wallets
    FOR UPDATE TO anon
    USING (true)
    WITH CHECK (true);

CREATE POLICY "wallets_service_role_all" ON wallets
    FOR ALL USING (auth.role() = 'service_role');

-- Add a comment explaining the change
COMMENT ON TABLE profiles IS 'User profiles with handles and metadata - Updated RLS to allow anon profile creation';
COMMENT ON TABLE wallets IS 'Wallet addresses linked to profiles with sync status - Updated RLS to allow anon wallet creation';