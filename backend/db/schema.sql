-- ============================================================================
-- BlockDust Marketplace — Local PostgreSQL schema
-- ----------------------------------------------------------------------------
-- Translated from supabase-schema.sql + migration-add-sale-status.sql +
-- the referenced parts of supabase-compliance-schema.sql.
--
-- Differences from the Supabase originals:
--   * All Row-Level-Security (ALTER TABLE ... ENABLE RLS) and the "allow all"
--     / auth.jwt() policies are dropped. We connect with an owning role over a
--     private, server-side pool — there is no anon browser access anymore, so
--     RLS is unnecessary. Access control is now "only the backend can reach PG".
--   * Extra columns the sync handlers rely on (last_full_scan_block,
--     sync_status, last_sync) are added to user_profiles.
--   * A marketplace_sync_meta table (referenced by api/sync-listings.js but
--     never present in the original schema) is created.
--   * PostgREST-specific grants (TO anon, authenticated) are omitted.
--
-- Apply with:  psql "$DATABASE_URL" -f backend/db/schema.sql
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── Core marketplace cache tables ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_listings (
    id SERIAL PRIMARY KEY,
    listing_id TEXT UNIQUE NOT NULL,
    seller TEXT NOT NULL,
    nft_contract TEXT NOT NULL,
    token_id TEXT NOT NULL,
    quantity TEXT NOT NULL,
    price_per_unit TEXT NOT NULL,
    payment_token TEXT NOT NULL,
    is_erc1155 BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    sale_status TEXT DEFAULT 'active',            -- 'active' | 'sold' | 'canceled'
    sale_transaction_hash TEXT,
    metadata JSONB DEFAULT '{}',
    image_url TEXT,
    name TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_profiles (
    id SERIAL PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    chain_id BIGINT NOT NULL DEFAULT 7847,
    nfts JSONB DEFAULT '[]',
    listings JSONB DEFAULT '[]',
    balance TEXT DEFAULT '0',
    -- Extra columns used by api/sync-user-collections.js:
    last_full_scan_block BIGINT,
    sync_status TEXT,
    last_sync TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS chain_id BIGINT NOT NULL DEFAULT 7847;
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_wallet_address_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_wallet_chain ON user_profiles(wallet_address, chain_id);

CREATE TABLE IF NOT EXISTS sales_history (
    id SERIAL PRIMARY KEY,
    listing_id TEXT NOT NULL,
    buyer TEXT NOT NULL,
    seller TEXT,
    quantity TEXT NOT NULL,
    total_price TEXT NOT NULL,
    payment_token TEXT NOT NULL,
    transaction_hash TEXT UNIQUE,
    block_number BIGINT,
    timestamp BIGINT NOT NULL,
    sale_type TEXT DEFAULT 'sale',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Incremental sync bookmark (referenced by api/sync-listings.js).
CREATE TABLE IF NOT EXISTS marketplace_sync_meta (
    key TEXT PRIMARY KEY,
    last_block BIGINT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Auction tables ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auctions (
    id SERIAL PRIMARY KEY,
    auction_id TEXT UNIQUE NOT NULL,
    marketplace_address TEXT NOT NULL,
    seller TEXT NOT NULL,
    nft_contract TEXT NOT NULL,
    token_id TEXT NOT NULL,
    quantity TEXT NOT NULL,
    reserve_price TEXT NOT NULL,
    start_price TEXT NOT NULL,
    end_time BIGINT NOT NULL,
    payment_token TEXT NOT NULL,
    min_bid_increment_bps INTEGER NOT NULL,
    anti_snipe_seconds INTEGER NOT NULL,
    highest_bidder TEXT DEFAULT '0x0000000000000000000000000000000000000000',
    highest_bid TEXT DEFAULT '0',
    settled BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS auction_bids (
    id SERIAL PRIMARY KEY,
    auction_id TEXT NOT NULL,
    bidder TEXT NOT NULL,
    amount TEXT NOT NULL,
    new_end_time BIGINT,
    is_native BOOLEAN NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(transaction_hash, log_index)
);

-- ── Metadata / image / prewarm / metrics cache tables ──────────────────────

CREATE TABLE IF NOT EXISTS metadata_cache (
    id SERIAL PRIMARY KEY,
    contract_address TEXT NOT NULL,
    token_id TEXT NOT NULL,
    metadata JSONB NOT NULL,
    image_url TEXT,
    placeholder_data JSONB,
    token_uri TEXT,
    cache_key TEXT UNIQUE NOT NULL,
    hits INTEGER DEFAULT 0,
    last_hit TIMESTAMPTZ,
    ttl_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(contract_address, token_id)
);
CREATE INDEX IF NOT EXISTS idx_metadata_cache_key ON metadata_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_metadata_cache_ttl ON metadata_cache(ttl_expires_at);

CREATE TABLE IF NOT EXISTS image_cache (
    id SERIAL PRIMARY KEY,
    original_url TEXT UNIQUE NOT NULL,
    proxy_url TEXT NOT NULL,
    content_type TEXT,
    content_length BIGINT,
    placeholder_data JSONB,
    gateway_used TEXT,
    cache_status TEXT DEFAULT 'cached',
    hits INTEGER DEFAULT 0,
    last_hit TIMESTAMPTZ,
    ttl_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_image_cache_original_url ON image_cache(original_url);
CREATE INDEX IF NOT EXISTS idx_image_cache_ttl ON image_cache(ttl_expires_at);

CREATE TABLE IF NOT EXISTS prewarm_queue (
    id SERIAL PRIMARY KEY,
    job_type TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    token_id TEXT,
    listing_id TEXT,
    metadata_url TEXT,
    image_urls TEXT[],
    priority INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    error_message TEXT,
    processed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prewarm_queue_status_priority ON prewarm_queue(status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS cache_metrics (
    id SERIAL PRIMARY KEY,
    metric_type TEXT NOT NULL,
    cache_type TEXT NOT NULL,
    value NUMERIC NOT NULL,
    dimensions JSONB,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cache_metrics_type_timestamp ON cache_metrics(metric_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_cache_metrics_cache_type ON cache_metrics(cache_type, timestamp);

-- ── Indexes on core tables ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON marketplace_listings(seller);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_active ON marketplace_listings(active);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_sale_status ON marketplace_listings(sale_status);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_updated_at ON marketplace_listings(updated_at);
CREATE INDEX IF NOT EXISTS idx_user_profiles_wallet ON user_profiles(wallet_address);
CREATE INDEX IF NOT EXISTS idx_sales_history_listing_id ON sales_history(listing_id);
CREATE INDEX IF NOT EXISTS idx_sales_history_buyer ON sales_history(buyer);
CREATE INDEX IF NOT EXISTS idx_sales_history_timestamp ON sales_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions(seller);
CREATE INDEX IF NOT EXISTS idx_auctions_marketplace ON auctions(marketplace_address);
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction_id ON auction_bids(auction_id);

-- ── updated_at trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_marketplace_listings_updated_at ON marketplace_listings;
CREATE TRIGGER update_marketplace_listings_updated_at BEFORE UPDATE ON marketplace_listings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER update_user_profiles_updated_at BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Compliance (subset actually referenced by the frontend / adapters)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sanctions_blocklist (
    id BIGSERIAL PRIMARY KEY,
    ref TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'local',
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS sanctions_logs (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action TEXT NOT NULL,
    address TEXT NOT NULL,
    decision TEXT NOT NULL,
    provider TEXT NOT NULL,
    context JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sanctions_address ON sanctions_blocklist(LOWER(address));

CREATE TABLE IF NOT EXISTS nft_contract_blocklist (
    id BIGSERIAL PRIMARY KEY,
    contract_address TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    description TEXT,
    added_by TEXT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active BOOLEAN NOT NULL DEFAULT true,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS nft_contract_logs (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    user_address TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    context JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS dmca_takedowns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'open',
    complainant_name TEXT NOT NULL,
    complainant_email TEXT NOT NULL,
    rights_holder TEXT,
    infringing_urls TEXT[] NOT NULL,
    original_work_urls TEXT[] NOT NULL,
    evidence_urls TEXT[] DEFAULT '{}',
    sworn_statement TEXT NOT NULL,
    signature TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    admin_notes TEXT,
    actioned_by TEXT,
    actioned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS compliance_settings (
    id BIGSERIAL PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RPC-equivalent functions (called via the /api/db/rpc/:fn endpoint).

CREATE OR REPLACE FUNCTION rpc_check_sanctions(wallet_address TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    sanction_ref TEXT;
BEGIN
    SELECT ref INTO sanction_ref
    FROM sanctions_blocklist
    WHERE LOWER(address) = LOWER(wallet_address)
    LIMIT 1;

    RETURN jsonb_build_object(
        'blocked', sanction_ref IS NOT NULL,
        'ref', sanction_ref,
        'provider', 'local'
    );
END;
$$;

CREATE OR REPLACE FUNCTION rpc_check_nft_contract(contract_addr TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    r RECORD;
BEGIN
    SELECT reason, description INTO r
    FROM nft_contract_blocklist
    WHERE LOWER(contract_address) = LOWER(contract_addr) AND active = true
    LIMIT 1;

    IF r IS NULL THEN
        RETURN jsonb_build_object('blocked', false);
    END IF;

    RETURN jsonb_build_object(
        'blocked', true,
        'reason', r.reason,
        'description', r.description
    );
END;
$$;

CREATE OR REPLACE FUNCTION rpc_dmca_create(payload JSONB)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
    new_id UUID;
    infringing_array TEXT[];
    original_array TEXT[];
    evidence_array TEXT[];
BEGIN
    infringing_array := string_to_array(NULLIF(TRIM(payload->>'infringing_urls'), ''), ',');
    original_array := string_to_array(NULLIF(TRIM(payload->>'original_work_urls'), ''), ',');
    evidence_array := CASE
        WHEN NULLIF(TRIM(payload->>'evidence_urls'), '') IS NOT NULL
        THEN string_to_array(TRIM(payload->>'evidence_urls'), ',')
        ELSE '{}'::TEXT[]
    END;

    IF NULLIF(TRIM(payload->>'complainant_name'), '') IS NULL THEN
        RAISE EXCEPTION 'complainant_name is required';
    END IF;
    IF NULLIF(TRIM(payload->>'complainant_email'), '') IS NULL THEN
        RAISE EXCEPTION 'complainant_email is required';
    END IF;
    IF infringing_array IS NULL OR array_length(infringing_array, 1) = 0 THEN
        RAISE EXCEPTION 'At least one infringing URL is required';
    END IF;
    IF original_array IS NULL OR array_length(original_array, 1) = 0 THEN
        RAISE EXCEPTION 'At least one original work URL is required';
    END IF;
    IF NULLIF(TRIM(payload->>'sworn_statement'), '') IS NULL THEN
        RAISE EXCEPTION 'sworn_statement is required';
    END IF;
    IF NULLIF(TRIM(payload->>'signature'), '') IS NULL THEN
        RAISE EXCEPTION 'signature is required';
    END IF;

    INSERT INTO dmca_takedowns (
        complainant_name, complainant_email, rights_holder,
        infringing_urls, original_work_urls, evidence_urls,
        sworn_statement, signature, ip, user_agent
    ) VALUES (
        TRIM(payload->>'complainant_name'),
        TRIM(payload->>'complainant_email'),
        NULLIF(TRIM(payload->>'rights_holder'), ''),
        infringing_array, original_array, evidence_array,
        TRIM(payload->>'sworn_statement'),
        TRIM(payload->>'signature'),
        NULLIF(TRIM(payload->>'ip'), ''),
        NULLIF(TRIM(payload->>'user_agent'), '')
    ) RETURNING id INTO new_id;

    RETURN new_id;
END;
$$;

-- No-op stand-in for the Supabase materialized-view refresh (GMV analytics
-- were never wired to real data locally; ComplianceAdminPage tolerates this).
CREATE OR REPLACE FUNCTION refresh_ma_gmv()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    RETURN;
END;
$$;
