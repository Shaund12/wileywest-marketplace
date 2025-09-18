// Enhanced Price Ticker with Blockchain Scanning and History
import { ethers } from 'ethers';
import { debugLog, debugWarn, criticalError } from './debugUtils';
import { fetchTokenPriceInUSDC, USDC_POL_ADDRESS, WVTRU_ADDRESS } from './tokenUtils';

// Price history storage in localStorage
const PRICE_HISTORY_KEY = 'wileywest_price_history';
const VOLUME_HISTORY_KEY = 'wileywest_volume_history';
const MARKET_STATS_KEY = 'wileywest_market_stats';

// Time periods for tracking
const TIME_PERIODS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

// Enhanced price data structure
export class EnhancedPriceTracker {
  constructor(provider) {
    this.provider = provider;
    this.priceHistory = this.loadPriceHistory();
    this.volumeHistory = this.loadVolumeHistory();
    this.marketStats = this.loadMarketStats();
    this.subscribers = new Set();
    this.lastUpdate = null;
    this.updateInterval = null;
    
    // Blockchain scanning for token discovery
    this.discoveredTokens = new Map();
    this.scanInProgress = false;
  }

  // Load stored price history
  loadPriceHistory() {
    try {
      const stored = localStorage.getItem(PRICE_HISTORY_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      debugWarn('Failed to load price history:', error);
      return {};
    }
  }

  // Load stored volume history
  loadVolumeHistory() {
    try {
      const stored = localStorage.getItem(VOLUME_HISTORY_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      debugWarn('Failed to load volume history:', error);
      return {};
    }
  }

  // Load stored market stats
  loadMarketStats() {
    try {
      const stored = localStorage.getItem(MARKET_STATS_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      debugWarn('Failed to load market stats:', error);
      return {};
    }
  }

  // Save price history to localStorage
  savePriceHistory() {
    try {
      localStorage.setItem(PRICE_HISTORY_KEY, JSON.stringify(this.priceHistory));
    } catch (error) {
      debugWarn('Failed to save price history:', error);
    }
  }

  // Save volume history to localStorage
  saveVolumeHistory() {
    try {
      localStorage.setItem(VOLUME_HISTORY_KEY, JSON.stringify(this.volumeHistory));
    } catch (error) {
      debugWarn('Failed to save volume history:', error);
    }
  }

  // Save market stats to localStorage
  saveMarketStats() {
    try {
      localStorage.setItem(MARKET_STATS_KEY, JSON.stringify(this.marketStats));
    } catch (error) {
      debugWarn('Failed to save market stats:', error);
    }
  }

  // Add price data point to history
  addPriceDataPoint(tokenAddress, price, volume = 0, marketCap = 0) {
    const now = Date.now();
    const normalizedAddress = tokenAddress.toLowerCase();
    
    if (!this.priceHistory[normalizedAddress]) {
      this.priceHistory[normalizedAddress] = [];
    }
    
    // Add new data point
    this.priceHistory[normalizedAddress].push({
      timestamp: now,
      price,
      volume,
      marketCap
    });
    
    // Clean old data (keep only last 30 days)
    const cutoff = now - TIME_PERIODS['30d'];
    this.priceHistory[normalizedAddress] = this.priceHistory[normalizedAddress]
      .filter(point => point.timestamp > cutoff);
    
    this.savePriceHistory();
  }

  // Calculate price change for a given time period
  calculatePriceChange(tokenAddress, timePeriod = '24h') {
    const normalizedAddress = tokenAddress.toLowerCase();
    const history = this.priceHistory[normalizedAddress];
    
    if (!history || history.length < 2) {
      return { change: 0, changePercent: 0 };
    }
    
    const now = Date.now();
    const periodMs = TIME_PERIODS[timePeriod];
    const cutoffTime = now - periodMs;
    
    // Get current price (most recent)
    const currentPrice = history[history.length - 1].price;
    
    // Find price closest to the cutoff time
    let basePrice = currentPrice;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].timestamp <= cutoffTime) {
        basePrice = history[i].price;
        break;
      }
    }
    
    const change = currentPrice - basePrice;
    const changePercent = basePrice > 0 ? (change / basePrice) * 100 : 0;
    
    return { change, changePercent };
  }

