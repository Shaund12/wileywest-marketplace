// utils/tokenUtils.js
import { ethers } from 'ethers';
import { debugLog, debugWarn, criticalError } from './debugUtils';
import { activeChain } from '../config/chains.js';

/* ================================
   Minimal ABIs
=================================== */
export const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function decimals() view returns (uint8)',
];

const UNISWAP_V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

const UNISWAP_V3_POOL_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)',
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

/* ================================
   Known tokens / addresses (Vitruveo)
=================================== */
// USDC on Vitruveo (USDC.pol)
export const USDC_POL_ADDRESS = '0xbCfB3FCa16b12C7756CD6C24f1cC0AC0E38569CF';
// Wrapped VTRU (for pricing native VTRU)
export const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9';

// (Legacy Vitruveo ERC20s — VUSD/SEVO/wSEVO/VITEX/VTRO — died in the chain
// redo and were removed. The marketplace is native-token only now.)

/* ================================
   Uniswap V3 on Vitruveo
=================================== */
export const UNISWAP_V3_FACTORY_ADDRESS = '0x6196a7a6108B15a2cc24DdaB41C8CC3098C06351';
const FEE_TIERS = [500, 3000, 10000];

/* ================================
   Caches
=================================== */
const tokenDetailsCache = {}; // { [lowerAddr]: { symbol, decimals } }
const priceCache = {};        // { [lowerAddr]: { price, timestamp } }
const PRICE_CACHE_DURATION = 30_000; // 30s

/* ================================
   Helpers
=================================== */
const isHexAddress = (val) => typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val);

const isUSDCishAddress = (addr) =>
    !!addr && isHexAddress(addr) && addr.toLowerCase() === USDC_POL_ADDRESS.toLowerCase();

const isUSDCishSymbol = (sym) =>
    /^(USDC(\.[a-z]+)?|USDC\.POL|USD[CT]?(\.[a-z]+)?)$/i.test(sym || '');

/* ================================
   Token metadata
=================================== */
export async function fetchTokenDetails(tokenAddress, provider) {
    // Native token (zero address or falsy)
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress || !isHexAddress(tokenAddress)) {
        return { symbol: activeChain().symbol, decimals: 18 };
    }

    const addr = tokenAddress.toLowerCase();
    if (tokenDetailsCache[addr]) return tokenDetailsCache[addr];

    try {
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const [symbol, decimals] = await Promise.all([
            contract.symbol().catch(() => 'TOKEN'),
            contract.decimals().catch(() => 6),
        ]);
        const out = { symbol, decimals: Number(decimals) };
        tokenDetailsCache[addr] = out;
        return out;
    } catch (e) {
        criticalError(`Error fetching token details for ${tokenAddress}:`, e);
        return { symbol: 'TOKEN', decimals: 6 };
    }
}

export function getTokenSymbol(tokenAddress) {
    // native → the active chain's symbol (VTRU on Vitruveo, HYVE on Hyve)
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress) return activeChain().symbol;

    // If not an address, assume it's a symbol
    if (!isHexAddress(tokenAddress)) return tokenAddress;

    const addr = tokenAddress.toLowerCase();
    if (addr === ethers.ZeroAddress.toLowerCase()) return activeChain().symbol;
    if (addr === USDC_POL_ADDRESS.toLowerCase()) return 'USDC.pol';
    if (addr === WVTRU_ADDRESS.toLowerCase()) return 'WVTRU';

    if (tokenDetailsCache[addr]?.symbol) return tokenDetailsCache[addr].symbol;
    return 'TOKEN';
}

export function getTokenDecimals(tokenAddress) {
    // native
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress) return 18;

    if (isHexAddress(tokenAddress)) {
        const addr = tokenAddress.toLowerCase();
        if (addr === ethers.ZeroAddress.toLowerCase()) return 18;
        if (addr === USDC_POL_ADDRESS.toLowerCase()) return 6;
        if (addr === WVTRU_ADDRESS.toLowerCase()) return 18;
        if (tokenDetailsCache[addr]?.decimals !== undefined) {
            return tokenDetailsCache[addr].decimals;
        }
        // Unknown ERC20 default
        return 6;
    }

    // Symbol path
    const sym = String(tokenAddress).toUpperCase();
    if (sym === 'USDC' || sym === 'USDC.POL') return 6;
    if (sym === 'WBTC') return 8;
    return 18;
}

