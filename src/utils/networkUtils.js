/**
 * Network utilities for CORS-safe requests and improved error handling
 */

import { ethers } from 'ethers';
import { debugLog, debugWarn, criticalError } from './debugUtils';
import { activeChain } from '../config/chains.js';

/**
 * A provider for historical reads (eth_getLogs / queryFilter).
 *
 * Never use the wallet's BrowserProvider for log scans. MetaMask forwards
 * eth_getLogs to whatever RPC the user's network is configured with — for
 * Hyve that is the upstream that regularly returns 504/timeouts — and
 * surfaces the failure as an opaque 'Internal JSON-RPC error' (-32603) with
 * no retry. A wide scan through the wallet is therefore both unreliable and
 * outside our control.
 *
 * /api/rpc/:chain allowlists eth_getLogs, caches it, coalesces concurrent
 * identical requests, and fails over to the chain explorer's RPC, so reads
 * routed here succeed where the wallet path does not.
 *
 * Writes must still go through the wallet — this is for reads only.
 *
 * staticNetwork avoids a redundant chainId round-trip; polling avoids
 * eth_newFilter, which the proxy does not allow (see WalletContext).
 */
let readProviderCache = null;
let readProviderChainId = null;

export function getReadProvider() {
    const chain = activeChain();
    if (readProviderCache && readProviderChainId === chain.id) return readProviderCache;

    readProviderCache = new ethers.JsonRpcProvider(chain.rpcUrl, chain.id, {
        staticNetwork: true,
        polling: true,
    });
    readProviderChainId = chain.id;
    return readProviderCache;
}

/**
 * CORS-safe fetch with automatic fallbacks and better error handling
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {Array} fallbackUrls - Array of fallback URLs to try
 * @returns {Promise<Response>} Fetch response
 */
export const corsSafeFetch = async (url, options = {}, fallbackUrls = []) => {
    // Ensure we only use CORS-safelisted headers
    const corsHeaders = {
        'Accept': 'application/json, text/plain, */*'
        // Only include CORS-safelisted headers:
        // - Accept, Accept-Language, Content-Language, Content-Type (with restrictions)
        // - Do NOT include: Cache-Control, Authorization, Custom headers, etc.
    };

    // Add Accept-Language if provided
    if (options.headers && options.headers['Accept-Language']) {
        corsHeaders['Accept-Language'] = options.headers['Accept-Language'];
    }

    const fetchOptions = {
        method: 'GET',
        ...options,
        headers: corsHeaders,
        // Use modern AbortSignal.timeout instead of timeout property
        signal: options.timeout ? AbortSignal.timeout(options.timeout) : options.signal
    };

    // Remove the timeout property as we're using AbortSignal
    delete fetchOptions.timeout;

    const urlsToTry = [url, ...fallbackUrls];
    let lastError = null;

    for (let i = 0; i < urlsToTry.length; i++) {
        const tryUrl = urlsToTry[i];
        
        try {
            debugLog(`Trying URL ${i + 1}/${urlsToTry.length}: ${tryUrl}`);
            
            const response = await fetch(tryUrl, fetchOptions);
            
            if (response.ok) {
                debugLog(`Successfully fetched from: ${tryUrl}`);
                return response;
            } else {
                debugWarn(`HTTP ${response.status} from: ${tryUrl}`);
                lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            debugWarn(`Fetch failed for ${tryUrl}:`, error.message);
            
            // Log specific error types for debugging
            if (error.name === 'AbortError') {
                debugLog(`Request timeout for: ${tryUrl}`);
            } else if (error.message.includes('CORS') || error.message.includes('cors')) {
                debugLog(`CORS error for: ${tryUrl}`);
            } else if (error.message.includes('network') || error.message.includes('Network')) {
                debugLog(`Network error for: ${tryUrl}`);
            }
            
            lastError = error;
        }
    }

    // All URLs failed, throw the last error
    throw lastError || new Error('All fetch attempts failed');
};

/**
 * Fetch JSON with CORS-safe headers and automatic retries
 * @param {string} url - URL to fetch JSON from
 * @param {Object} options - Fetch options
 * @param {Array} fallbackUrls - Fallback URLs
 * @returns {Promise<Object>} Parsed JSON response
 */
export const fetchJSON = async (url, options = {}, fallbackUrls = []) => {
    try {
        const response = await corsSafeFetch(url, {
            timeout: 10000,
            ...options
        }, fallbackUrls);
        
        const json = await response.json();
        return json;
    } catch (error) {
        criticalError('Error fetching JSON:', error);
        throw error;
    }
};

/**
 * Create IPFS gateway fallback URLs
 * @param {string} ipfsHash - IPFS hash
 * @returns {Array<string>} Array of IPFS gateway URLs
 */
export const createIPFSFallbacks = (ipfsHash) => {
    const gateways = [
        '/api/ipfs/ipfs/',
        'https://ipfs.io/ipfs/',
        'https://dweb.link/ipfs/'
    ];
    
    return gateways.map(gateway => `${gateway}${ipfsHash}`);
};

/**
 * Resolve IPFS URL to HTTP with fallbacks
 * @param {string} uri - Original URI (can be ipfs:// or http)
 * @returns {Object} Object with primary URL and fallbacks
 */
export const resolveIPFSWithFallbacks = (uri) => {
    if (!uri || typeof uri !== 'string') {
        return { primaryUrl: uri, fallbacks: [] };
    }
    
    if (uri.startsWith('ipfs://')) {
        const hash = uri.replace('ipfs://', '');
        const fallbacks = createIPFSFallbacks(hash);
        return {
            primaryUrl: fallbacks[0], // Use first gateway as primary
            fallbacks: fallbacks.slice(1) // Rest as fallbacks
        };
    }
    
    return { primaryUrl: uri, fallbacks: [] };
};

/**
 * Check if error is CORS-related
 * @param {Error} error - Error to check
 * @returns {boolean} True if CORS-related
 */
export const isCORSError = (error) => {
    if (!error) return false;
    
    const message = error.message?.toLowerCase() || '';
    return message.includes('cors') || 
           message.includes('cross-origin') ||
           message.includes('preflight') ||
           message.includes('access-control');
};

/**
 * Check if error is network-related
 * @param {Error} error - Error to check  
 * @returns {boolean} True if network-related
 */
export const isNetworkError = (error) => {
    if (!error) return false;
    
    const message = error.message?.toLowerCase() || '';
    return message.includes('network') ||
           message.includes('timeout') ||
           message.includes('fetch') ||
           error.name === 'AbortError' ||
           error.name === 'TimeoutError';
};

/**
 * Retry function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelay - Initial delay in ms
 * @returns {Promise} Result of function
 */
export const retryWithBackoff = async (fn, maxRetries = 3, initialDelay = 1000) => {
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (attempt === maxRetries) {
                throw error;
            }
            
            // Don't retry CORS errors as they won't resolve with retries
            if (isCORSError(error)) {
                throw error;
            }
            
            const delay = initialDelay * Math.pow(2, attempt);
            debugLog(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
};

export default {
    corsSafeFetch,
    fetchJSON,
    createIPFSFallbacks,
    resolveIPFSWithFallbacks,
    isCORSError,
    isNetworkError,
    retryWithBackoff
};
