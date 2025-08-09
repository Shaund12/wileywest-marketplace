import { ethers } from 'ethers';

// Minimal ERC20 ABI with just the functions we need
const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function decimals() view returns (uint8)',
];

// Uniswap V3 interfaces for price fetching
const UNISWAP_V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

const UNISWAP_V3_POOL_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)',
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

// Token addresses - Updated to use USDC.pol
export const USDC_POL_ADDRESS = '0xbCfB3FCa16b12C7756CD6C24f1cC0AC0E38569CF';
export const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9';

// Uniswap V3 contract addresses
export const UNISWAP_V3_FACTORY_ADDRESS = '0x6196a7a6108B15a2cc24DdaB41C8CC3098C06351';

// Fee tiers: 0.05%, 0.3%, and 1%
const FEE_TIERS = [500, 3000, 10000];

// Cache for token details to avoid repeated RPC calls
const tokenDetailsCache = {};

// Cache for price data to avoid repeated Uniswap calls
const priceCache = {};
const PRICE_CACHE_DURATION = 30000; // 30 seconds

/**
 * Fetch token details from blockchain
 * @param {string} tokenAddress - Token contract address
 * @param {ethers.providers.Provider} provider - Ethers provider
 * @returns {Promise<{symbol: string, decimals: number}>} Token details
 */
export async function fetchTokenDetails(tokenAddress, provider) {
    if (!tokenAddress || !tokenAddress.startsWith('0x')) {
        return { symbol: tokenAddress || 'VTRU', decimals: 18 };
    }

    const addressLower = tokenAddress.toLowerCase();

    // Return from cache if available
    if (tokenDetailsCache[addressLower]) {
        return tokenDetailsCache[addressLower];
    }

    try {
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

        // Fetch both symbol and decimals in parallel
        const [symbol, decimals] = await Promise.all([
            contract.symbol().catch(() => 'TOKEN'),
            contract.decimals().catch(() => 6), // Default to 6 if decimals() fails
        ]);

        const result = { symbol, decimals: Number(decimals) };

        // Cache the result
        tokenDetailsCache[addressLower] = result;

        return result;
    } catch (error) {
        console.error(`Error fetching token details for ${tokenAddress}:`, error);
        return { symbol: 'TOKEN', decimals: 6 };
    }
}

/**
 * Get token symbol (synchronous version using cache or fallbacks)
 * @param {string} tokenAddress - Token address
 * @returns {string} Token symbol
 */
export function getTokenSymbol(tokenAddress) {
    if (!tokenAddress) return 'VTRU';

    if (!tokenAddress.startsWith('0x')) return tokenAddress;

    const addressLower = tokenAddress.toLowerCase();

    // Check for specific known addresses
    if (addressLower === USDC_POL_ADDRESS.toLowerCase()) {
        return 'USDC.pol';
    }
    if (addressLower === WVTRU_ADDRESS.toLowerCase()) {
        return 'WVTRU';
    }

    // Check cache first
    if (tokenDetailsCache[addressLower]?.symbol) {
        return tokenDetailsCache[addressLower].symbol;
    }

    // Otherwise return temporary value
    return 'TOKEN'; // Will be updated once fetchTokenDetails completes
}

/**
 * Get token decimals (synchronous version using cache or fallbacks)
 * @param {string} tokenAddress - Token address or symbol
 * @returns {number} Number of decimals
 */
export function getTokenDecimals(tokenAddress) {
    if (!tokenAddress) return 18;

    // Handle addresses
    if (tokenAddress.startsWith('0x')) {
        const addressLower = tokenAddress.toLowerCase();

        // Check for specific known addresses
        if (addressLower === USDC_POL_ADDRESS.toLowerCase()) {
            return 6;
        }
        if (addressLower === WVTRU_ADDRESS.toLowerCase()) {
            return 18;
        }

        // Check cache first
        if (tokenDetailsCache[addressLower]?.decimals !== undefined) {
            return tokenDetailsCache[addressLower].decimals;
        }

        return 6; // Default to 6 for unknown token addresses (USDC-like)
    }

    // Handle symbols
    const tokenSymbolUpper = tokenAddress.toUpperCase();

    switch (tokenSymbolUpper) {
        case 'USDC':
        case 'USDC.POL':
            return 6;
        case 'WBTC':
            return 8;
        default:
            return 18;
    }
}