/* ================================
   Amount formatting / parsing
=================================== */
export function formatTokenAmount(amount, tokenAddress) {
    try {
        // Handle null/undefined/invalid amounts
        if (!amount || amount === 'null' || amount === 'undefined') {
            return '0';
        }
        
        const amountStr = String(amount);
        if (amountStr === '0' || amountStr === '') {
            return '0';
        }
        
        const decimals = getTokenDecimals(tokenAddress);

        let formatted;
        try {
            if (ethers.formatUnits) {
                formatted = ethers.formatUnits(amountStr, decimals);
            } else {
                const divisor = BigInt(10) ** BigInt(decimals);
                const amt = BigInt(amountStr);
                const whole = amt / divisor;
                const frac = amt % divisor;
                const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
                formatted = fracStr.length ? `${whole}.${fracStr}` : whole.toString();
            }
        } catch (convErr) {
            debugWarn(`formatTokenAmount conversion error for ${amountStr}`, convErr);
            const num = parseFloat(amountStr);
            if (!isFinite(num)) return '0';
            const divisor = Math.pow(10, decimals);
            formatted = (num / divisor).toString();
        }

        const value = parseFloat(formatted);
        if (!isFinite(value) || value === 0) return '0';

        if (decimals === 6 || isUSDCishAddress(tokenAddress) || isUSDCishSymbol(tokenAddress)) {
            return value.toFixed(Math.min(2, countDecimals(value)));
        } else {
            if (value >= 1000) return value.toFixed(2);
            if (value >= 1) return value.toFixed(Math.min(4, countDecimals(value)));
            return value.toFixed(Math.min(6, Math.max(2, countDecimals(value))));
        }
    } catch (e) {
        criticalError(`Error formatting amount ${amount} for ${tokenAddress}:`, e);
        try {
            const decimals = getTokenDecimals(tokenAddress);
            const num = parseFloat(String(amount || '0'));
            if (!isFinite(num)) return '0';
            const divisor = Math.pow(10, decimals);
            const out = (num / divisor);
            return out.toFixed(decimals === 6 ? 2 : 4);
        } catch {
            return '0';
        }
    }
}

function countDecimals(value) {
    if (Math.floor(value) === value) return 0;
    const s = value.toString();
    return s.includes('.') ? s.split('.')[1].length : 0;
}

export function parseTokenAmount(amount, tokenAddress) {
    try {
        // Handle null/undefined/invalid amounts
        if (!amount || amount === 'null' || amount === 'undefined' || isNaN(parseFloat(String(amount)))) {
            return '0';
        }
        
        const amountStr = String(amount);
        const decimals = getTokenDecimals(tokenAddress);
        
        if (ethers.parseUnits) {
            return ethers.parseUnits(amountStr, decimals).toString();
        } else {
            const mul = 10 ** decimals;
            return Math.floor(Number(amountStr) * mul).toString();
        }
    } catch (e) {
        criticalError(`Error parsing amount ${amount} for ${tokenAddress}:`, e);
        return '0';
    }
}

/* ================================
   Uniswap helpers
=================================== */
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
            } catch {
                // ignore per-tier errors
            }
        }
        return { poolAddress: null, fee: null };
    } catch (error) {
        criticalError('Error getting pool address', error);
        return { poolAddress: null, fee: null };
    }
}

/* ================================
   Pricing in USD
   The old Uniswap WVTRU/USDC pool died when Vitruveo was redone, so
   pricing now comes from the live DexScreener market feed:
     • VTRU (Vitruveo native / WVTRU) → live price from the BSC pair
     • HYVE (Hyve native)            → provisional launch rate from the
                                        chain registry (not listed yet)
   Signature is unchanged (provider arg kept but unused) so no callers
   need editing.
=================================== */
async function fetchLiveVtruUsd() {
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=VTRU');
    const data = await res.json();
    const pair = (data.pairs || []).find(p => p.chainId === 'bsc' && p.priceUsd);
    if (!pair) throw new Error('No live VTRU pair found on DexScreener');
    return Number(pair.priceUsd);
}

