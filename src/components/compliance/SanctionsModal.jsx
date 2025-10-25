import React from 'react';
import './SanctionsModal.css';

/**
 * SanctionsModal - Displays when a wallet is blocked by sanctions screening
 * Only appears when VITE_FLAG_SANCTIONS is enabled
 */
function SanctionsModal({ isOpen, onClose, reason, ref }) {
  if (!isOpen) return null;

  return (
    <div className="sanctions-modal-overlay" onClick={onClose}>
      <div className="sanctions-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10" strokeWidth="2" />
            <line x1="12" y1="8" x2="12" y2="12" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="16" r="0.5" fill="currentColor" />
          </svg>
        </div>

        <h2>Transaction Blocked</h2>
        
        <p className="modal-message">
          Your wallet address has been flagged by our compliance screening system
          and cannot proceed with this transaction at this time.
        </p>

        {reason && (
          <div className="modal-detail">
            <strong>Reason:</strong> {reason}
          </div>
        )}

        {ref && (
          <div className="modal-detail">
            <strong>Reference:</strong> {ref}
          </div>
        )}

        <div className="modal-info">
          <h3>What Does This Mean?</h3>
          <p>
            Our platform performs automated sanctions screening to comply with
            U.S. and international regulations. Your wallet address appears on
            one or more sanctions lists.
          </p>

          <h3>If You Believe This is an Error</h3>
          <p>
            Please contact our compliance team with your wallet address and
            any supporting documentation:
          </p>
          <p className="contact-info">
            <a href="mailto:compliance@blockdust.xyz">compliance@blockdust.xyz</a>
          </p>
          <p className="review-time">
            We review all appeals within 3-5 business days.
          </p>
        </div>

        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>
            I Understand
          </button>
          <a 
            href="/legal/sanctions" 
            className="btn-secondary"
            onClick={onClose}
          >
            Learn More
          </a>
        </div>
      </div>
    </div>
  );
}

export default SanctionsModal;