/**
 * Format token amount with appropriate decimals
 * @param {string|number} amount - Raw amount in base units
 * @param {string} tokenAddress - Token address or symbol
 * @returns {string} Formatted amount
 */
export function formatTokenAmount(amount, tokenAddress) {
    try {
        // Handle undefined, null or empty values
        if (!amount) return '0';

        // Get decimals based on token type
        const decimals = getTokenDecimals(tokenAddress);

        // Format units - handle ethers v6 API
        let formatted;
        if (ethers.formatUnits) {
            // ethers v6
            formatted = ethers.formatUnits(amount.toString(), decimals);
        } else {
            // Manual fallback
            const divisor = 10 ** decimals;
            formatted = (Number(amount) / divisor).toString();
        }

        // Parse as float and format with fixed decimals
        const value = parseFloat(formatted);

        if (value === 0) return '0';

        // Format with different precision based on token type
        if (decimals === 6) {
            // For USDC, show at most 2 decimal places
            return value.toFixed(Math.min(2, countDecimals(value)));
        } else {
            // For other tokens, show at most 4 decimal places
            return value.toFixed(Math.min(4, countDecimals(value)));
        }
    } catch (error) {
        console.error(`Error formatting amount ${amount} for token ${tokenAddress}:`, error);
        // Simplified fallback for currency addresses
        if (tokenAddress && tokenAddress.startsWith('0x')) {
            // If tokenSymbol is an address, assume 6 decimals (for USDC-like tokens)
            return (Number(amount) / 1000000).toFixed(2);
        }
        return '0'; // Ultimate fallback
    }
}

/**
 * Count actual decimal places in a number
 */
function countDecimals(value) {
    if (Math.floor(value) === value) return 0;
    return value.toString().split(".")[1].length || 0;
}

/**
 * Parse human-readable amount to token base units
 * @param {string|number} amount - Human-readable amount
 * @param {string} tokenAddress - Token address or symbol
 * @returns {string} Amount in base units
 */
export function parseTokenAmount(amount, tokenAddress) {
    try {
        // Handle empty or invalid inputs
        if (!amount || isNaN(parseFloat(amount))) return '0';

        const decimals = getTokenDecimals(tokenAddress);

        // Handle both ethers v5 and v6 API
        if (ethers.parseUnits) {
            // ethers v6
            return ethers.parseUnits(amount.toString(), decimals).toString();
        } else {
            // Manual fallback
            const multiplier = 10 ** decimals;
            return Math.floor(Number(amount) * multiplier).toString();
        }
    } catch (error) {
        console.error(`Error parsing amount ${amount} for token ${tokenAddress}:`, error);
        return '0'; // Fallback value
    }
}

/**
 * Get Uniswap V3 pool address for token pair
 * @param {string} tokenA - First token address
 * @param {string} tokenB - Second token address
 * @param {ethers.providers.Provider} provider - Ethers provider
 * @returns {Promise<{poolAddress: string|null, fee: number|null}>} Pool info
 */
async function getUniswapPool(tokenA, tokenB, provider) {
    try {
        const factory = new ethers.Contract(
            UNISWAP_V3_FACTORY_ADDRESS,
            UNISWAP_V3_FACTORY_ABI,
            provider
        );

        for (const fee of FEE_TIERS) {
            try {
                const poolAddress = await factory.getPool(tokenA, tokenB, fee);
                if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                    return { poolAddress, fee };
                }
            } catch (e) {
                console.warn(`No pool for fee ${fee}`, e);
            }
        }

        return { poolAddress: null, fee: null };
    } catch (error) {
        console.error("Error getting pool address", error);
        return { poolAddress: null, fee: null };
    }
}