  // Get price trend data for charting
  getPriceTrend(tokenAddress, timePeriod = '24h') {
    const normalizedAddress = tokenAddress.toLowerCase();
    const history = this.priceHistory[normalizedAddress];
    
    if (!history || history.length === 0) {
      return [];
    }
    
    const now = Date.now();
    const periodMs = TIME_PERIODS[timePeriod];
    const cutoffTime = now - periodMs;
    
    return history
      .filter(point => point.timestamp > cutoffTime)
      .map(point => ({
        timestamp: point.timestamp,
        price: point.price,
        volume: point.volume || 0
      }));
  }

  // Enhanced price fetching with historical tracking
  async fetchEnhancedPrice(tokenAddress, tokenData) {
    try {
      // Get current price using existing utility
      const currentPrice = await fetchTokenPriceInUSDC(tokenAddress, this.provider);
      
      // Simulate volume and market cap data (in a real implementation, 
      // these would come from blockchain scanning or external APIs)
      const volume24h = await this.estimateVolume24h(tokenAddress);
      const marketCap = await this.estimateMarketCap(tokenAddress, currentPrice);
      
      // Add to history
      this.addPriceDataPoint(tokenAddress, currentPrice, volume24h, marketCap);
      
      // Calculate changes for different time periods
      const changes = {};
      for (const period of Object.keys(TIME_PERIODS)) {
        changes[period] = this.calculatePriceChange(tokenAddress, period);
      }
      
      return {
        price: currentPrice,
        volume24h,
        marketCap,
        changes,
        lastUpdate: Date.now(),
        symbol: tokenData?.symbol || 'UNKNOWN',
        source: this.getSourceDescription(tokenAddress)
      };
    } catch (error) {
      criticalError(`Enhanced price fetch failed for ${tokenAddress}:`, error);
      throw error;
    }
  }

  // Estimate 24h volume (simplified - in real implementation would scan blockchain)
  async estimateVolume24h(tokenAddress) {
    // This is a simplified estimation - in a real implementation,
    // we would scan Uniswap pool events for actual volume
    try {
      // For now, return a random volume for demo purposes
      // In production, this would scan Transfer events on Uniswap pools
      return Math.random() * 100000;
    } catch (error) {
      debugWarn(`Volume estimation failed for ${tokenAddress}:`, error);
      return 0;
    }
  }

  // Estimate market cap (simplified)
  async estimateMarketCap(tokenAddress, price) {
    try {
      // For ERC20 tokens, we would get total supply and multiply by price
      // This is simplified for demo purposes
      if (tokenAddress === USDC_POL_ADDRESS) {
        return price * 1000000000; // Assume 1B USDC supply
      }
      if (tokenAddress === WVTRU_ADDRESS) {
        return price * 500000000; // Assume 500M WVTRU supply
      }
      
      // For other tokens, return estimated market cap
      return price * (Math.random() * 1000000000);
    } catch (error) {
      debugWarn(`Market cap estimation failed for ${tokenAddress}:`, error);
      return 0;
    }
  }

  // Get source description for price data
  getSourceDescription(tokenAddress) {
    const normalizedAddress = tokenAddress.toLowerCase();
    
    if (normalizedAddress === USDC_POL_ADDRESS.toLowerCase()) {
      return 'USD Stablecoin';
    }
    if (normalizedAddress === WVTRU_ADDRESS.toLowerCase()) {
      return 'Uniswap V3 (WVTRU/USDC)';
    }
    if (normalizedAddress === ethers.ZeroAddress.toLowerCase()) {
      return 'Uniswap V3 (WVTRU proxy)';
    }
    
    return 'Uniswap V3 Pool';
  }

