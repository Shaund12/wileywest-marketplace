-- Wallet Profiles System Migration
-- Creates tables for wallet profiles, wallets, and NFT holdings with proper RLS

-- Profiles table for user handles/metadata
CREATE TABLE IF NOT EXISTS profiles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    handle TEXT UNIQUE NOT NULL,
    display_name TEXT,
    bio TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Wallets table for linking addresses to profiles
CREATE TABLE IF NOT EXISTS wallets (
    address TEXT PRIMARY KEY,
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    chain_id INTEGER NOT NULL DEFAULT 1490,
    last_synced_at TIMESTAMPTZ,
    needs_sync BOOLEAN DEFAULT TRUE,
    sync_status TEXT DEFAULT 'pending', -- pending, syncing, completed, error
    sync_error TEXT,
    nft_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT valid_address CHECK (length(address) = 42 AND address ~ '^0x[a-fA-F0-9]{40}$'),
    CONSTRAINT valid_chain_id CHECK (chain_id > 0)
);

-- NFT Holdings table for cached NFT data
CREATE TABLE IF NOT EXISTS nft_holdings (
    wallet_address TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    token_id NUMERIC(78,0) NOT NULL,
    chain_id INTEGER NOT NULL DEFAULT 1490,
    balance NUMERIC(78,0) DEFAULT 1,
    metadata_url TEXT,
    name TEXT,
    description TEXT,
    image_url TEXT,
    attributes JSONB DEFAULT '[]',
    token_standard TEXT DEFAULT 'ERC721', -- ERC721, ERC1155
    collection_name TEXT,
    collection_symbol TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (wallet_address, contract_address, token_id, chain_id),
    FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE CASCADE,
    
    CONSTRAINT valid_wallet_address CHECK (length(wallet_address) = 42 AND wallet_address ~ '^0x[a-fA-F0-9]{40}$'),
    CONSTRAINT valid_contract_address CHECK (length(contract_address) = 42 AND contract_address ~ '^0x[a-fA-F0-9]{40}$'),
    CONSTRAINT valid_balance CHECK (balance >= 0),
    CONSTRAINT valid_token_id CHECK (token_id >= 0)
);