/**
 * Fetch token price in USDC using direct RPC calls to Uniswap pools - NO FALLBACKS
 * @param {string} tokenAddress - Token address (use ethers.ZeroAddress for native VTRU)
 * @param {ethers.providers.Provider} provider - Ethers provider 
 * @returns {Promise<number>} Price in USDC
 */
export async function fetchTokenPriceInUSDC(tokenAddress, provider) {
    const now = Date.now();

    // Check cache first
    if (priceCache[tokenAddress] && (now - priceCache[tokenAddress].timestamp) < PRICE_CACHE_DURATION) {
        return priceCache[tokenAddress].price;
    }

    try {
        // USDC.pol is always $1
        if (tokenAddress === USDC_POL_ADDRESS) {
            const price = 1.0;
            priceCache[tokenAddress] = { price, timestamp: now };
            return price;
        }

        // For Native VTRU (zero address), use WVTRU pool for price info
        const actualTokenAddress = tokenAddress === ethers.ZeroAddress ? WVTRU_ADDRESS : tokenAddress;

        // Find pool between this token and USDC.pol
        const { poolAddress, fee } = await getUniswapPool(actualTokenAddress, USDC_POL_ADDRESS, provider);

        if (!poolAddress) {
            throw new Error(`No USDC liquidity pool found for token ${tokenAddress}`);
        }

        console.log(`Found pool ${poolAddress} for ${getTokenSymbol(tokenAddress)}/USDC with fee ${fee} bps`);

        // Use direct RPC calls to get pool data
        const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

        // Get all required data in parallel
        const [token0, token1, slotData, tokenDecimalsRaw, usdcDecimalsRaw] = await Promise.all([
            pool.token0(),
            pool.token1(),
            pool.slot0(),
            new ethers.Contract(actualTokenAddress, ERC20_ABI, provider).decimals(),
            new ethers.Contract(USDC_POL_ADDRESS, ERC20_ABI, provider).decimals()
        ]);

        // Extract tick from slot data
        const { tick } = slotData;
        console.log(`Pool tick for ${getTokenSymbol(tokenAddress)}: ${tick}`);

        // Determine token positions and decimals
        const isTokenToken0 = token0.toLowerCase() === actualTokenAddress.toLowerCase();
        const tokenDecimals = Number(tokenDecimalsRaw);
        const usdcDecimals = Number(usdcDecimalsRaw);

        console.log(`Token positions: ${getTokenSymbol(tokenAddress)} is ${isTokenToken0 ? 'token0' : 'token1'}`);
        console.log(`Decimals: ${getTokenSymbol(tokenAddress)}=${tokenDecimals}, USDC=${usdcDecimals}`);

        // Calculate price using tick - this is GUARANTEED to be real-time from the pool
        const tickValue = Number(tick);

        let price;
        if (isTokenToken0) {
            // If our token is token0 and USDC is token1, we invert the tick price
            // This means 1 token0 is worth (1/1.0001^tick) token1
            const rawPrice = 1 / Math.pow(1.0001, tickValue);

            // Apply decimal adjustment
            price = rawPrice * Math.pow(10, usdcDecimals - tokenDecimals);
        } else {
            // If USDC is token0 and our token is token1
            // This means 1 token1 is worth (1.0001^tick) token0
            const rawPrice = Math.pow(1.0001, tickValue);

            // Apply decimal adjustment
            price = rawPrice * Math.pow(10, usdcDecimals - tokenDecimals);
        }

        console.log(`REAL-TIME price for ${getTokenSymbol(tokenAddress)}: $${price}`);

        // Cache the result
        priceCache[tokenAddress] = { price, timestamp: now };
        return price;
    } catch (error) {
        console.error(`Error fetching price for ${tokenAddress}:`, error);
        throw error;
    }
}

