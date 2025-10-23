/**
 * Sanctions Screening Adapter
 * Pluggable provider system for OFAC/sanctions checks
 */

import { COMPLIANCE_CONFIG } from './featureFlags';

/**
 * Local list provider (uses Supabase sanctions_blocklist table)
 */
class LocalListProvider {
  constructor(supabaseClient) {
    this.supabase = supabaseClient;
    this.name = 'LocalList';
  }

  /**
   * Check if an address is sanctioned
   * @param {string} address - Ethereum address to check
   * @returns {Promise<{blocked: boolean, provider: string, ref?: string}>}
   */
  async check(address) {
    if (!address || !this.supabase) {
      return { blocked: false, provider: this.name };
    }

    try {
      const { data, error } = await this.supabase.rpc('rpc_check_sanctions', {
        wallet_address: address.toLowerCase()
      });

      if (error) {
        console.error('[Sanctions] LocalList check failed:', error);
        // Fail open: allow transaction but log the error
        return { blocked: false, provider: this.name, error: error.message };
      }

      return {
        blocked: data?.blocked || false,
        provider: this.name,
        ref: data?.ref || null
      };
    } catch (err) {
      console.error('[Sanctions] LocalList exception:', err);
      // Fail open
      return { blocked: false, provider: this.name, error: err.message };
    }
  }

  /**
   * Log a sanctions decision
   * @param {string} action - connect | list | buy
   * @param {string} address - User's wallet address
   * @param {string} decision - allow | block
   * @param {object} context - Additional metadata
   */
  async logDecision(action, address, decision, context = {}) {
    if (!this.supabase) return;

    try {
      await this.supabase.from('sanctions_logs').insert({
        action,
        address: address.toLowerCase(),
        decision,
        provider: this.name,
        context
      });
    } catch (err) {
      console.error('[Sanctions] Failed to log decision:', err);
    }
  }
}

/**
 * TRM Labs provider (stub for future implementation)
 */
class TRMProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'TRM';
  }

  async check(address) {
    // TODO: Implement TRM API integration
    console.warn('[Sanctions] TRM provider not implemented, failing open');
    return { blocked: false, provider: this.name };
  }

  async logDecision(action, address, decision, context = {}) {
    console.log('[Sanctions] TRM log:', { action, address, decision });
  }
}

/**
 * Chainalysis provider (stub for future implementation)
 */
class ChainalysisProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'Chainalysis';
  }

  async check(address) {
    // TODO: Implement Chainalysis API integration
    console.warn('[Sanctions] Chainalysis provider not implemented, failing open');
    return { blocked: false, provider: this.name };
  }

  async logDecision(action, address, decision, context = {}) {
    console.log('[Sanctions] Chainalysis log:', { action, address, decision });
  }
}

/**
 * Factory function to get the configured sanctions provider
 * @param {object} supabaseClient - Supabase client instance
 * @returns {LocalListProvider|TRMProvider|ChainalysisProvider}
 */
export function getSanctionsProvider(supabaseClient) {
  const provider = COMPLIANCE_CONFIG.ofacProvider.toLowerCase();

  switch (provider) {
    case 'trm':
      return new TRMProvider(import.meta.env.VITE_TRM_API_KEY);
    case 'chainalysis':
      return new ChainalysisProvider(import.meta.env.VITE_CHAINALYSIS_API_KEY);
    case 'local':
    default:
      return new LocalListProvider(supabaseClient);
  }
}

/**
 * Sanctions gate helper - checks if address should be blocked
 * @param {string} address - Ethereum address to check
 * @param {string} action - connect | list | buy
 * @param {object} supabaseClient - Supabase client instance
 * @returns {Promise<{allowed: boolean, reason?: string, ref?: string}>}
 */
export async function checkSanctions(address, action, supabaseClient) {
  const provider = getSanctionsProvider(supabaseClient);
  
  try {
    const result = await provider.check(address);
    
    // Log the decision
    await provider.logDecision(
      action, 
      address, 
      result.blocked ? 'block' : 'allow',
      { provider: result.provider, ref: result.ref }
    );

    return {
      allowed: !result.blocked,
      reason: result.blocked ? 'Address is on sanctions list' : null,
      ref: result.ref || null,
      provider: result.provider
    };
  } catch (err) {
    console.error('[Sanctions] Check failed:', err);
    // Fail open: allow transaction but log the error
    return { allowed: true, error: err.message };
  }
}