-- Sync Queue table for managing wallet sync jobs
CREATE TABLE IF NOT EXISTS sync_queue (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    chain_id INTEGER NOT NULL DEFAULT 1490,
    priority INTEGER DEFAULT 5, -- 1=highest, 10=lowest
    status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    error_message TEXT,
    scheduled_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT valid_sync_wallet_address CHECK (length(wallet_address) = 42 AND wallet_address ~ '^0x[a-fA-F0-9]{40}$'),
    CONSTRAINT valid_priority CHECK (priority BETWEEN 1 AND 10),
    CONSTRAINT valid_retry_count CHECK (retry_count >= 0)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_wallets_profile_id ON wallets(profile_id);
CREATE INDEX IF NOT EXISTS idx_wallets_needs_sync ON wallets(needs_sync) WHERE needs_sync = TRUE;
CREATE INDEX IF NOT EXISTS idx_wallets_last_synced ON wallets(last_synced_at);
CREATE INDEX IF NOT EXISTS idx_wallets_chain_id ON wallets(chain_id);

CREATE INDEX IF NOT EXISTS idx_nft_holdings_wallet ON nft_holdings(wallet_address);
CREATE INDEX IF NOT EXISTS idx_nft_holdings_contract ON nft_holdings(contract_address);
CREATE INDEX IF NOT EXISTS idx_nft_holdings_chain ON nft_holdings(chain_id);
CREATE INDEX IF NOT EXISTS idx_nft_holdings_updated ON nft_holdings(updated_at);
CREATE INDEX IF NOT EXISTS idx_nft_holdings_collection ON nft_holdings(collection_name) WHERE collection_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_sync_queue_priority ON sync_queue(priority, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_wallet ON sync_queue(wallet_address);

-- RLS Policies

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nft_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_queue ENABLE ROW LEVEL SECURITY;

-- Profiles: Public read, service role write
CREATE POLICY "profiles_select_all" ON profiles
    FOR SELECT USING (true);

CREATE POLICY "profiles_service_role_all" ON profiles
    FOR ALL USING (auth.role() = 'service_role');

-- Wallets: Public read, service role write
CREATE POLICY "wallets_select_all" ON wallets
    FOR SELECT USING (true);

CREATE POLICY "wallets_service_role_all" ON wallets
    FOR ALL USING (auth.role() = 'service_role');

-- NFT Holdings: Public read, service role write
CREATE POLICY "nft_holdings_select_all" ON nft_holdings
    FOR SELECT USING (true);

CREATE POLICY "nft_holdings_service_role_all" ON nft_holdings
    FOR ALL USING (auth.role() = 'service_role');

-- Sync Queue: Service role only
CREATE POLICY "sync_queue_service_role_all" ON sync_queue
    FOR ALL USING (auth.role() = 'service_role');

-- Functions for updating timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_profiles_updated_at 
    BEFORE UPDATE ON profiles 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallets_updated_at 
    BEFORE UPDATE ON wallets 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_nft_holdings_updated_at 
    BEFORE UPDATE ON nft_holdings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to automatically update wallet NFT count
CREATE OR REPLACE FUNCTION update_wallet_nft_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
        UPDATE wallets 
        SET nft_count = (
            SELECT COALESCE(SUM(balance::INTEGER), 0) 
            FROM nft_holdings 
            WHERE wallet_address = COALESCE(NEW.wallet_address, OLD.wallet_address)
        )
        WHERE address = COALESCE(NEW.wallet_address, OLD.wallet_address);
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ language 'plpgsql';

-- Trigger to update NFT count when holdings change
CREATE TRIGGER update_wallet_nft_count_trigger
    AFTER INSERT OR UPDATE OR DELETE ON nft_holdings
    FOR EACH ROW EXECUTE FUNCTION update_wallet_nft_count();

-- Function to clean up old sync queue entries
CREATE OR REPLACE FUNCTION cleanup_sync_queue()
RETURNS void AS $$
BEGIN
    -- Remove completed/failed entries older than 24 hours
    DELETE FROM sync_queue 
    WHERE status IN ('completed', 'failed') 
    AND completed_at < NOW() - INTERVAL '24 hours';
    
    -- Reset stale processing entries older than 1 hour
    UPDATE sync_queue 
    SET status = 'pending', 
        started_at = NULL,
        retry_count = retry_count + 1
    WHERE status = 'processing' 
    AND started_at < NOW() - INTERVAL '1 hour'
    AND retry_count < max_retries;
    
    -- Mark entries that exceeded max retries as failed
    UPDATE sync_queue 
    SET status = 'failed',
        error_message = 'Max retries exceeded'
    WHERE status = 'processing' 
    AND started_at < NOW() - INTERVAL '1 hour'
    AND retry_count >= max_retries;
END;
$$ language 'plpgsql';

-- Helper function to queue wallet sync
CREATE OR REPLACE FUNCTION queue_wallet_sync(
    p_wallet_address TEXT,
    p_chain_id INTEGER DEFAULT 1490,
    p_priority INTEGER DEFAULT 5
)
RETURNS UUID AS $$
DECLARE
    sync_id UUID;
BEGIN
    -- Insert or update sync queue entry
    INSERT INTO sync_queue (wallet_address, chain_id, priority)
    VALUES (LOWER(p_wallet_address), p_chain_id, p_priority)
    ON CONFLICT (wallet_address, chain_id) 
    DO UPDATE SET 
        priority = LEAST(sync_queue.priority, EXCLUDED.priority),
        scheduled_at = CASE 
            WHEN sync_queue.status IN ('failed', 'completed') THEN NOW()
            ELSE sync_queue.scheduled_at
        END,
        status = CASE 
            WHEN sync_queue.status IN ('failed', 'completed') THEN 'pending'
            ELSE sync_queue.status
        END,
        retry_count = CASE 
            WHEN sync_queue.status IN ('failed', 'completed') THEN 0
            ELSE sync_queue.retry_count
        END
    RETURNING id INTO sync_id;
    
    -- Update wallet needs_sync flag
    UPDATE wallets 
    SET needs_sync = TRUE, 
        sync_status = 'pending'
    WHERE address = LOWER(p_wallet_address);
    
    RETURN sync_id;
END;
$$ language 'plpgsql';

-- Function to get next wallet for sync
CREATE OR REPLACE FUNCTION get_next_wallet_for_sync()
RETURNS TABLE (
    wallet_address TEXT,
    chain_id INTEGER,
    priority INTEGER,
    sync_id UUID
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        sq.wallet_address,
        sq.chain_id,
        sq.priority,
        sq.id as sync_id
    FROM sync_queue sq
    WHERE sq.status = 'pending'
    AND sq.retry_count < sq.max_retries
    ORDER BY sq.priority ASC, sq.scheduled_at ASC
    LIMIT 1;
END;
$$ language 'plpgsql';

-- Views for easier querying

-- View for wallet with profile info
CREATE OR REPLACE VIEW wallet_profiles AS
SELECT 
    w.address,
    w.chain_id,
    w.last_synced_at,
    w.needs_sync,
    w.sync_status,
    w.nft_count,
    w.created_at as wallet_created_at,
    p.id as profile_id,
    p.handle,
    p.display_name,
    p.bio,
    p.avatar_url,
    p.created_at as profile_created_at
FROM wallets w
LEFT JOIN profiles p ON w.profile_id = p.id;

-- View for NFT holdings with collection stats
CREATE OR REPLACE VIEW nft_collection_stats AS
SELECT 
    wallet_address,
    chain_id,
    contract_address,
    collection_name,
    collection_symbol,
    token_standard,
    COUNT(*) as token_count,
    SUM(balance::INTEGER) as total_balance,
    MIN(updated_at) as oldest_update,
    MAX(updated_at) as newest_update
FROM nft_holdings
GROUP BY wallet_address, chain_id, contract_address, collection_name, collection_symbol, token_standard;

-- Grant necessary permissions for service role
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Grant read permissions for anon role  
GRANT SELECT ON profiles TO anon;
GRANT SELECT ON wallets TO anon;
GRANT SELECT ON nft_holdings TO anon;
GRANT SELECT ON wallet_profiles TO anon;
GRANT SELECT ON nft_collection_stats TO anon;

-- Insert comment to track migration
COMMENT ON TABLE profiles IS 'User profiles with handles and metadata';
COMMENT ON TABLE wallets IS 'Wallet addresses linked to profiles with sync status';
COMMENT ON TABLE nft_holdings IS 'Cached NFT holdings for fast retrieval';
COMMENT ON TABLE sync_queue IS 'Queue for managing wallet sync operations';