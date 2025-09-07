-- Fix sync queue constraint issue for requestSync functionality
-- Adds missing unique constraint for ON CONFLICT clause in queue_wallet_sync function

-- Add unique constraint on wallet_address and chain_id 
-- This allows the queue_wallet_sync function to work properly with ON CONFLICT
ALTER TABLE sync_queue 
ADD CONSTRAINT sync_queue_wallet_chain_unique 
UNIQUE (wallet_address, chain_id);

-- Update the function comment to reflect the constraint dependency
COMMENT ON FUNCTION queue_wallet_sync IS 'Queue wallet sync with upsert logic - requires unique constraint on (wallet_address, chain_id)';

-- Add index on the unique constraint for performance
CREATE INDEX IF NOT EXISTS idx_sync_queue_wallet_chain ON sync_queue(wallet_address, chain_id);