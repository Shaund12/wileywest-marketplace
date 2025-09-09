-- Migration: Add sale_status and sale_transaction_hash columns to marketplace_listings table
-- This migration adds sale tracking functionality to existing marketplace_listings tables

-- Add sale_status column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'marketplace_listings' 
        AND column_name = 'sale_status'
    ) THEN
        ALTER TABLE marketplace_listings 
        ADD COLUMN sale_status TEXT DEFAULT 'active';
        
        -- Add check constraint for valid sale statuses
        ALTER TABLE marketplace_listings 
        ADD CONSTRAINT chk_sale_status 
        CHECK (sale_status IN ('active', 'sold', 'canceled'));
        
        RAISE NOTICE 'Added sale_status column to marketplace_listings';
    ELSE
        RAISE NOTICE 'sale_status column already exists in marketplace_listings';
    END IF;
END $$;

-- Add sale_transaction_hash column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'marketplace_listings' 
        AND column_name = 'sale_transaction_hash'
    ) THEN
        ALTER TABLE marketplace_listings 
        ADD COLUMN sale_transaction_hash TEXT;
        
        RAISE NOTICE 'Added sale_transaction_hash column to marketplace_listings';
    ELSE
        RAISE NOTICE 'sale_transaction_hash column already exists in marketplace_listings';
    END IF;
END $$;

-- Add index for sale_status if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'marketplace_listings' 
        AND indexname = 'idx_marketplace_listings_sale_status'
    ) THEN
        CREATE INDEX idx_marketplace_listings_sale_status 
        ON marketplace_listings(sale_status);
        
        RAISE NOTICE 'Created index idx_marketplace_listings_sale_status';
    ELSE
        RAISE NOTICE 'Index idx_marketplace_listings_sale_status already exists';
    END IF;
END $$;

-- Update existing listings to set correct sale_status based on active column
UPDATE marketplace_listings 
SET sale_status = CASE 
    WHEN active = true THEN 'active'
    WHEN active = false THEN 'sold'
    ELSE 'active'
END
WHERE sale_status = 'active' AND active = false;

-- Add comment for documentation
COMMENT ON COLUMN marketplace_listings.sale_status IS 'Status of the listing: active, sold, or canceled';
COMMENT ON COLUMN marketplace_listings.sale_transaction_hash IS 'Transaction hash of the sale if the listing was sold';

-- Update the table comment
COMMENT ON TABLE marketplace_listings IS 'Cache table for NFT marketplace listings with metadata and sale tracking';

-- Print completion message
DO $$
BEGIN
    RAISE NOTICE 'Migration completed successfully. marketplace_listings table now has sale tracking columns.';
END $$;