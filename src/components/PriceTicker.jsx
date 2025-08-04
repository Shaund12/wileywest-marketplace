import React from 'react';
import { clearPriceCache } from '../services/priceService';

/**
 * Price Ticker Component
 * Displays live token prices with update functionality
 */
function PriceTicker({ 
  livePrice, 
  tokenList, 
  priceChange, 
  lastUpdateTime, 
  updateLivePrices 
}) {
  // Format time for price ticker
  const formatTime = (date) => {
    if (!date) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const handleForceRefresh = () => {
    clearPriceCache();
    updateLivePrices();
  };

  if (Object.keys(livePrice).length === 0) {
    return null;
  }

  return (
    <div className="price-ticker">
      <div className="ticker-header">
        <span>Live Token Prices</span>
        <span className="ticker-time">
          Last updated: {formatTime(lastUpdateTime)}
        </span>
      </div>
      <div className="ticker-items">
        {Object.entries(livePrice).map(([address, price]) => {
          const token = tokenList[address];
          const change = priceChange[address] || 0;
          
          // Skip native token (shown with WVTRU)
          if (!token || token.isNative) return null;

          return (
            <PriceTickerItem
              key={address}
              token={token}
              price={price}
              change={change}
            />
          );
        })}
        
        <RefreshButton onClick={handleForceRefresh} />
      </div>
    </div>
  );
}

/**
 * Individual Price Ticker Item
 */
function PriceTickerItem({ token, price, change }) {
  const changeClass = change > 0 ? 'positive' : change < 0 ? 'negative' : '';

  return (
    <div className="ticker-item">
      <div className="ticker-symbol">{token.symbol}</div>
      <div className="ticker-price">${price.toFixed(4)}</div>
      <div className={`ticker-change ${changeClass}`}>
        {change > 0 ? '+' : ''}{change.toFixed(2)}%
      </div>
    </div>
  );
}

/**
 * Refresh Button Component
 */
function RefreshButton({ onClick }) {
  return (
    <div className="ticker-refresh" onClick={onClick} title="Force Refresh Prices">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
      </svg>
    </div>
  );
}

export default PriceTicker;