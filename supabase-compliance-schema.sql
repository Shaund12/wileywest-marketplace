-- ============================================================================
-- BlockDust Day-1 Compliance Schema (Additive Only)
-- ============================================================================
-- This schema adds compliance tables without altering existing structures.
-- All changes use IF NOT EXISTS / DO $ blocks for safe, idempotent deployment.
-- Rollback: Simply disable feature flags; tables remain idle.
-- ============================================================================

-- ============================================================================
-- 1. DMCA Takedown System
-- ============================================================================

-- Create DMCA status enum if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dmca_status') THEN
        CREATE TYPE dmca_status AS ENUM ('open','actioned','closed');
    END IF;
END $$;

-- DMCA takedowns table
CREATE TABLE IF NOT EXISTS dmca_takedowns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status dmca_status NOT NULL DEFAULT 'open',
    
    -- Complainant information
    complainant_name TEXT NOT NULL,
    complainant_email TEXT NOT NULL,
    rights_holder TEXT,
    
    -- Infringement details
    infringing_urls TEXT[] NOT NULL,
    original_work_urls TEXT[] NOT NULL,
    evidence_urls TEXT[] DEFAULT '{}',
    
    -- Legal attestation
    sworn_statement TEXT NOT NULL,
    signature TEXT NOT NULL,
    
    -- Metadata
    ip TEXT,
    user_agent TEXT,
    admin_notes TEXT,
    actioned_by TEXT,
    actioned_at TIMESTAMPTZ
);

-- Enable RLS for DMCA table
ALTER TABLE dmca_takedowns ENABLE ROW LEVEL SECURITY;

-- Admin read policy
CREATE POLICY IF NOT EXISTS dmca_admin_read ON dmca_takedowns
    FOR SELECT 
    USING (
        auth.jwt() ->> 'role' = 'admin' OR 
        auth.jwt() ->> 'email' IN (
            SELECT email FROM admin_users WHERE active = true
        )
    );

-- Admin update policy
CREATE POLICY IF NOT EXISTS dmca_admin_update ON dmca_takedowns
    FOR UPDATE 
    USING (
        auth.jwt() ->> 'role' = 'admin' OR 
        auth.jwt() ->> 'email' IN (
            SELECT email FROM admin_users WHERE active = true
        )
    );

-- RPC function for secure DMCA submission (public can call, but no direct INSERT)
CREATE OR REPLACE FUNCTION rpc_dmca_create(payload JSONB)
RETURNS UUID 
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$
DECLARE 
    new_id UUID;
    infringing_array TEXT[];
    original_array TEXT[];
    evidence_array TEXT[];
BEGIN
    -- Parse comma-separated URLs into arrays
    infringing_array := string_to_array(NULLIF(TRIM(payload->>'infringing_urls'), ''), ',');
    original_array := string_to_array(NULLIF(TRIM(payload->>'original_work_urls'), ''), ',');
    evidence_array := CASE 
        WHEN NULLIF(TRIM(payload->>'evidence_urls'), '') IS NOT NULL 
        THEN string_to_array(TRIM(payload->>'evidence_urls'), ',')
        ELSE '{}'::TEXT[]
    END;
    
    -- Validate required fields
    IF payload->>'complainant_name' IS NULL OR TRIM(payload->>'complainant_name') = '' THEN
        RAISE EXCEPTION 'complainant_name is required';
    END IF;
    
    IF payload->>'complainant_email' IS NULL OR TRIM(payload->>'complainant_email') = '' THEN
        RAISE EXCEPTION 'complainant_email is required';
    END IF;
    
    IF infringing_array IS NULL OR array_length(infringing_array, 1) = 0 THEN
        RAISE EXCEPTION 'At least one infringing URL is required';
    END IF;
    
    IF original_array IS NULL OR array_length(original_array, 1) = 0 THEN
        RAISE EXCEPTION 'At least one original work URL is required';
    END IF;
    
    IF payload->>'sworn_statement' IS NULL OR TRIM(payload->>'sworn_statement') = '' THEN
        RAISE EXCEPTION 'sworn_statement is required';
    END IF;
    
    IF payload->>'signature' IS NULL OR TRIM(payload->>'signature') = '' THEN
        RAISE EXCEPTION 'signature is required';
    END IF;
    
    -- Insert the DMCA takedown
    INSERT INTO dmca_takedowns (
        complainant_name, 
        complainant_email, 
        rights_holder,
        infringing_urls, 
        original_work_urls, 
        evidence_urls,
        sworn_statement, 
        signature, 
        ip, 
        user_agent
    ) VALUES (
        TRIM(payload->>'complainant_name'),
        TRIM(payload->>'complainant_email'),
        NULLIF(TRIM(payload->>'rights_holder'), ''),
        infringing_array,
        original_array,
        evidence_array,
        TRIM(payload->>'sworn_statement'),
        TRIM(payload->>'signature'),
        NULLIF(TRIM(payload->>'ip'), ''),
        NULLIF(TRIM(payload->>'user_agent'), '')
    ) RETURNING id INTO new_id;
    
    RETURN new_id;