export async function fetchTokenPriceInUSDC(tokenAddress, _provider) {
    const now = Date.now();

    if (!tokenAddress || tokenAddress === 'undefined' || tokenAddress === 'null') {
        throw new Error(`No price source for token ${tokenAddress}`);
    }

    const normalized = String(tokenAddress).toLowerCase();

    if (priceCache[normalized] && (now - priceCache[normalized].timestamp) < PRICE_CACHE_DURATION) {
        return priceCache[normalized].price;
    }

    try {
        // USDC == $1 (by address)
        if (isUSDCishAddress(tokenAddress)) {
            const price = 1.0;
            priceCache[normalized] = { price, timestamp: now };
            return price;
        }

        const isNative = normalized === ethers.ZeroAddress.toLowerCase();
        const isWvtru = normalized === WVTRU_ADDRESS.toLowerCase();
        if (!isNative && !isWvtru) {
            throw new Error(`No price source for token ${tokenAddress}`);
        }

        const chain = activeChain();
        let priceInUSDC;
        if (isWvtru || chain.key === 'vitruveo') {
            // VTRU: live market price, registry rate as fallback
            try {
                priceInUSDC = await fetchLiveVtruUsd();
            } catch {
                priceInUSDC = chain.key === 'vitruveo' ? chain.usdRate : 0.0036;
            }
        } else {
            // HYVE (or any chain without a live listing): provisional rate
            priceInUSDC = chain.usdRate;
        }

        priceCache[normalized] = { price: priceInUSDC, timestamp: now };
        return priceInUSDC;
    } catch (error) {
        criticalError(`Error fetching price for ${tokenAddress}:`, error);
        throw error;
    }
}

export async function convertToUSDCValue(tokenAmount, tokenAddress, provider) {
    try {
        if (!tokenAmount || tokenAmount === '0') return 0;

        // Always read decimals/symbol via on-chain metadata first
        const meta = await fetchTokenDetails(tokenAddress, provider);
        const decimals = Number(meta.decimals ?? getTokenDecimals(tokenAddress));

        const amountNum = ethers.formatUnits
            ? Number(ethers.formatUnits(tokenAmount.toString(), decimals))
            : Number(tokenAmount.toString()) / Math.pow(10, decimals);

        // USDC: 1:1
        if (isUSDCishAddress(tokenAddress) || isUSDCishSymbol(meta.symbol)) {
            return amountNum;
        }

        // Otherwise quote via Uniswap pool
        const price = await fetchTokenPriceInUSDC(tokenAddress, provider);
        return amountNum * price;
    } catch (error) {
        criticalError(`Error converting ${tokenAmount} ${tokenAddress} to USDC:`, error);
        return 0;
    }
}

export async function formatPriceWithUSDC(tokenAmount, tokenAddress, provider, showBothPrices = true) {
    try {
        const tokenDetails = await fetchTokenDetails(tokenAddress, provider);
        const tokenAmountFormatted = formatTokenAmount(tokenAmount, tokenAddress);

        // numeric token amount with proper decimals (for USDC 1:1)
        const tokenAmountNum = ethers.formatUnits
            ? Number(ethers.formatUnits(tokenAmount?.toString?.() || '0', tokenDetails.decimals))
            : Number(tokenAmount?.toString?.() || '0') / Math.pow(10, tokenDetails.decimals);

        let usdcValue = 0;
        let hasUSDCRate = true;

        try {
            if (isUSDCishAddress(tokenAddress) || isUSDCishSymbol(tokenDetails.symbol)) {
                usdcValue = tokenAmountNum; // 1:1
            } else {
                usdcValue = await convertToUSDCValue(tokenAmount, tokenAddress, provider);
            }
        } catch (e) {
            debugWarn(`No USDC rate for ${tokenAddress}:`, e);
            usdcValue = 0;
            hasUSDCRate = false;
        }

        // Better USD formatting: small values keep precision
        const usdcValueFormatted = usdcValue < 0.01 ? usdcValue.toFixed(6) : usdcValue.toFixed(2);

        let formatted;
        if (!hasUSDCRate) {
            formatted = `${tokenAmountFormatted} ${tokenDetails.symbol} (no USDC rate available)`;
        } else if (isUSDCishAddress(tokenAddress) || isUSDCishSymbol(tokenDetails.symbol)) {
            // For USDC, show just the USD value (with small-value precision)
            formatted = `$${usdcValueFormatted}`;
        } else if (showBothPrices) {
            formatted = `${tokenAmountFormatted} ${tokenDetails.symbol} ($${usdcValueFormatted})`;
        } else {
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
        criticalError('Error formatting price with USDC:', error);
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

/* ================================
   Optional default export
=================================== */
const TokenUtils = {
    ERC20_ABI,
    USDC_POL_ADDRESS,
    WVTRU_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    fetchTokenDetails,
    getTokenSymbol,
    getTokenDecimals,
    formatTokenAmount,
    parseTokenAmount,
    fetchTokenPriceInUSDC,
    convertToUSDCValue,
    formatPriceWithUSDC,
};
export default TokenUtils;
