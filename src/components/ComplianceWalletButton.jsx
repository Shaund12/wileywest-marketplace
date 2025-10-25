import React, { useEffect } from 'react';
import { PremiumWalletButton } from './PremiumWalletButton';
import { usePremiumWallet } from '../context/PremiumWalletContext';
import { useSanctionsGate } from '../hooks/useSanctionsGate';
import SanctionsModal from './compliance/SanctionsModal';

/**
 * Wallet button wrapper that integrates sanctions checking
 * When VITE_FLAG_SANCTIONS is enabled, checks wallet addresses on connection
 */
export function ComplianceWalletButton() {
  const { address, isConnected, disconnect } = usePremiumWallet();
  const { checkConnect, modalState, closeModal, isEnabled } = useSanctionsGate();

  // Check wallet on connection when sanctions are enabled
  useEffect(() => {
    const checkWallet = async () => {
      if (isConnected && address && isEnabled) {
        console.log('[Compliance] Checking wallet for sanctions:', address);
        const allowed = await checkConnect(address);
        
        if (!allowed) {
          console.warn('[Compliance] Wallet blocked by sanctions, disconnecting');
          // Disconnect the wallet if sanctions check fails
          await disconnect();
        }
      }
    };

    checkWallet();
  }, [isConnected, address, isEnabled, checkConnect, disconnect]);

  return (
    <>
      <PremiumWalletButton />
      {isEnabled && (
        <SanctionsModal
          isOpen={modalState.isOpen}
          onClose={closeModal}
          reason={modalState.reason}
          ref={modalState.ref}
        />
      )}
    </>
  );
}

export default ComplianceWalletButton;
