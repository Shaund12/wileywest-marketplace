/**
 * Debug utility for gating console logs and verbose output
 * Controls console output based on environment variables or localStorage flags
 */

// Check for debug mode in various ways
const isDebugMode = () => {
    // Check environment variable first
    if (import.meta.env?.VITE_DEBUG_MODE === 'true') return true;
    
    // Check localStorage for development debugging
    if (typeof window !== 'undefined') {
        return localStorage.getItem('marketplace_debug') === 'true';
    }
    
    // Check if in development mode
    if (import.meta.env?.DEV) return false; // Don't auto-enable in dev to reduce noise
    
    return false;
};

/**
 * Debug logger that only logs when debug mode is enabled
 * @param {...any} args - Arguments to log
 */
export const debugLog = (...args) => {
    if (isDebugMode()) {
        console.log('[DEBUG]', ...args);
    }
};

/**
 * Debug warning that only logs when debug mode is enabled
 * @param {...any} args - Arguments to log
 */
export const debugWarn = (...args) => {
    if (isDebugMode()) {
        console.warn('[DEBUG]', ...args);
    }
};

/**
 * Debug error that only logs when debug mode is enabled
 * @param {...any} args - Arguments to log
 */
export const debugError = (...args) => {
    if (isDebugMode()) {
        console.error('[DEBUG]', ...args);
    }
};

/**
 * Always log errors regardless of debug mode (for critical errors)
 * @param {...any} args - Arguments to log
 */
export const criticalError = (...args) => {
    console.error('[CRITICAL]', ...args);
};

/**
 * Performance logging for debug mode
 * @param {string} operation - Operation name
 * @param {function} fn - Function to time
 * @returns {Promise<any>} Result of the function
 */
export const debugTime = async (operation, fn) => {
    if (!isDebugMode()) {
        return await fn();
    }
    
    const startTime = performance.now();
    console.time(`[DEBUG] ${operation}`);
    
    try {
        const result = await fn();
        const endTime = performance.now();
        console.timeEnd(`[DEBUG] ${operation}`);
        debugLog(`${operation} completed in ${(endTime - startTime).toFixed(2)}ms`);
        return result;
    } catch (error) {
        console.timeEnd(`[DEBUG] ${operation}`);
        debugError(`${operation} failed:`, error);
        throw error;
    }
};

/**
 * Toggle debug mode in localStorage (for development)
 */
export const toggleDebugMode = () => {
    if (typeof window !== 'undefined') {
        const current = localStorage.getItem('marketplace_debug') === 'true';
        localStorage.setItem('marketplace_debug', (!current).toString());
        console.log(`Debug mode ${!current ? 'enabled' : 'disabled'}`);
        return !current;
    }
    return false;
};

/**
 * Get current debug mode status
 */
export const getDebugMode = () => isDebugMode();

// Export a default object with all debug utilities
export default {
    log: debugLog,
    warn: debugWarn,
    error: debugError,
    critical: criticalError,
    time: debugTime,
    toggle: toggleDebugMode,
    isEnabled: getDebugMode
};