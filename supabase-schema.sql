-- Migration for WileyWest Marketplace Caching Tables
-- This file contains the SQL schema for Supabase database tables

-- Table for caching marketplace listings
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
    metadata JSONB DEFAULT '{}',
    image_url TEXT,
    name TEXT,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for caching user profile data
CREATE TABLE IF NOT EXISTS user_profiles (
    id SERIAL PRIMARY KEY,
    wallet_address TEXT UNIQUE NOT NULL,
    nfts JSONB DEFAULT '[]',
    listings JSONB DEFAULT '[]',
    balance TEXT DEFAULT '0',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for caching sales history
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- === NEW AUCTION AND VIBE TABLES ===

-- Table for auction events
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for auction bids
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for auction settlements
CREATE TABLE IF NOT EXISTS auction_settlements (
    id SERIAL PRIMARY KEY,
    auction_id TEXT NOT NULL,
    winner TEXT,
    winning_bid TEXT NOT NULL,
    reserve_met BOOLEAN NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for auction breakdown details
CREATE TABLE IF NOT EXISTS auction_breakdowns (
    id SERIAL PRIMARY KEY,
    auction_id TEXT NOT NULL,
    platform_fee TEXT NOT NULL,
    royalty TEXT NOT NULL,
    proceeds TEXT NOT NULL,
    vibe_amount TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for sale breakdowns
CREATE TABLE IF NOT EXISTS sale_breakdowns (
    id SERIAL PRIMARY KEY,
    listing_id TEXT NOT NULL,
    platform_fee TEXT NOT NULL,
    royalty TEXT NOT NULL,
    proceeds TEXT NOT NULL,
    vibe_amount TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for fee conversion events
CREATE TABLE IF NOT EXISTS fee_conversions (
    id SERIAL PRIMARY KEY,
    token_in TEXT NOT NULL,
    path BYTEA NOT NULL,
    amount_in TEXT NOT NULL,
    wvtru_out TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for VIBE fee forwarding events
CREATE TABLE IF NOT EXISTS vibe_flows (
    id SERIAL PRIMARY KEY,
    amount_native_sent TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for royalty payments
CREATE TABLE IF NOT EXISTS royalty_payments (
    id SERIAL PRIMARY KEY,
    recipient TEXT NOT NULL,
    amount TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for admin events (PathSet, PlatformFeeUpdated, etc.)
CREATE TABLE IF NOT EXISTS admin_events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    event_data JSONB NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(transaction_hash, log_index)
);

-- Table for hourly VIBE rollups (computed via cron)
CREATE TABLE IF NOT EXISTS vibe_hourly_stats (
    id SERIAL PRIMARY KEY,
    hour_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    total_vtru_sent TEXT NOT NULL,
    conversion_count INTEGER NOT NULL,
    transaction_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(hour_timestamp)
);

-- Table for per-token fee conversion rollups
CREATE TABLE IF NOT EXISTS token_fee_stats (
    id SERIAL PRIMARY KEY,
    token_address TEXT NOT NULL,
    date DATE NOT NULL,
    total_amount_in TEXT NOT NULL,
    total_wvtru_out TEXT NOT NULL,
    conversion_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(token_address, date)
);

-- Table for collection fee/royalty rollups
CREATE TABLE IF NOT EXISTS collection_stats (
    id SERIAL PRIMARY KEY,
    collection_address TEXT NOT NULL,
    date DATE NOT NULL,
    platform_fees TEXT NOT NULL,
    royalties_paid TEXT NOT NULL,
    sales_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(collection_address, date)
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON marketplace_listings(seller);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_active ON marketplace_listings(active);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_updated_at ON marketplace_listings(updated_at);
CREATE INDEX IF NOT EXISTS idx_user_profiles_wallet ON user_profiles(wallet_address);
CREATE INDEX IF NOT EXISTS idx_sales_history_listing_id ON sales_history(listing_id);
CREATE INDEX IF NOT EXISTS idx_sales_history_buyer ON sales_history(buyer);
CREATE INDEX IF NOT EXISTS idx_sales_history_timestamp ON sales_history(timestamp);

-- Auction indexes
CREATE INDEX IF NOT EXISTS idx_auctions_auction_id ON auctions(auction_id);
CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions(seller);
CREATE INDEX IF NOT EXISTS idx_auctions_end_time ON auctions(end_time);
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction_id ON auction_bids(auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_bids_bidder ON auction_bids(bidder);
CREATE INDEX IF NOT EXISTS idx_auction_bids_timestamp ON auction_bids(timestamp);

-- VIBE analytics indexes
CREATE INDEX IF NOT EXISTS idx_fee_conversions_token_in ON fee_conversions(token_in);
CREATE INDEX IF NOT EXISTS idx_fee_conversions_timestamp ON fee_conversions(timestamp);
CREATE INDEX IF NOT EXISTS idx_vibe_flows_timestamp ON vibe_flows(timestamp);
CREATE INDEX IF NOT EXISTS idx_royalty_payments_recipient ON royalty_payments(recipient);
CREATE INDEX IF NOT EXISTS idx_royalty_payments_timestamp ON royalty_payments(timestamp);
CREATE INDEX IF NOT EXISTS idx_admin_events_type ON admin_events(event_type);
CREATE INDEX IF NOT EXISTS idx_admin_events_timestamp ON admin_events(timestamp);

-- Transaction hash and log index indexes for deduplication
CREATE INDEX IF NOT EXISTS idx_auctions_tx_log ON auctions(transaction_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_auction_bids_tx_log ON auction_bids(transaction_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_fee_conversions_tx_log ON fee_conversions(transaction_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_vibe_flows_tx_log ON vibe_flows(transaction_hash, log_index);

-- Enable Row Level Security (RLS)
ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_breakdowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_breakdowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vibe_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE royalty_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vibe_hourly_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_fee_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_stats ENABLE ROW LEVEL SECURITY;

-- Policies for marketplace_listings (public read, authenticated write)
CREATE POLICY "Enable read access for all users" ON marketplace_listings FOR SELECT USING (true);
CREATE POLICY "Enable insert for authenticated users only" ON marketplace_listings FOR INSERT WITH CHECK (true);
CREATE POLICY "Enable update for authenticated users only" ON marketplace_listings FOR UPDATE USING (true);

-- Policies for user_profiles (users can only access their own data)
CREATE POLICY "Users can view their own profile" ON user_profiles FOR SELECT USING (true);
CREATE POLICY "Users can insert their own profile" ON user_profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update their own profile" ON user_profiles FOR UPDATE USING (true);

-- Policies for sales_history (public read for transparency)
CREATE POLICY "Enable read access for all users" ON sales_history FOR SELECT USING (true);
CREATE POLICY "Enable insert for authenticated users only" ON sales_history FOR INSERT WITH CHECK (true);

-- Policies for auction tables (public read)
CREATE POLICY "Public read access" ON auctions FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON auctions FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read access" ON auction_bids FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON auction_bids FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read access" ON auction_settlements FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON auction_settlements FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read access" ON auction_breakdowns FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON auction_breakdowns FOR INSERT WITH CHECK (true);

-- Policies for analytics tables (public read)
CREATE POLICY "Public read access" ON sale_breakdowns FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON sale_breakdowns FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read access" ON fee_conversions FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON fee_conversions FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read access" ON vibe_flows FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON vibe_flows FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read access" ON royalty_payments FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON royalty_payments FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read access" ON admin_events FOR SELECT USING (true);
CREATE POLICY "Authenticated insert" ON admin_events FOR INSERT WITH CHECK (true);

-- Policies for rollup tables (public read)
CREATE POLICY "Public read access" ON vibe_hourly_stats FOR SELECT USING (true);
CREATE POLICY "Authenticated write" ON vibe_hourly_stats FOR ALL WITH CHECK (true);
CREATE POLICY "Public read access" ON token_fee_stats FOR SELECT USING (true);
CREATE POLICY "Authenticated write" ON token_fee_stats FOR ALL WITH CHECK (true);
CREATE POLICY "Public read access" ON collection_stats FOR SELECT USING (true);
CREATE POLICY "Authenticated write" ON collection_stats FOR ALL WITH CHECK (true);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updated_at
CREATE TRIGGER update_marketplace_listings_updated_at BEFORE UPDATE ON marketplace_listings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_profiles_updated_at BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_token_fee_stats_updated_at BEFORE UPDATE ON token_fee_stats FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_collection_stats_updated_at BEFORE UPDATE ON collection_stats FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE marketplace_listings IS 'Cache table for NFT marketplace listings with metadata';
COMMENT ON TABLE user_profiles IS 'Cache table for user profile data including NFTs and listings';
COMMENT ON TABLE sales_history IS 'Cache table for marketplace sales and transaction history';
COMMENT ON TABLE auctions IS 'Auction creation events from VTRUNFTMarketplace';
COMMENT ON TABLE auction_bids IS 'Bid placement events with anti-snipe tracking';
COMMENT ON TABLE auction_settlements IS 'Auction settlement events';
COMMENT ON TABLE auction_breakdowns IS 'Detailed breakdown of auction settlement fees';
COMMENT ON TABLE sale_breakdowns IS 'Detailed breakdown of sale fees and distributions';
COMMENT ON TABLE fee_conversions IS 'ERC20 token to wVTRU conversion events';
COMMENT ON TABLE vibe_flows IS 'Native VTRU sent to VIBE sink';
COMMENT ON TABLE royalty_payments IS 'EIP-2981 royalty payment events';
COMMENT ON TABLE admin_events IS 'Administrative events (PathSet, fee updates, etc.)';
COMMENT ON TABLE vibe_hourly_stats IS 'Hourly rollups of VIBE flow statistics';
COMMENT ON TABLE token_fee_stats IS 'Daily rollups of per-token fee conversions';
COMMENT ON TABLE collection_stats IS 'Daily rollups of per-collection fees and royalties';