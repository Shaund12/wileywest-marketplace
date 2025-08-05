    import { ethers } from 'ethers';

    // Minimal ERC20 ABI with just the functions we need
    const ERC20_ABI = [
      'function symbol() view returns (string)',
      'function name() view returns (string)',
      'function decimals() view returns (uint8)',
    ];

    // Cache for token details to avoid repeated RPC calls
    const tokenDetailsCache = {};

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
    
        // Check cache first
        if (tokenDetailsCache[addressLower]?.decimals !== undefined) {
          return tokenDetailsCache[addressLower].decimals;
        }
    
        return 6; // Default to 6 for unknown token addresses
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

            // Format units - handle both ethers v5 and v6 API
            let formatted;
            if (ethers.utils?.formatUnits) {
                // ethers v5
                formatted = ethers.utils.formatUnits(amount.toString(), decimals);
            } else if (ethers.formatUnits) {
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
            if (ethers.utils?.parseUnits) {
                return ethers.utils.parseUnits(amount.toString(), decimals).toString();
            } else if (ethers.parseUnits) {
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