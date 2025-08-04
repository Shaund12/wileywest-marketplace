/**
 * Utility functions for error handling and async operations
 */
import { ethers } from 'ethers';

/**
 * Safely execute an async function with error handling
 * @param {Function} asyncFn - The async function to execute
 * @param {any} fallbackValue - Value to return if the function fails
 * @param {string} errorContext - Context for error logging
 * @returns {Promise<any>} Result or fallback value
 */
export async function safeAsync(asyncFn, fallbackValue = null, errorContext = 'Unknown operation') {
  try {
    return await asyncFn();
  } catch (error) {
    console.warn(`${errorContext} failed:`, error.message);
    return fallbackValue;
  }
}

/**
 * Execute an async function with retry logic
 * @param {Function} asyncFn - The async function to execute
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} delay - Delay between retries in milliseconds
 * @param {string} errorContext - Context for error logging
 * @returns {Promise<any>} Result or throws error after all retries
 */
export async function retryAsync(asyncFn, maxRetries = 3, delay = 1000, errorContext = 'Unknown operation') {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await asyncFn();
    } catch (error) {
      lastError = error;
      console.warn(`${errorContext} attempt ${attempt}/${maxRetries} failed:`, error.message);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }
  
  throw lastError;
}

/**
 * Timeout wrapper for async functions
 * @param {Function} asyncFn - The async function to execute
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} errorContext - Context for error logging
 * @returns {Promise<any>} Result or throws timeout error
 */
export async function withTimeout(asyncFn, timeoutMs = 5000, errorContext = 'Operation') {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${errorContext} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  
  return Promise.race([asyncFn(), timeoutPromise]);
}

/**
 * Debounce function to limit rapid function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @param {boolean} immediate - Whether to execute immediately
 * @returns {Function} Debounced function
 */
export function debounce(func, wait, immediate = false) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      timeout = null;
      if (!immediate) func(...args);
    };
    const callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) func(...args);
  };
}

/**
 * Throttle function to limit function execution frequency
 * @param {Function} func - Function to throttle
 * @param {number} limit - Time limit in milliseconds
 * @returns {Function} Throttled function
 */
export function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/**
 * Format error messages for user display
 * @param {Error} error - The error object
 * @param {string} fallbackMessage - Default message if error is unclear
 * @returns {string} User-friendly error message
 */
export function formatErrorMessage(error, fallbackMessage = 'An unexpected error occurred') {
  if (!error) return fallbackMessage;
  
  // Handle different error types
  if (error.code) {
    switch (error.code) {
      case 'NETWORK_ERROR':
        return 'Network connection error. Please check your internet connection.';
      case 'TIMEOUT':
        return 'Request timed out. Please try again.';
      case 'UNAUTHORIZED':
        return 'Authorization failed. Please reconnect your wallet.';
      case 'INSUFFICIENT_FUNDS':
        return 'Insufficient funds to complete this transaction.';
      case 'USER_REJECTED':
        return 'Transaction was rejected by user.';
      case 'CONTRACT_ERROR':
        return 'Smart contract error. Please check the contract address and try again.';
      default:
        break;
    }
  }
  
  // Handle ethers.js specific errors
  if (error.reason) {
    return error.reason;
  }
  
  // Handle common error messages
  const message = error.message || error.toString();
  
  if (message.includes('user rejected')) {
    return 'Transaction was rejected by user.';
  }
  
  if (message.includes('insufficient funds')) {
    return 'Insufficient funds for this transaction.';
  }
  
  if (message.includes('network')) {
    return 'Network error. Please check your connection and try again.';
  }
  
  if (message.includes('timeout')) {
    return 'Request timed out. Please try again.';
  }
  
  if (message.includes('not found') || message.includes('404')) {
    return 'Resource not found. Please check the address or ID.';
  }
  
  if (message.includes('bad address')) {
    return 'Invalid address format. Please check the address.';
  }
  
  // Return first 100 characters of error message or fallback
  return message.length > 100 ? message.substring(0, 100) + '...' : message || fallbackMessage;
}