  // Blockchain scanning for token discovery
  async scanForTokens(startBlock = 'latest', maxBlocks = 1000) {
    if (this.scanInProgress) {
      debugLog('Token scan already in progress');
      return this.discoveredTokens;
    }
    
    this.scanInProgress = true;
    
    try {
      debugLog('Starting blockchain token discovery scan...');
      
      // Get current block
      const currentBlock = await this.provider.getBlockNumber();
      const fromBlock = startBlock === 'latest' ? 
        Math.max(0, currentBlock - maxBlocks) : startBlock;
      
      // Look for Transfer events which indicate token activity
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      
      const filter = {
        topics: [transferTopic],
        fromBlock: fromBlock,
        toBlock: currentBlock
      };
      
      debugLog(`Scanning blocks ${fromBlock} to ${currentBlock} for token activity...`);
      
      const logs = await this.provider.getLogs(filter);
      debugLog(`Found ${logs.length} Transfer events`);
      
      // Extract unique contract addresses
      const contractAddresses = new Set();
      logs.forEach(log => {
        contractAddresses.add(log.address);
      });
      
      debugLog(`Discovered ${contractAddresses.size} unique token contracts`);
      
      // For each discovered contract, try to get token info
      for (const address of contractAddresses) {
        if (!this.discoveredTokens.has(address)) {
          try {
            const tokenInfo = await this.getTokenInfo(address);
            if (tokenInfo) {
              this.discoveredTokens.set(address, tokenInfo);
              debugLog(`Added token: ${tokenInfo.symbol} (${address})`);
            }
          } catch (error) {
            debugWarn(`Failed to get token info for ${address}:`, error);
          }
        }
      }
      
      debugLog(`Token discovery complete. Total discovered: ${this.discoveredTokens.size}`);
      
    } catch (error) {
      criticalError('Token discovery scan failed:', error);
    } finally {
      this.scanInProgress = false;
    }
    
    return this.discoveredTokens;
  }

  // Get token information from contract
  async getTokenInfo(contractAddress) {
    try {
      // Try ERC20 interface first
      const erc20Contract = new ethers.Contract(contractAddress, [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)'
      ], this.provider);
      
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        erc20Contract.name().catch(() => ''),
        erc20Contract.symbol().catch(() => ''),
        erc20Contract.decimals().catch(() => 18),
        erc20Contract.totalSupply().catch(() => 0)
      ]);
      
      if (symbol) {
        return {
          address: contractAddress,
          name: name || symbol,
          symbol,
          decimals: Number(decimals),
          totalSupply: totalSupply.toString(),
          type: 'ERC20',
          discovered: Date.now()
        };
      }
    } catch (error) {
      debugWarn(`Token info extraction failed for ${contractAddress}:`, error);
    }
    
    return null;
  }

  // Get all discovered tokens
  getDiscoveredTokens() {
    return Array.from(this.discoveredTokens.values());
  }

  // Subscribe to price updates
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  // Notify all subscribers
  notifySubscribers(data) {
    this.subscribers.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        debugWarn('Subscriber notification failed:', error);
      }
    });
  }

  // Start automatic price updates
  startAutoUpdate(intervalMs = 30000) {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    this.updateInterval = setInterval(() => {
      this.updateAllPrices();
    }, intervalMs);
  }

  // Stop automatic price updates
  stopAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  // Update all tracked token prices
  async updateAllPrices() {
    // This would be implemented to update all tracked tokens
    // For now, just notify subscribers that an update occurred
    this.notifySubscribers({
      type: 'update',
      timestamp: Date.now()
    });
  }

  // Clean up resources
  destroy() {
    this.stopAutoUpdate();
    this.subscribers.clear();
  }
}

// Export singleton instance
let enhancedPriceTracker = null;

export function getEnhancedPriceTracker(provider) {
  if (!enhancedPriceTracker && provider) {
    enhancedPriceTracker = new EnhancedPriceTracker(provider);
  }
  return enhancedPriceTracker;
}

export default EnhancedPriceTracker;