END;
$$;

-- Grant execute permission to all users
GRANT EXECUTE ON FUNCTION rpc_dmca_create(JSONB) TO anon, authenticated;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_dmca_status ON dmca_takedowns(status);
CREATE INDEX IF NOT EXISTS idx_dmca_created_at ON dmca_takedowns(created_at DESC);

-- ============================================================================
-- 2. WISP (Written Information Security Program) Documents
-- ============================================================================

CREATE TABLE IF NOT EXISTS legal_docs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    content_md TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS for legal docs (public read, admin write)
ALTER TABLE legal_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS legal_docs_public_read ON legal_docs
    FOR SELECT USING (true);

CREATE POLICY IF NOT EXISTS legal_docs_admin_write ON legal_docs
    FOR ALL USING (
        auth.jwt() ->> 'role' = 'admin' OR 
        auth.jwt() ->> 'email' IN (
            SELECT email FROM admin_users WHERE active = true
        )
    );

-- Create index
CREATE INDEX IF NOT EXISTS idx_legal_docs_slug ON legal_docs(slug);

-- Insert default WISP document
INSERT INTO legal_docs (slug, title, version, content_md)
VALUES (
    'wisp',
    'Written Information Security Program (WISP)',
    1,
    E'# BlockDust Written Information Security Program\n\n## 1. Introduction\n\nBlockDust maintains this Written Information Security Program (WISP) to protect sensitive user data and comply with applicable regulations.\n\n## 2. Data We Collect\n\n- Wallet addresses (public blockchain data)\n- Transaction history (on-chain data)\n- Optional: Email addresses for notifications\n- IP addresses for security purposes\n\n## 3. Security Measures\n\n### Technical Safeguards\n- End-to-end encryption for sensitive communications\n- Secure API endpoints with rate limiting\n- Regular security audits and penetration testing\n- Multi-factor authentication for admin access\n\n### Administrative Safeguards\n- Employee security training\n- Access control policies\n- Incident response procedures\n- Regular policy reviews\n\n### Physical Safeguards\n- Cloud infrastructure with SOC 2 compliance\n- Encrypted data at rest and in transit\n- Redundant backups\n\n## 4. Data Retention\n\n- Transaction data: Retained indefinitely (blockchain immutability)\n- User preferences: Retained while account is active\n- Logs: Retained for 90 days\n\n## 5. Third-Party Services\n\n- Supabase: Database and authentication\n- Vercel: Hosting and edge functions\n- Vitruveo: Blockchain network\n\n## 6. Incident Response\n\nIn the event of a security incident:\n1. Immediate containment and assessment\n2. User notification within 72 hours\n3. Investigation and remediation\n4. Post-incident review\n\n## 7. Contact\n\nFor security concerns: security@blockdust.xyz\n\n**Last Updated:** January 2025\n**Version:** 1.0'
)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- 3. Sanctions Screening System
-- ============================================================================

-- Sanctions blocklist (addresses flagged by OFAC or other providers)
CREATE TABLE IF NOT EXISTS sanctions_blocklist (
    id BIGSERIAL PRIMARY KEY,
    ref TEXT NOT NULL,                    -- Reference ID from provider
    address TEXT NOT NULL UNIQUE,         -- Ethereum address (lowercase)
    provider TEXT NOT NULL DEFAULT 'local', -- local | TRM | Chainalysis
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT,
    
    CONSTRAINT address_format CHECK (address ~ '^0x[a-f0-9]{40}$')
);

