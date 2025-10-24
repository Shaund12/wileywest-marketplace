import { useState, useCallback } from 'react';
import { FLAGS } from '../utils/compliance/featureFlags';
import { checkNFTContract, getBlockReasonText } from '../utils/compliance/nftContractAdapter';
import { useSupabase } from '../context/SupabaseContext';
import { usePremiumWallet } from '../context/PremiumWalletContext';

/**
 * Hook for NFT contract blocklist checking
 * Only performs checks when VITE_FLAG_SANCTIONS is enabled
 */
export function useNFTContractGate() {
  const { supabase } = useSupabase();
  const { address: userAddress } = usePremiumWallet();
  const [checking, setChecking] = useState(false);
  const [modalState, setModalState] = useState({
    isOpen: false,
    reason: null,
    description: null,
    contractAddress: null
  });

  /**
   * Check if an NFT contract is allowed
   * @param {string} contractAddress - NFT contract address to check
   * @param {string} action - 'list' | 'buy' | 'transfer'
   * @returns {Promise<boolean>} - true if allowed, false if blocked
   */
  const checkContract = useCallback(async (contractAddress, action = 'buy') => {
    // If sanctions flag is not enabled, always allow
    if (!FLAGS.SANCTIONS) {
      return true;
    }

    if (!contractAddress) {
      return true;
    }

    setChecking(true);
    try {
      const result = await checkNFTContract(
        contractAddress, 
        action, 
        userAddress,
        supabase
      );
      
      if (!result.allowed) {
        // Show modal with block reason
        setModalState({
          isOpen: true,
          reason: result.reason || 'prohibited',
          description: result.description || getBlockReasonText(result.reason),
          contractAddress
        });
        return false;
      }

      return true;
    } catch (error) {
      console.error('[NFT Contract Gate] Check failed:', error);
      // Fail open: allow transaction on error
      return true;
    } finally {
      setChecking(false);
    }
  }, [supabase, userAddress]);

  /**
   * Close the contract blocked modal
   */
  const closeModal = useCallback(() => {
    setModalState({
      isOpen: false,
      reason: null,
      description: null,
      contractAddress: null
    });
  }, []);

  /**
   * Check before creating a listing
   */
  const checkBeforeList = useCallback(async (contractAddress) => {
    return checkContract(contractAddress, 'list');
  }, [checkContract]);

  /**
   * Check before purchasing
   */
  const checkBeforeBuy = useCallback(async (contractAddress) => {
    return checkContract(contractAddress, 'buy');
  }, [checkContract]);

  return {
    checking,
    modalState,
    closeModal,
    checkBeforeList,
    checkBeforeBuy,
    checkContract,
    isEnabled: FLAGS.SANCTIONS
  };
}
