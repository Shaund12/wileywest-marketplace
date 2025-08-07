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

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON marketplace_listings(seller);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_active ON marketplace_listings(active);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_updated_at ON marketplace_listings(updated_at);
CREATE INDEX IF NOT EXISTS idx_user_profiles_wallet ON user_profiles(wallet_address);
CREATE INDEX IF NOT EXISTS idx_sales_history_listing_id ON sales_history(listing_id);
CREATE INDEX IF NOT EXISTS idx_sales_history_buyer ON sales_history(buyer);
CREATE INDEX IF NOT EXISTS idx_sales_history_timestamp ON sales_history(timestamp);

-- Enable Row Level Security (RLS)
ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history ENABLE ROW LEVEL SECURITY;

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

-- Comments for documentation
COMMENT ON TABLE marketplace_listings IS 'Cache table for NFT marketplace listings with metadata';
COMMENT ON TABLE user_profiles IS 'Cache table for user profile data including NFTs and listings';
COMMENT ON TABLE sales_history IS 'Cache table for marketplace sales and transaction history';