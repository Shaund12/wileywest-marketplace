/**
 * Price Service for fetching real-time token prices
 * Supports Uniswap v3, CoinGecko API, and fallback mechanisms
 */

import { ethers } from 'ethers';

// Uniswap V3 Factory and Pool ABIs (minimal)
const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

const UNISWAP_V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)'
];

const ERC20_ABI = [
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function name() external view returns (string)'
];

// Contract addresses - These may need to be updated for Vitruveo network
const UNISWAP_V3_FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984'; // Ethereum mainnet
const USDC_ADDRESS = '0xA0b86a33E6Fe17d6fBbC9e3928C02C7C1dA31F6d'; // Example USDC on Vitruveo
const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9'; // From SellPage

// Common fee tiers for Uniswap V3
const FEE_TIERS = [3000, 500, 10000]; // 0.3%, 0.05%, 1%

// Cache configuration
const PRICE_CACHE_DURATION = 15000; // 15 seconds
const priceCache = new Map();

/**
 * Calculate price from Uniswap V3 sqrtPriceX96
 */
function calculatePriceFromSqrtPriceX96(sqrtPriceX96, token0Decimals, token1Decimals, isToken0Base = true) {
  try {
    const Q96 = ethers.getBigInt(2) ** ethers.getBigInt(96);
    const price = (ethers.getBigInt(sqrtPriceX96) ** ethers.getBigInt(2)) / Q96;
    
    const decimalDiff = token1Decimals - token0Decimals;
    const adjustedPrice = Number(price) / Math.pow(10, decimalDiff);
    
    return isToken0Base ? adjustedPrice : 1 / adjustedPrice;
  } catch (error) {
    console.error('Error calculating price from sqrtPriceX96:', error);
    return null;
  }
}

/**
 * Get token price from Uniswap V3 pool
 */
