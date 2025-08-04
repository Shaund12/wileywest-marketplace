import React, { useState } from 'react';
import { ethers } from 'ethers';

/**
 * Token Selector Component
 * Handles payment token selection and custom token addition
 */
function TokenSelector({
  paymentOptions,
  formData,
  onPaymentTokenChange,
  loadingPrices,
  customTokenData,
  onCustomTokenChange,
  onAddCustomToken,
  customTokenError,
  showAddTokenForm,
  setShowAddTokenForm
}) {
  return (
    <div className="form-group">
      <div className="payment-header">
        <label>Payment Token</label>
        <button
          type="button"
          className="add-token-button"
          onClick={() => setShowAddTokenForm(!showAddTokenForm)}
        >
          {showAddTokenForm ? 'Cancel' : '+ Add Custom Token'}
        </button>
      </div>

      {showAddTokenForm && (
        <CustomTokenForm
          customTokenData={customTokenData}
          onCustomTokenChange={onCustomTokenChange}
          onAddCustomToken={onAddCustomToken}
          customTokenError={customTokenError}
          loadingPrices={loadingPrices}
          setShowAddTokenForm={setShowAddTokenForm}
        />
      )}

      {loadingPrices && !showAddTokenForm ? (
        <div className="loading-tokens">
          <div className="loader"></div>
          <p>Loading token information...</p>
        </div>
      ) : (
        <div className="token-selector">
          {paymentOptions.map(option => (
            <TokenOption
              key={option.address}
              option={option}
              isSelected={formData.paymentToken === option.address}
              onChange={onPaymentTokenChange}
            />
          ))}

          {paymentOptions.length === 0 && (
            <div className="no-tokens-message">
              No tokens available. Add a custom token to continue.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Individual Token Option Component
 */
function TokenOption({ option, isSelected, onChange }) {
  return (
    <div className={`token-option ${isSelected ? 'selected' : ''}`}>
      <input
        type="radio"
        id={`token-${option.address}`}
        name="paymentToken"
        value={option.address}
        checked={isSelected}
        onChange={onChange}
      />
      <label htmlFor={`token-${option.address}`} className="token-label">
        <div className="token-info">
          <div className="token-name">{option.name}</div>
          <div className="token-full-name">{option.fullName}</div>
        </div>
        <div className="token-price-info">
          {option.price !== null ? (
            <div className="token-price">${option.price.toFixed(2)} USD</div>
          ) : (
            <div className="token-price-unknown">Price unknown</div>
          )}
          <div className="price-source">{option.priceSource}</div>
        </div>
      </label>
    </div>
  );
}

/**
 * Custom Token Addition Form Component
 */
function CustomTokenForm({
  customTokenData,
  onCustomTokenChange,
  onAddCustomToken,
  customTokenError,
  loadingPrices,
  setShowAddTokenForm
}) {
  return (
    <div className="custom-token-form">
      <h4>Add Custom Token</h4>

      <div className="form-group">
        <label htmlFor="address">Token Address *</label>
        <input
          type="text"
          id="address"
          className="input"
          value={customTokenData.address}
          onChange={onCustomTokenChange}
          placeholder="0x..."
          required
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="symbol">Symbol</label>
          <input
            type="text"
            id="symbol"
            className="input"
            value={customTokenData.symbol}
            onChange={onCustomTokenChange}
            placeholder="Will auto-detect if available"
          />
        </div>

        <div className="form-group">
          <label htmlFor="decimals">Decimals</label>
          <input
            type="number"
            id="decimals"
            className="input"
            value={customTokenData.decimals}
            onChange={onCustomTokenChange}
            placeholder="18"
          />
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="name">Token Name</label>
        <input
          type="text"
          id="name"
          className="input"
          value={customTokenData.name}
          onChange={onCustomTokenChange}
          placeholder="Will auto-detect if available"
        />
      </div>

      <div className="form-group">
        <label htmlFor="price">USD Price (optional)</label>
        <div className="input-with-info">
          <input
            type="number"
            id="price"
            className="input"
            value={customTokenData.price}
            onChange={onCustomTokenChange}
            placeholder="Token USD price"
            step="0.000001"
          />
          <div className="input-info">
            Enter USD price manually
          </div>
        </div>
      </div>

      {customTokenError && (
        <div className="error-message">{customTokenError}</div>
      )}

      <div className="form-actions token-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => setShowAddTokenForm(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={onAddCustomToken}
          disabled={!customTokenData.address || loadingPrices}
        >
          {loadingPrices ? 'Adding...' : 'Add Token'}
        </button>
      </div>
    </div>
  );
}

export default TokenSelector;