/**
 * Convert token amount to USDC value
 * @param {string|BigNumber} tokenAmount - Amount in token's base units  
 * @param {string} tokenAddress - Token address
 * @param {ethers.providers.Provider} provider - Ethers provider
 * @returns {Promise<number>} Value in USDC
 */
export async function convertToUSDCValue(tokenAmount, tokenAddress, provider) {
    try {
        if (!tokenAmount || tokenAmount === '0') return 0;

        // Get token price in USDC
        const priceInUSDC = await fetchTokenPriceInUSDC(tokenAddress, provider);

        // Convert token amount to human-readable format
        const decimals = getTokenDecimals(tokenAddress);
        const humanReadableAmount = ethers.formatUnits ?
            parseFloat(ethers.formatUnits(tokenAmount.toString(), decimals)) :
            parseFloat(tokenAmount.toString()) / Math.pow(10, decimals);

        // Calculate USDC value
        const usdcValue = humanReadableAmount * priceInUSDC;

        return usdcValue;
    } catch (error) {
        console.error(`Error converting ${tokenAmount} ${tokenAddress} to USDC:`, error);
        return 0;
    }
}

/**
 * Format price display with USDC conversion and enhanced error handling
 * @param {string|BigNumber} tokenAmount - Amount in token's base units
 * @param {string} tokenAddress - Token address
 * @param {ethers.providers.Provider} provider - Ethers provider
 * @param {boolean} showBothPrices - Whether to show both token amount and USDC value
 * @returns {Promise<{tokenAmount: string, tokenSymbol: string, usdcValue: string, formatted: string, hasUSDCRate: boolean}>}
 */
export async function formatPriceWithUSDC(tokenAmount, tokenAddress, provider, showBothPrices = true) {
    try {
        const tokenDetails = await fetchTokenDetails(tokenAddress, provider);
        const tokenAmountFormatted = formatTokenAmount(tokenAmount, tokenAddress);

        let usdcValue;
        let hasUSDCRate = true;

        try {
            usdcValue = await convertToUSDCValue(tokenAmount, tokenAddress, provider);
        } catch (error) {
            console.warn(`No USDC rate available for ${tokenAddress}:`, error);
            usdcValue = 0;
            hasUSDCRate = false;
        }

        // Use higher precision for low-value tokens (same logic as SellPage)
        const usdcValueFormatted = usdcValue < 0.01 ? usdcValue.toFixed(6) : usdcValue.toFixed(2);

        let formatted;
        if (!hasUSDCRate) {
            // When no USDC rate is available
            formatted = `${tokenAmountFormatted} ${tokenDetails.symbol} (no USDC rate available)`;
        } else if (tokenAddress === USDC_POL_ADDRESS) {
            // For USDC.pol, just show the USDC amount
            formatted = `$${tokenAmountFormatted}`;
        } else if (showBothPrices) {
            // Show both token amount and USDC value
            formatted = `${tokenAmountFormatted} ${tokenDetails.symbol} ($${usdcValueFormatted})`;
        } else {
            // Show only USDC value
            formatted = `$${usdcValueFormatted}`;
        }

        return {
            tokenAmount: tokenAmountFormatted,
            tokenSymbol: tokenDetails.symbol,
            usdcValue: hasUSDCRate ? usdcValueFormatted : '0.00',
            formatted,
            hasUSDCRate
        };
    } catch (error) {
        console.error(`Error formatting price with USDC:`, error);
        const tokenSymbol = getTokenSymbol(tokenAddress);
        const tokenAmountFormatted = formatTokenAmount(tokenAmount, tokenAddress);
        return {
            tokenAmount: tokenAmountFormatted,
            tokenSymbol,
            usdcValue: '0.00',
            formatted: `${tokenAmountFormatted} ${tokenSymbol} (no USDC rate available)`,
            hasUSDCRate: false
        };
    }
}