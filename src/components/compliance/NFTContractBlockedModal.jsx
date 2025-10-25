import React from 'react';
import { getBlockReasonText } from '../../utils/compliance/nftContractAdapter';
import './NFTContractBlockedModal.css';

function NFTContractBlockedModal({ isOpen, onClose, reason, description, contractAddress }) {
  if (!isOpen) return null;

  const reasonText = description || getBlockReasonText(reason);

  return (
    <div className="contract-modal-overlay" onClick={onClose}>
      <div className="contract-modal" onClick={(e) => e.stopPropagation()}>
        <div className="contract-modal-header">
          <h2>⚠️ NFT Collection Unavailable</h2>
        </div>

        <div className="contract-modal-body">
          <div className="contract-alert">
            <p className="contract-alert-title">
              This NFT collection cannot be traded on this platform.
            </p>
          </div>

          <div className="contract-details">
            <h3>Reason</h3>
            <p>{reasonText}</p>

            {contractAddress && (
              <>
                <h3>Contract Address</h3>
                <p className="contract-address">
                  {contractAddress.slice(0, 6)}...{contractAddress.slice(-4)}
                </p>
              </>
            )}
          </div>

          <div className="contract-info-box">
            <h3>What Does This Mean?</h3>
            <ul>
              <li>This NFT collection has been identified as potentially prohibited</li>
              <li>Common reasons include securities classification or revenue-sharing mechanisms</li>
              <li>The platform restricts trading of such collections for regulatory compliance</li>
            </ul>
          </div>

          <div className="contract-info-box">
            <h3>What Can I Do?</h3>
            <ul>
              <li>If you believe this is an error, please contact support</li>
              <li>You can transfer your NFTs using other platforms or directly through blockchain transactions</li>
              <li>Check our <a href="/legal/sanctions" target="_blank" rel="noopener noreferrer">compliance policy</a> for more information</li>
            </ul>
          </div>
        </div>

        <div className="contract-modal-footer">
          <button className="btn-primary" onClick={onClose}>
            I Understand
          </button>
        </div>
      </div>
    </div>
  );
}

export default NFTContractBlockedModal;