-- Sanctions decision logs (audit trail)
CREATE TABLE IF NOT EXISTS sanctions_logs (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action TEXT NOT NULL,                 -- connect | list | buy
    address TEXT NOT NULL,                -- User's wallet address
    decision TEXT NOT NULL,               -- allow | block
    provider TEXT NOT NULL,               -- LocalList | TRM | Chainalysis
    context JSONB DEFAULT '{}',          -- Additional metadata
    
    CONSTRAINT valid_action CHECK (action IN ('connect', 'list', 'buy')),
    CONSTRAINT valid_decision CHECK (decision IN ('allow', 'block'))
);

-- Enable RLS for sanctions tables
ALTER TABLE sanctions_blocklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE sanctions_logs ENABLE ROW LEVEL SECURITY;

-- Admin-only access to sanctions data
CREATE POLICY IF NOT EXISTS sanctions_blocklist_admin ON sanctions_blocklist
    FOR ALL USING (
        auth.jwt() ->> 'role' = 'admin' OR 
        auth.jwt() ->> 'email' IN (
            SELECT email FROM admin_users WHERE active = true
        )
    );

CREATE POLICY IF NOT EXISTS sanctions_logs_admin ON sanctions_logs
    FOR ALL USING (
        auth.jwt() ->> 'role' = 'admin' OR 
        auth.jwt() ->> 'email' IN (
            SELECT email FROM admin_users WHERE active = true
        )
    );

