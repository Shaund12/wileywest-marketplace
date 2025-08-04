import React, { useState } from 'react';
import { NFTErrorBoundary } from './ErrorBoundary';

/**
 * NFT Preview Component
 * Displays NFT metadata, properties, and pricing information
 */
function NFTPreview({ 
  loading, 
  metadata, 
  nftImage, 
  nftName, 
  nftType,
  ownershipVerified,
  formData,
  tokenList,
  proceeds,
  fees,
  priceSource
}) {
  const [activeTab, setActiveTab] = useState('details');

  // Function to render trait rarity indicator
  const getTraitRarity = (trait) => {
    // Simulate rarity data - in a real app, you'd get this from your backend
    const rarityMap = {
      'common': { label: 'Common', color: '#78909c', percentage: '25.4%' },
      'uncommon': { label: 'Uncommon', color: '#26a69a', percentage: '15.2%' },
      'rare': { label: 'Rare', color: '#5c6bc0', percentage: '8.7%' },
      'epic': { label: 'Epic', color: '#ab47bc', percentage: '3.2%' },
      'legendary': { label: 'Legendary', color: '#ffb300', percentage: '0.9%' }
    };

    // Get random rarity for demo purposes
    const rarities = Object.keys(rarityMap);
    const randomIndex = Math.floor((trait.trait_type.length + trait.value.length) % 5);
    const rarityKey = rarities[randomIndex];

    return rarityMap[rarityKey];
  };

  if (loading) {
    return (
      <div className="nft-preview">
        <div className="preview-loading">
          <div className="loader"></div>
          <p>Loading NFT data...</p>
        </div>
      </div>
    );
  }

  if (!metadata) {
    return (
      <div className="nft-preview">
        <div className="empty-preview">
          <div className="empty-preview-icon">🖼️</div>
          <h3>NFT Preview</h3>
          <p>Enter contract address and token ID to load NFT details</p>
        </div>
      </div>
    );
  }

  return (
    <div className="nft-preview">
      <NFTErrorBoundary>
        <div className="premium-preview">
          <div className="preview-header">
            <div className="preview-badge">
              {nftType || 'NFT'}
            </div>
            {ownershipVerified && (
              <div className="ownership-badge">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="#22cc88">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
                <span>Verified Owner</span>
              </div>
            )}
          </div>

          <div className="premium-image-container">
            {nftImage ? (
              <div className="premium-image-wrapper">
                <img
                  src={nftImage}
                  alt={nftName}
                  className="premium-image"
                />
                <div className="image-overlay">
                  <a
                    href={nftImage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="zoom-button"
                    title="View Full Size"
                  >
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                      <path d="M15 3l2.3 2.3-2.89 2.87 1.42 1.42L18.7 6.7 21 9V3h-6zM3 9l2.3-2.3 2.87 2.89 1.42-1.42L6.7 5.3 9 3H3v6zm6 12l-2.3-2.3 2.89-2.87-1.42-1.42L5.3 17.3 3 15v6h6zm12-6l-2.3 2.3-2.87-2.89-1.42 1.42 2.89 2.87L15 21h6v-6z" />
                    </svg>
                  </a>
                </div>
              </div>
            ) : (
              <div className="no-image">No image available</div>
            )}
          </div>

          <div className="preview-title-section">
            <h2 className="preview-name">{nftName}</h2>
            <div className="preview-contract">
              <span className="contract-label">Contract:</span>
              <span className="contract-address">{`${formData.nftContract.slice(0, 6)}...${formData.nftContract.slice(-4)}`}</span>
              <span className="token-id">#{formData.tokenId}</span>
            </div>
          </div>

          <div className="preview-tabs">
            <button
              className={activeTab === 'details' ? 'active' : ''}
              onClick={() => setActiveTab('details')}
            >
              Details
            </button>
            <button
              className={activeTab === 'properties' ? 'active' : ''}
              onClick={() => setActiveTab('properties')}
            >
              Properties
            </button>
            <button
              className={activeTab === 'pricing' ? 'active' : ''}
              onClick={() => setActiveTab('pricing')}
            >
              Pricing & Fees
            </button>
          </div>

          <div className="preview-tab-content">
            {activeTab === 'details' && (
              <DetailsTab metadata={metadata} nftType={nftType} formData={formData} />
            )}

            {activeTab === 'properties' && (
              <PropertiesTab metadata={metadata} getTraitRarity={getTraitRarity} />
            )}

            {activeTab === 'pricing' && (
              <PricingTab 
                proceeds={proceeds} 
                tokenList={tokenList} 
                formData={formData} 
                fees={fees} 
                priceSource={priceSource} 
              />
            )}
          </div>
        </div>
      </NFTErrorBoundary>
    </div>
  );
}

// Details Tab Component
function DetailsTab({ metadata, nftType, formData }) {
  return (
    <div className="details-tab">
      <div className="detail-section">
        <h4>Description</h4>
        <p className="description-text">
          {metadata.description || 'No description available for this NFT.'}
        </p>
      </div>

      <div className="detail-section">
        <h4>NFT Details</h4>
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-label">Token Standard</div>
            <div className="detail-value">{nftType}</div>
          </div>
          <div className="detail-item">
            <div className="detail-label">Token ID</div>
            <div className="detail-value">{formData.tokenId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-label">Chain</div>
            <div className="detail-value">Vitruveo</div>
          </div>
          <div className="detail-item">
            <div className="detail-label">Owner</div>
            <div className="detail-value highlight">You</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Properties Tab Component
function PropertiesTab({ metadata, getTraitRarity }) {
  if (!metadata.attributes || metadata.attributes.length === 0) {
    return (
      <div className="properties-tab">
        <div className="no-properties">
          <p>No properties found for this NFT.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="properties-tab">
      <div className="traits-container">
        {metadata.attributes.map((attr, index) => {
          const rarity = getTraitRarity(attr);
          return (
            <div className="trait-card" key={index}>
              <div className="trait-type">{attr.trait_type}</div>
              <div className="trait-value">{attr.value}</div>
              <div className="trait-rarity" style={{ color: rarity.color }}>
                <span className="rarity-badge" style={{ backgroundColor: rarity.color }}>{rarity.label}</span>
                <span className="rarity-percent">{rarity.percentage}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Pricing Tab Component
function PricingTab({ proceeds, tokenList, formData, fees, priceSource }) {
  return (
    <div className="pricing-tab">
      <div className="pricing-summary">
        <div className="pricing-row">
          <div className="pricing-label">Listing Subtotal</div>
          <div className="pricing-value">
            <span>{proceeds.subtotal} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}</span>
            <span className="pricing-usd">
              {proceeds.usdValue === 'Unknown' ?
                '(USD value unknown)' :
                `($${proceeds.usdValue})`}
            </span>
          </div>
        </div>

        <div className="pricing-row fee">
          <div className="pricing-label">
            <span>Marketplace Fee ({fees.marketplaceFee}%)</span>
            <span className="info-icon" title="Fee charged by the marketplace">ⓘ</span>
          </div>
          <div className="pricing-value negative">
            -{proceeds.marketplaceFee} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
          </div>
        </div>

        <div className="pricing-row fee">
          <div className="pricing-label">
            <span>Creator Royalty ({fees.creatorRoyalty}%)</span>
            <span className="info-icon" title="Royalty paid to the original creator">ⓘ</span>
          </div>
          <div className="pricing-value negative">
            -{proceeds.royaltyFee} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
          </div>
        </div>

        <div className="pricing-divider"></div>

        <div className="pricing-row total">
          <div className="pricing-label">You'll Receive</div>
          <div className="pricing-value">
            <span>{proceeds.total} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}</span>
            <span className="pricing-usd">
              {proceeds.usdValue === 'Unknown' ?
                '(USD value unknown)' :
                `($${proceeds.usdValue})`}
            </span>
          </div>
        </div>

        <div className="network-fee-note">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
          </svg>
          <span>Estimated network fee: {fees.networkFee} VTRU</span>
        </div>

        {tokenList[formData.paymentToken]?.price ? (
          <div className="price-source-note">
            <span>Price data source: {priceSource[formData.paymentToken] || 'Unknown'}</span>
          </div>
        ) : (
          <div className="price-source-note warning">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
            </svg>
            <span>No USD price data available for this token</span>
          </div>
        )}
      </div>

      <div className="pricing-explainer">
        <h4>How our fees work</h4>
        <p>Our marketplace charges {fees.marketplaceFee}% on all sales to support our platform development and operations. Creator royalties of {fees.creatorRoyalty}% ensure original creators are compensated for their work.</p>
      </div>
    </div>
  );
}

export default NFTPreview;