async function getUniswapV3Price(provider, tokenA, tokenB, tokenADecimals, tokenBDecimals) {
  try {
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);
    
    // Try different fee tiers
    for (const fee of FEE_TIERS) {
      try {
        const poolAddress = await factory.getPool(tokenA, tokenB, fee);
        
        if (poolAddress === ethers.ZeroAddress) {
          continue; // Pool doesn't exist for this fee tier
        }
        
        const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
        const slot0 = await pool.slot0();
        const sqrtPriceX96 = slot0[0];
        
        if (sqrtPriceX96 > 0) {
          const token0 = await pool.token0();
          const isToken0Base = token0.toLowerCase() === tokenA.toLowerCase();
          
          const price = calculatePriceFromSqrtPriceX96(
            sqrtPriceX96,
            tokenADecimals,
            tokenBDecimals,
            isToken0Base
          );
          
          if (price && price > 0) {
            return {
              price,
              source: `Uniswap V3 (${fee / 10000}% fee)`,
              poolAddress,
              lastUpdate: Date.now()
            };
          }
        }
      } catch (poolError) {
        console.warn(`Failed to get price from pool with fee ${fee}:`, poolError.message);
        continue;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching Uniswap V3 price:', error);
    return null;
  }
}

/**
 * Get token price from CoinGecko API (fallback)
 */
async function getCoinGeckoPriceFallback(tokenSymbol) {
  try {
    // Map token symbols to CoinGecko IDs
    const symbolToId = {
      'VTRU': 'vitruveo',
      'WVTRU': 'vitruveo',
      'USDC': 'usd-coin',
      'ETH': 'ethereum',
      'WETH': 'ethereum'
    };
    
    const coinId = symbolToId[tokenSymbol.toUpperCase()];
    if (!coinId) {
      return null;
    }
    
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_last_updated_at=true`,
      {
        headers: {
          'Accept': 'application/json',
        },
        // Add timeout
        signal: AbortSignal.timeout(5000)
      }
    );
    
    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }
    
    const data = await response.json();
    const priceData = data[coinId];
    
    if (priceData && priceData.usd) {
      return {
        price: priceData.usd,
        source: 'CoinGecko API',
        lastUpdate: priceData.last_updated_at * 1000 || Date.now()
      };
    }
    
    return null;
  } catch (error) {
    console.warn('CoinGecko fallback failed:', error.message);
    return null;
  }
}

/**
 * Get cached price if available and not expired
 */
function getCachedPrice(cacheKey) {
  const cached = priceCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < PRICE_CACHE_DURATION) {
    return cached.data;
  }
  return null;
}

/**
 * Cache price data
 */
function setCachedPrice(cacheKey, priceData) {
  priceCache.set(cacheKey, {
    data: priceData,
    timestamp: Date.now()
  });
}

/**
 * Get token information from contract
 */
async function getTokenInfo(provider, tokenAddress) {
  try {
    if (tokenAddress === ethers.ZeroAddress) {
      return {
        symbol: 'VTRU',
        name: 'Native VTRU',
        decimals: 18
      };
    }
    
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, name, decimals] = await Promise.all([
      contract.symbol(),
      contract.name(),
      contract.decimals()
    ]);
    
    return { symbol, name, decimals };
  } catch (error) {
    console.warn(`Failed to get token info for ${tokenAddress}:`, error.message);
    // Return defaults
    return {
      symbol: 'UNKNOWN',
      name: 'Unknown Token',
      decimals: 18
    };
  }
}

/**
 * Main function to get token price in USD
 */
export async function getTokenPriceUSD(provider, tokenAddress, tokenSymbol = null) {
  try {
    const cacheKey = `${tokenAddress}_usd`;
    
    // Check cache first
    const cached = getCachedPrice(cacheKey);
    if (cached) {
      return cached;
    }
    
    // Get token info
    const tokenInfo = await getTokenInfo(provider, tokenAddress);
    const symbol = tokenSymbol || tokenInfo.symbol;
    
    // Special case for stablecoins
    if (['USDC', 'USDT', 'DAI'].includes(symbol.toUpperCase())) {
      const stablecoinPrice = {
        price: 1.0,
        source: 'USD pegged stablecoin',
        lastUpdate: Date.now()
      };
      setCachedPrice(cacheKey, stablecoinPrice);
      return stablecoinPrice;
    }
    
    // Try Uniswap V3 first (against USDC)
    if (tokenAddress !== USDC_ADDRESS && tokenAddress !== ethers.ZeroAddress) {
      try {
        const usdcInfo = await getTokenInfo(provider, USDC_ADDRESS);
        const uniswapPrice = await getUniswapV3Price(
          provider,
          tokenAddress,
          USDC_ADDRESS,
          tokenInfo.decimals,
          usdcInfo.decimals
        );
        
        if (uniswapPrice) {
          setCachedPrice(cacheKey, uniswapPrice);
          return uniswapPrice;
        }
      } catch (error) {
        console.warn('Uniswap V3 price fetch failed:', error.message);
      }
    }
    
    // Fallback to CoinGecko
    const coinGeckoPrice = await getCoinGeckoPriceFallback(symbol);
    if (coinGeckoPrice) {
      setCachedPrice(cacheKey, coinGeckoPrice);
      return coinGeckoPrice;
    }
    
    // Return null if all methods fail
    console.warn(`Unable to fetch price for token ${symbol} (${tokenAddress})`);
    return null;
    
  } catch (error) {
    console.error('Error in getTokenPriceUSD:', error);
    return null;
  }
}

/**
 * Get multiple token prices in batch
 */
export async function getMultipleTokenPrices(provider, tokenAddresses) {
  const prices = {};
  
  // Process in parallel but limit concurrency
  const batchSize = 3;
  for (let i = 0; i < tokenAddresses.length; i += batchSize) {
    const batch = tokenAddresses.slice(i, i + batchSize);
    const batchPromises = batch.map(async (address) => {
      const price = await getTokenPriceUSD(provider, address);
      return { address, price };
    });
    
    const batchResults = await Promise.allSettled(batchPromises);
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const { address, price } = result.value;
        prices[address] = price;
      } else {
        console.error(`Failed to get price for ${batch[index]}:`, result.reason);
        prices[batch[index]] = null;
      }
    });
  }
  
  return prices;
}

/**
 * Default token prices (fallback when all APIs fail)
 */
export const DEFAULT_TOKEN_PRICES = {
  [ethers.ZeroAddress]: {
    price: 25.0,
    source: 'Default estimate',
    lastUpdate: Date.now()
  },
  [WVTRU_ADDRESS]: {
    price: 25.0,
    source: 'Default estimate',
    lastUpdate: Date.now()
  },
  [USDC_ADDRESS]: {
    price: 1.0,
    source: 'USD pegged stablecoin',
    lastUpdate: Date.now()
  }
};

/**
 * Get price with fallback to defaults
 */
export async function getTokenPriceWithFallback(provider, tokenAddress, tokenSymbol = null) {
  const price = await getTokenPriceUSD(provider, tokenAddress, tokenSymbol);
  
  if (price) {
    return price;
  }
  
  // Use default if available
  const defaultPrice = DEFAULT_TOKEN_PRICES[tokenAddress];
  if (defaultPrice) {
    console.warn(`Using default price for ${tokenAddress}: $${defaultPrice.price}`);
    return defaultPrice;
  }
  
  // Last resort - return a generic default
  console.warn(`No price data available for ${tokenAddress}, using generic default`);
  return {
    price: 0.0,
    source: 'No data available',
    lastUpdate: Date.now()
  };
}

/**
 * Clear price cache (useful for testing or forced refresh)
 */
export function clearPriceCache() {
  priceCache.clear();
}

/**
 * Get cache statistics
 */
export function getPriceCacheStats() {
  return {
    size: priceCache.size,
    keys: Array.from(priceCache.keys()),
    cacheAges: Array.from(priceCache.entries()).map(([key, value]) => ({
      key,
      age: Date.now() - value.timestamp
    }))
  };
}