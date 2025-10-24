/**
 * NFT Contract Blocklist Adapter
 * Checks if NFT contracts are blocked (securities, rev-share, etc.)
 */

import { FLAGS } from './featureFlags';

/**
 * Check if an NFT contract is blocked
 * @param {string} contractAddress - NFT contract address to check
 * @param {string} action - 'list' | 'buy' | 'transfer'
 * @param {string} userAddress - User's wallet address
 * @param {object} supabaseClient - Supabase client instance
 * @returns {Promise<{allowed: boolean, reason?: string, description?: string}>}
 */
export async function checkNFTContract(contractAddress, action, userAddress, supabaseClient) {
  // If sanctions flag is not enabled, always allow
  // (NFT contract checking piggybacks on sanctions flag)
  if (!FLAGS.SANCTIONS) {
    return { allowed: true };
  }

  if (!contractAddress || !supabaseClient) {
    return { allowed: true };
  }

  try {
    // Check if contract is blocked
    const { data, error } = await supabaseClient.rpc('rpc_check_nft_contract', {
      contract_addr: contractAddress.toLowerCase()
    });

    if (error) {
      console.error('[NFT Contract] Check failed:', error);
      // Fail open: allow transaction but log the error
      return { allowed: true, error: error.message };
    }

    const isBlocked = data?.blocked || false;
    
    // Log the decision
    try {
      await supabaseClient.from('nft_contract_logs').insert({
        action,
        contract_address: contractAddress.toLowerCase(),
        user_address: userAddress?.toLowerCase() || 'unknown',
        decision: isBlocked ? 'block' : 'allow',
        reason: data?.reason || null,
        context: {
          description: data?.description || null
        }
      });
    } catch (logErr) {
      console.error('[NFT Contract] Failed to log decision:', logErr);
    }

    return {
      allowed: !isBlocked,
      reason: data?.reason || null,
      description: data?.description || null
    };
  } catch (err) {
    console.error('[NFT Contract] Check exception:', err);
    // Fail open: allow transaction but log the error
    return { allowed: true, error: err.message };
  }
}

/**
 * Get reason display text for blocked contract
 * @param {string} reason - Reason code from database
 * @returns {string} - User-friendly reason text
 */
export function getBlockReasonText(reason) {
  const reasons = {
    'securities': 'This NFT collection may be classified as a security',
    'rev_share': 'This NFT collection offers revenue sharing which may be prohibited',
    'prohibited': 'This NFT collection has been prohibited by platform policy',
    'other': 'This NFT collection is currently unavailable on this platform'
  };
  
  return reasons[reason] || 'This NFT collection cannot be traded on this platform';
}

/**
 * Admin function to add a contract to the blocklist
 * @param {string} contractAddress - Contract address to block
 * @param {string} reason - securities | rev_share | prohibited | other
 * @param {string} description - Detailed reason
 * @param {string} addedBy - Admin email/username
 * @param {object} supabaseClient - Supabase client instance
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function blockNFTContract(contractAddress, reason, description, addedBy, supabaseClient) {
  if (!supabaseClient) {
    return { success: false, error: 'No database connection' };
  }

  try {
    const { error } = await supabaseClient
      .from('nft_contract_blocklist')
      .insert({
        contract_address: contractAddress.toLowerCase(),
        reason,
        description,
        added_by: addedBy,
        active: true
      });

    if (error) {
      // Check for duplicate
      if (error.code === '23505') {
        return { success: false, error: 'Contract already in blocklist' };
      }
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Admin function to remove a contract from the blocklist
 * @param {string} contractAddress - Contract address to unblock
 * @param {object} supabaseClient - Supabase client instance
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function unblockNFTContract(contractAddress, supabaseClient) {
  if (!supabaseClient) {
    return { success: false, error: 'No database connection' };
  }

  try {
    const { error } = await supabaseClient
      .from('nft_contract_blocklist')
      .update({ active: false })
      .eq('contract_address', contractAddress.toLowerCase());

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