-- RPC function to check if address is sanctioned
CREATE OR REPLACE FUNCTION rpc_check_sanctions(wallet_address TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    is_sanctioned BOOLEAN;
    sanction_ref TEXT;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM sanctions_blocklist 
        WHERE LOWER(address) = LOWER(wallet_address)
    ), ref INTO is_sanctioned, sanction_ref
    FROM sanctions_blocklist 
    WHERE LOWER(address) = LOWER(wallet_address)
    LIMIT 1;
    
    RETURN jsonb_build_object(
        'blocked', COALESCE(is_sanctioned, false),
        'ref', sanction_ref,
        'provider', 'local'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_check_sanctions(TEXT) TO anon, authenticated;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_sanctions_address ON sanctions_blocklist(LOWER(address));
CREATE INDEX IF NOT EXISTS idx_sanctions_logs_address ON sanctions_logs(address);
CREATE INDEX IF NOT EXISTS idx_sanctions_logs_occurred ON sanctions_logs(occurred_at DESC);

-- ============================================================================
-- 4. MA Tax Switch & Compliance Settings
-- ============================================================================

-- Compliance settings (singleton table)
CREATE TABLE IF NOT EXISTS compliance_settings (
    id INT PRIMARY KEY DEFAULT 1,
    dmca_agent_email TEXT NOT NULL DEFAULT 'legal@blockdust.xyz',
    tax_switch_enabled BOOLEAN NOT NULL DEFAULT false,
    facilitator_threshold_cents BIGINT NOT NULL DEFAULT 10000000, -- $100k
    tax_geo_mode TEXT NOT NULL DEFAULT 'none' CHECK (tax_geo_mode IN ('none','ip','self_declare')),
    tax_rate_ma_percent DECIMAL(5,3) NOT NULL DEFAULT 6.250, -- 6.25% MA sales tax
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT singleton CHECK (id = 1)
);

-- Insert default settings
INSERT INTO compliance_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- RLS for compliance settings
ALTER TABLE compliance_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS compliance_settings_read ON compliance_settings
    FOR SELECT USING (true);

CREATE POLICY IF NOT EXISTS compliance_settings_admin_write ON compliance_settings
    FOR UPDATE USING (
        auth.jwt() ->> 'role' = 'admin' OR 
        auth.jwt() ->> 'email' IN (
            SELECT email FROM admin_users WHERE active = true
        )
    );

-- NFT tax profile (per-collection tax status)
CREATE TABLE IF NOT EXISTS nft_tax_profile (
    collection_address TEXT PRIMARY KEY,
    is_taxable_ma BOOLEAN NOT NULL DEFAULT false,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT address_format CHECK (collection_address ~ '^0x[a-fA-F0-9]{40}$')
);

-- RLS for tax profile
ALTER TABLE nft_tax_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS nft_tax_profile_read ON nft_tax_profile
    FOR SELECT USING (true);

CREATE POLICY IF NOT EXISTS nft_tax_profile_admin_write ON nft_tax_profile
    FOR ALL USING (
        auth.jwt() ->> 'role' = 'admin' OR 
        auth.jwt() ->> 'email' IN (
            SELECT email FROM admin_users WHERE active = true
        )
    );

-- MA GMV tracking (requires marketplace_trades table from existing schema)
-- This is a materialized view that can be refreshed periodically
CREATE MATERIALIZED VIEW IF NOT EXISTS ma_gmv_trailing_365 AS
SELECT 
    NOW() AS computed_at,
    COALESCE(SUM(CAST(total_price AS NUMERIC) / 1e18), 0) AS gmv_vtru,
    COUNT(*) AS trades_count
FROM sales_history
WHERE 
    timestamp >= EXTRACT(EPOCH FROM (NOW() - INTERVAL '365 days'))
    -- Note: buyer_state would come from geo-enriched data when tax_geo_mode != 'none'
    -- For now, this view tracks all trades
WITH NO DATA;

-- Create index on materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_ma_gmv_unique ON ma_gmv_trailing_365(computed_at);

-- Function to refresh MA GMV view
CREATE OR REPLACE FUNCTION refresh_ma_gmv()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY ma_gmv_trailing_365;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_ma_gmv() TO authenticated;

-- ============================================================================
-- 5. Admin Users Table (if not exists)
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    wallet_address TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS admin_users_self_read ON admin_users
    FOR SELECT USING (
        auth.jwt() ->> 'email' = email OR
        auth.jwt() ->> 'role' = 'admin'
    );

-- ============================================================================
-- 6. Audit Log
-- ============================================================================

-- Update timestamp trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to relevant tables
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_dmca_updated_at') THEN
        CREATE TRIGGER update_dmca_updated_at 
        BEFORE UPDATE ON dmca_takedowns
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_legal_docs_updated_at') THEN
        CREATE TRIGGER update_legal_docs_updated_at 
        BEFORE UPDATE ON legal_docs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_compliance_settings_updated_at') THEN
        CREATE TRIGGER update_compliance_settings_updated_at 
        BEFORE UPDATE ON compliance_settings
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_nft_tax_profile_updated_at') THEN
        CREATE TRIGGER update_nft_tax_profile_updated_at 
        BEFORE UPDATE ON nft_tax_profile
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- ============================================================================
-- 7. Summary & Rollback Instructions
-- ============================================================================

-- ROLLBACK PROCEDURE:
-- 1. Set all VITE_FLAG_* environment variables to 0
-- 2. No need to drop tables; they will remain idle
-- 3. If tables must be removed (not recommended):
--    DROP MATERIALIZED VIEW IF EXISTS ma_gmv_trailing_365 CASCADE;
--    DROP TABLE IF EXISTS sanctions_logs CASCADE;
--    DROP TABLE IF EXISTS sanctions_blocklist CASCADE;
--    DROP TABLE IF EXISTS nft_tax_profile CASCADE;
--    DROP TABLE IF EXISTS compliance_settings CASCADE;
--    DROP TABLE IF EXISTS legal_docs CASCADE;
--    DROP TABLE IF EXISTS dmca_takedowns CASCADE;
--    DROP TABLE IF EXISTS admin_users CASCADE;
--    DROP TYPE IF EXISTS dmca_status CASCADE;

-- Verification queries:
-- SELECT * FROM dmca_takedowns LIMIT 5;
-- SELECT * FROM legal_docs WHERE slug = 'wisp';
-- SELECT * FROM sanctions_blocklist LIMIT 5;
-- SELECT * FROM compliance_settings;
-- SELECT * FROM ma_gmv_trailing_365;
