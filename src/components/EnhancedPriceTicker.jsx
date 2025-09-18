// Enhanced Price Ticker Component with Blockchain Scanning and History
import React, { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { getEnhancedPriceTracker } from '../utils/enhancedPriceTicker';
import { debugLog, debugWarn } from '../utils/debugUtils';
import './EnhancedPriceTicker.css';

const EnhancedPriceTicker = ({ 
  provider, 
  tokenList = {}, 
  onPriceUpdate = () => {},
  showAdvancedMetrics = true,
  enableBlockchainScan = true,
  autoRefreshInterval = 30000 
}) => {
  const [priceData, setPriceData] = useState({});
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [selectedTimeframe, setSelectedTimeframe] = useState('24h');
  const [scanningTokens, setScanningTokens] = useState(false);
  const [discoveredTokens, setDiscoveredTokens] = useState([]);
  const [showChart, setShowChart] = useState({});
  const [errors, setErrors] = useState({});
  
  const trackerRef = useRef(null);
  const refreshTimeoutRef = useRef(null);

  // Initialize enhanced price tracker
  useEffect(() => {
    if (provider && !trackerRef.current) {
      trackerRef.current = getEnhancedPriceTracker(provider);
      
      // Subscribe to updates
      const unsubscribe = trackerRef.current.subscribe((data) => {
        debugLog('Enhanced price tracker update:', data);
      });
      
      return () => {
        unsubscribe();
        if (trackerRef.current) {
          trackerRef.current.stopAutoUpdate();
        }
      };
    }
  }, [provider]);

  // Auto-refresh prices
  useEffect(() => {
    if (autoRefreshInterval > 0) {
      const interval = setInterval(() => {
        refreshPrices();
      }, autoRefreshInterval);
      
      return () => clearInterval(interval);
    }
  }, [autoRefreshInterval, tokenList]);

  // Initial price fetch
  useEffect(() => {
    if (Object.keys(tokenList).length > 0) {
      refreshPrices();
    }
  }, [tokenList]);

  // Fetch enhanced price data for all tokens
  const refreshPrices = async () => {
    if (!trackerRef.current || loading) return;
    
    setLoading(true);
    setErrors({});
    
    try {
      const newPriceData = {};
      const newErrors = {};
      
      for (const [address, tokenData] of Object.entries(tokenList)) {
        try {
          const enhancedData = await trackerRef.current.fetchEnhancedPrice(address, tokenData);
          newPriceData[address] = enhancedData;
        } catch (error) {
          debugWarn(`Failed to fetch enhanced price for ${address}:`, error);
          newErrors[address] = error.message || 'Price fetch failed';
        }
      }
      
      setPriceData(newPriceData);
      setErrors(newErrors);
      setLastUpdate(new Date());
      
      // Notify parent component
      onPriceUpdate(newPriceData);
      
    } catch (error) {
      debugWarn('Enhanced price refresh failed:', error);
    } finally {
      setLoading(false);
    }
  };

  // Scan blockchain for new tokens
  const scanForTokens = async () => {
    if (!trackerRef.current || scanningTokens) return;
    
    setScanningTokens(true);
    
    try {
      debugLog('Starting blockchain token scan...');
      const discovered = await trackerRef.current.scanForTokens();
      setDiscoveredTokens(Array.from(discovered.values()));
      debugLog(`Discovered ${discovered.size} tokens`);
    } catch (error) {
      debugWarn('Token scanning failed:', error);
    } finally {
      setScanningTokens(false);
    }
  };

  // Format time for display
  const formatTime = (date) => {
    if (!date) return 'Never';
    return date.toLocaleTimeString();
  };

  // Format large numbers
  const formatNumber = (num, decimals = 2) => {
    if (num >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
    return num.toFixed(decimals);
  };

  // Toggle chart visibility
  const toggleChart = (address) => {
    setShowChart(prev => ({
      ...prev,
      [address]: !prev[address]
    }));
  };

  // Render price trend indicator
  const renderTrendIndicator = (changes) => {
    const change = changes[selectedTimeframe];
    if (!change) return null;
    
    const isPositive = change.changePercent > 0;
    const isNegative = change.changePercent < 0;
    
    return (
      <div className={`trend-indicator ${isPositive ? 'positive' : isNegative ? 'negative' : 'neutral'}`}>
        <span className="trend-arrow">
          {isPositive ? '↗' : isNegative ? '↘' : '→'}
        </span>
        <span className="trend-percent">
          {isPositive ? '+' : ''}{change.changePercent.toFixed(2)}%
        </span>
      </div>
    );
  };

  // Render mini chart (simplified visualization)
  const renderMiniChart = (address) => {
    if (!trackerRef.current) return null;
    
    const trendData = trackerRef.current.getPriceTrend(address, selectedTimeframe);
    if (trendData.length < 2) return <div className="no-chart">No chart data</div>;
    
    // Simple SVG line chart
    const width = 100;
    const height = 30;
    const prices = trendData.map(d => d.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice || 1;
    
    const points = trendData.map((d, i) => {
      const x = (i / (trendData.length - 1)) * width;
      const y = height - ((d.price - minPrice) / priceRange) * height;
      return `${x},${y}`;
    }).join(' ');
    
    return (
      <div className="mini-chart">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <polyline 
            points={points} 
            fill="none" 
            stroke="var(--primary-color)" 
            strokeWidth="2"
          />
        </svg>
      </div>
    );
  };

  if (Object.keys(tokenList).length === 0) {
    return null;
  }

  return (
    <div className="enhanced-price-ticker">
      {/* Header */}
      <div className="ticker-header">
        <div className="ticker-title">
          <span>Enhanced Token Prices</span>
          {enableBlockchainScan && (
            <button 
              className="scan-button"
              onClick={scanForTokens}
              disabled={scanningTokens}
            >
              {scanningTokens ? '🔍 Scanning...' : '🔍 Scan Blockchain'}
            </button>
          )}
        </div>
        
        <div className="ticker-controls">
          <select 
            value={selectedTimeframe} 
            onChange={(e) => setSelectedTimeframe(e.target.value)}
            className="timeframe-selector"
          >
            <option value="1h">1 Hour</option>
            <option value="24h">24 Hours</option>
            <option value="7d">7 Days</option>
            <option value="30d">30 Days</option>
          </select>
          
          <span className="last-update">
            Last updated: {formatTime(lastUpdate)}
          </span>
          
          <button 
            className="refresh-button"
            onClick={refreshPrices}
            disabled={loading}
            title="Refresh All Prices"
          >
            {loading ? '⟳' : '↻'}
          </button>
        </div>
      </div>

      {/* Token List */}
      <div className="ticker-items">
        {Object.entries(tokenList).map(([address, token]) => {
          const data = priceData[address];
          const error = errors[address];
          
          return (
            <div 
              key={address} 
              className={`ticker-item ${error ? 'has-error' : ''} ${showChart[address] ? 'expanded' : ''}`}
            >
              {/* Basic Price Info */}
              <div className="price-info">
                <div className="token-symbol">{token.symbol || 'UNKNOWN'}</div>
                
                {data ? (
                  <>
                    <div className="token-price">
                      ${data.price?.toFixed(6) || '0.000000'}
                    </div>
                    
                    {renderTrendIndicator(data.changes)}
                    
                    {showAdvancedMetrics && (
                      <div className="advanced-metrics">
                        <div className="metric">
                          <span className="metric-label">Vol 24h:</span>
                          <span className="metric-value">${formatNumber(data.volume24h)}</span>
                        </div>
                        <div className="metric">
                          <span className="metric-label">Market Cap:</span>
                          <span className="metric-value">${formatNumber(data.marketCap)}</span>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="no-price-data">
                    {error || 'Loading...'}
                  </div>
                )}
                
                <div className="token-source" title={data?.source || error}>
                  {error ? 'Error' : data?.source || 'Unknown'}
                </div>
              </div>

              {/* Chart Toggle */}
              {data && (
                <button 
                  className="chart-toggle"
                  onClick={() => toggleChart(address)}
                  title="Toggle Chart"
                >
                  📊
                </button>
              )}

              {/* Expandable Chart */}
              {showChart[address] && data && (
                <div className="chart-section">
                  <div className="chart-header">
                    <span>Price History ({selectedTimeframe})</span>
                  </div>
                  {renderMiniChart(address)}
                  
                  {/* All timeframe changes */}
                  <div className="timeframe-changes">
                    {Object.entries(data.changes).map(([period, change]) => (
                      <div key={period} className="timeframe-change">
                        <span className="period">{period}:</span>
                        <span className={`change ${change.changePercent > 0 ? 'positive' : change.changePercent < 0 ? 'negative' : 'neutral'}`}>
                          {change.changePercent > 0 ? '+' : ''}{change.changePercent.toFixed(2)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Discovered Tokens Section */}
      {discoveredTokens.length > 0 && (
        <div className="discovered-tokens">
          <h4>Recently Discovered Tokens ({discoveredTokens.length})</h4>
          <div className="discovered-list">
            {discoveredTokens.slice(0, 5).map(token => (
              <div key={token.address} className="discovered-token">
                <span className="token-symbol">{token.symbol}</span>
                <span className="token-name">{token.name}</span>
                <span className="token-address" title={token.address}>
                  {token.address.slice(0, 6)}...{token.address.slice(-4)}
                </span>
              </div>
            ))}
            {discoveredTokens.length > 5 && (
              <div className="more-tokens">+{discoveredTokens.length - 5} more</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedPriceTicker;