import { useState, useCallback } from 'react';
import { FLAGS } from '../utils/compliance/featureFlags';
import { checkSanctions } from '../utils/compliance/sanctionsAdapter';
import { useSupabase } from '../context/SupabaseContext';

/**
 * Hook for sanctions gate checking
 * Only performs checks when VITE_FLAG_SANCTIONS is enabled
 */
export function useSanctionsGate() {
  const { supabase } = useSupabase();
  const [checking, setChecking] = useState(false);
  const [modalState, setModalState] = useState({
    isOpen: false,
    reason: null,
    ref: null
  });

  /**
   * Check if an address passes sanctions screening
   * @param {string} address - Wallet address to check
   * @param {string} action - 'connect' | 'list' | 'buy'
   * @returns {Promise<boolean>} - true if allowed, false if blocked
   */
  const checkAddress = useCallback(async (address, action = 'connect') => {
    // If sanctions flag is not enabled, always allow
    if (!FLAGS.SANCTIONS) {
      return true;
    }

    if (!address) {
      return true;
    }

    setChecking(true);
    try {
      const result = await checkSanctions(address, action, supabase);
      
      if (!result.allowed) {
        // Show modal with block reason
        setModalState({
          isOpen: true,
          reason: result.reason || 'Address is on sanctions list',
          ref: result.ref || null
        });
        return false;
      }

      return true;
    } catch (error) {
      console.error('[Sanctions Gate] Check failed:', error);
      // Fail open: allow transaction on error
      return true;
    } finally {
      setChecking(false);
    }
  }, [supabase]);

  /**
   * Close the sanctions modal
   */
  const closeModal = useCallback(() => {
    setModalState({
      isOpen: false,
      reason: null,
      ref: null
    });
  }, []);

  /**
   * Check before connecting wallet
   */
  const checkConnect = useCallback(async (address) => {
    return checkAddress(address, 'connect');
  }, [checkAddress]);

  /**
   * Check before creating a listing
   */
  const checkList = useCallback(async (address) => {
    return checkAddress(address, 'list');
  }, [checkAddress]);

  /**
   * Check before purchasing
   */
  const checkBuy = useCallback(async (address) => {
    return checkAddress(address, 'buy');
  }, [checkAddress]);

  return {
    checking,
    modalState,
    closeModal,
    checkConnect,
    checkList,
    checkBuy,
    isEnabled: FLAGS.SANCTIONS
  };
}