/**
 * Check if an error is a network-related error
 * @param {Error} error - The error to check
 * @returns {boolean} True if it's a network error
 */
export function isNetworkError(error) {
  if (!error) return false;
  
  const message = error.message || error.toString();
  const networkKeywords = [
    'network', 'fetch', 'connection', 'timeout', 'dns', 'resolve',
    'NETWORK_ERROR', 'ERR_NETWORK', 'ERR_INTERNET_DISCONNECTED',
    'ERR_BLOCKED_BY_CLIENT', 'CORS', 'Failed to fetch'
  ];
  
  return networkKeywords.some(keyword => 
    message.toLowerCase().includes(keyword.toLowerCase())
  );
}

/**
 * Check if an error is user-related (rejection, etc.)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it's a user error
 */
export function isUserError(error) {
  if (!error) return false;
  
  const message = error.message || error.toString();
  const userKeywords = [
    'user rejected', 'user denied', 'cancelled', 'rejected by user',
    'user cancelled', 'action_rejected', 'ABORT_ERR'
  ];
  
  return userKeywords.some(keyword => 
    message.toLowerCase().includes(keyword.toLowerCase())
  );
}

/**
 * Log error with context for debugging
 * @param {Error} error - The error to log
 * @param {string} context - Context where error occurred
 * @param {object} additionalData - Additional data to log
 */
export function logError(error, context = 'Unknown', additionalData = {}) {
  const errorInfo = {
    context,
    error: {
      message: error?.message || 'Unknown error',
      stack: error?.stack,
      code: error?.code,
      name: error?.name
    },
    timestamp: new Date().toISOString(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    ...additionalData
  };
  
  console.error(`[${context}] Error:`, errorInfo);
  
  // In production, you might want to send this to an error tracking service
  // Example: Sentry.captureException(error, { contexts: { errorInfo } });
}

/**
 * Create a safe event handler that won't crash the app
 * @param {Function} handler - The event handler function
 * @param {string} context - Context for error logging
 * @returns {Function} Safe event handler
 */
export function safeEventHandler(handler, context = 'Event handler') {
  return (...args) => {
    try {
      return handler(...args);
    } catch (error) {
      logError(error, context, { args });
      // Don't re-throw to prevent crashes
    }
  };
}

/**
 * Validate Ethereum address format
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid address
 */
export function isValidAddress(address) {
  try {
    return ethers.isAddress(address);
  } catch {
    return false;
  }
}

/**
 * Safely parse JSON with fallback
 * @param {string} jsonString - JSON string to parse
 * @param {any} fallback - Fallback value if parsing fails
 * @returns {any} Parsed object or fallback
 */
export function safeJsonParse(jsonString, fallback = null) {
  try {
    return JSON.parse(jsonString);
  } catch {
    return fallback;
  }
}

/**
 * Create a circuit breaker for repeated failures
 * @param {Function} func - Function to wrap
 * @param {number} failureThreshold - Number of failures before opening circuit
 * @param {number} resetTimeoutMs - Time before attempting reset
 * @returns {Function} Circuit breaker wrapped function
 */
export function createCircuitBreaker(func, failureThreshold = 5, resetTimeoutMs = 60000) {
  let failures = 0;
  let lastFailTime = 0;
  let state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
  
  return async (...args) => {
    const now = Date.now();
    
    // If circuit is open and timeout hasn't passed, reject immediately
    if (state === 'OPEN' && now - lastFailTime < resetTimeoutMs) {
      throw new Error('Circuit breaker is OPEN');
    }
    
    // If timeout has passed, try half-open
    if (state === 'OPEN' && now - lastFailTime >= resetTimeoutMs) {
      state = 'HALF_OPEN';
    }
    
    try {
      const result = await func(...args);
      
      // Reset on success
      failures = 0;
      state = 'CLOSED';
      
      return result;
    } catch (error) {
      failures++;
      lastFailTime = now;
      
      // Open circuit if threshold exceeded
      if (failures >= failureThreshold) {
        state = 'OPEN';
      }
      
      throw error;
    }
  };
}