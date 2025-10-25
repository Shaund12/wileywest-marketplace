/**
 * Unified NFT Image component with robust IPFS gateway retry logic
 * Ensures consistent image loading across all pages in the marketplace
 */

import React, { useState, useEffect, useCallback } from 'react';
import { debugLog, debugWarn } from '../utils/debugUtils';
import { isVShareContract, vShareLpSvgDataUrl, getVShareMetadata } from '../utils/vShareUtils';
import './NFTImage.css';

// Enhanced IPFS gateway configuration for maximum reliability
const IPFS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipfs/', 
    'https://cf-ipfs.com/ipfs/', 
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/', 
    'https://ipfs.io/ipfs/', 
    'https://w3s.link/ipfs/',
    'https://nftstorage.link/ipfs/'
];

const IPNS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipns/', 
    'https://cf-ipfs.com/ipns/', 
    'https://dweb.link/ipns/',
    'https://gateway.pinata.cloud/ipns/', 
    'https://ipfs.io/ipns/', 
    'https://w3s.link/ipns/',
    'https://nftstorage.link/ipns/'
];

// Enhanced image URL expansion with multiple gateway support
function expandToCandidateUrls(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const url = raw.trim();
    
    // Handle data URLs
    if (url.startsWith('data:')) return [url];
    
    // Handle Arweave URLs
    if (url.startsWith('ar://')) return [`https://arweave.net/${url.slice(5)}`];
    if (/^https?:\/\/arweave\.net\//i.test(url)) return [url];

    // Handle IPFS URLs with multiple gateways
    if (url.startsWith('ipfs://')) {
        let rest = url.slice(7).replace(/^ipfs\//i, '');
        return IPFS_GATEWAYS.map(g => g + rest);
    }
    
    // Handle IPNS URLs with multiple gateways
    if (url.startsWith('ipns://')) {
        let rest = url.slice(7).replace(/^ipns\//i, '');
        return IPNS_GATEWAYS.map(g => g + rest);
    }
    
    // Handle existing gateway URLs and extract hash for other gateways
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const ipfsIdx = parts.indexOf('ipfs');
        const ipnsIdx = parts.indexOf('ipns');
        
        if (ipfsIdx !== -1 && parts[ipfsIdx + 1]) {
            return IPFS_GATEWAYS.map(g => g + parts.slice(ipfsIdx + 1).join('/'));
        }
        if (ipnsIdx !== -1 && parts[ipnsIdx + 1]) {
            return IPNS_GATEWAYS.map(g => g + parts.slice(ipnsIdx + 1).join('/'));
        }
        
        // Return as-is for regular HTTP URLs
        return [url];
    } catch {
        // If it looks like a hash, try it as IPFS
        if (/^[a-z0-9]+$/i.test(url)) {
            return IPFS_GATEWAYS.map(g => g + url);
        }
        return [url];
    }
}

// Robust image loading that handles IPFS black box issues with enhanced cache busting
function loadImageWithCacheBusting(url, options = {}) {
    const { timeout = 3000, retryWithCacheBust = true } = options;
    
    return new Promise((resolve, reject) => {
        const img = new Image();
        let timeoutId;
        let hasTimedOut = false;
        
        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            img.onload = null;
            img.onerror = null;
            img.onabort = null;
        };
        
        const handleLoad = () => {
            if (hasTimedOut) return;
            cleanup();
            
            // Verify the image actually loaded with dimensions
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                debugLog(`✅ [NFT Image] Successfully loaded image: ${img.src} (${img.naturalWidth}x${img.naturalHeight})`);
                resolve(img.src);
            } else {
                debugWarn(`⚠️ [NFT Image] Image loaded but has no dimensions (black box detected): ${img.src}`);
                
                // Try with aggressive cache busting if we haven't already
                if (retryWithCacheBust && !img.src.includes('cb=')) {
                    const timestamp = Date.now();
                    const randomStr = Math.random().toString(36).substring(7);
                    const cacheBustedUrl = url + 
                        (url.includes('?') ? '&' : '?') + 
                        `cb=${timestamp}&rnd=${randomStr}&fix=blackbox&v=2`;
                    debugLog(`🔄 [NFT Image] Retrying with enhanced cache busting: ${cacheBustedUrl}`);
                    
                    loadImageWithCacheBusting(cacheBustedUrl, { timeout, retryWithCacheBust: false })
                        .then(resolve)
                        .catch(reject);
                } else {
                    reject(new Error('Image has no dimensions (potential black box)'));
                }
            }
        };
        
        const handleError = (e) => {
            if (hasTimedOut) return;
            cleanup();
            
            debugWarn(`❌ [NFT Image] Error loading image: ${img.src}`, e?.type || 'unknown error');
            
            // For IPFS URLs, try with enhanced cache busting to overcome browser caching issues
            if (retryWithCacheBust && !img.src.includes('cb=') && 
                (url.includes('ipfs') || url.includes('dweb') || url.includes('gateway'))) {
                const timestamp = Date.now();
                const randomStr = Math.random().toString(36).substring(7);
                const cacheBustedUrl = url + 
                    (url.includes('?') ? '&' : '?') + 
                    `cb=${timestamp}&rnd=${randomStr}&bypass=1&reload=force&v=2`;
                debugLog(`🔄 [NFT Image] IPFS error, retrying with enhanced cache busting: ${cacheBustedUrl}`);
                
                loadImageWithCacheBusting(cacheBustedUrl, { timeout, retryWithCacheBust: false })
                    .then(resolve)
                    .catch(reject);
            } else {
                reject(new Error(`Failed to load: ${img.src}`));
            }
        };
        
        const handleTimeout = () => {
            hasTimedOut = true;
            cleanup();
            debugWarn(`⏰ [NFT Image] Timeout loading image: ${url}`);
            reject(new Error(`Timeout loading: ${url}`));
        };
        
        // Set up timeout
        timeoutId = setTimeout(handleTimeout, timeout);
        
        // Set up event handlers
        img.onload = handleLoad;
        img.onerror = handleError;
        img.onabort = handleError;
        
        // Set important attributes to prevent black box issues
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.loading = 'eager';
        
        // Add additional headers via fetch for better cache control
        if (url.startsWith('http') && (url.includes('ipfs') || url.includes('gateway'))) {
            // For IPFS gateways, try to fetch with proper headers first
            fetch(url, {
                method: 'HEAD',
                mode: 'cors',
                cache: 'no-cache',
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            }).then(() => {
                // If HEAD request succeeds, proceed with image loading
                debugLog(`🔍 [NFT Image] Starting to load with cache headers: ${url}`);
                img.src = url;
            }).catch(() => {
                // If HEAD request fails, proceed anyway
                debugLog(`🔍 [NFT Image] Starting to load (HEAD failed): ${url}`);
                img.src = url;
            });
        } else {
            // Start loading the image directly for non-IPFS URLs
            debugLog(`🔍 [NFT Image] Starting to load: ${url}`);
            img.src = url;
        }
    });
}

// Simplified and reliable image finder that focuses on actual loading success
function findFirstWorkingImage(candidates, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        if (!candidates?.length) return reject(new Error('No candidates'));
        if (typeof window === 'undefined') return reject(new Error('SSR'));
        
        let settled = false;
        let currentIndex = 0;
        
        const tryNext = async () => {
            if (settled) return;
            if (currentIndex >= candidates.length) {
                return reject(new Error('No working gateway found'));
            }
            
            const url = candidates[currentIndex++];
            debugLog(`🔍 [NFT Image] Testing gateway ${currentIndex}/${candidates.length}: ${url}`);
            
            try {
                const workingUrl = await loadImageWithCacheBusting(url, { timeout: timeoutMs });
                if (settled) return;
                settled = true;
                debugLog(`✅ [NFT Image] Found working URL: ${workingUrl}`);
                resolve(workingUrl);
            } catch (error) {
                debugWarn(`⚠️ [NFT Image] Gateway ${currentIndex-1} failed:`, error.message);
                // Try next candidate
                tryNext();
            }
        };
        
        tryNext();
    });
}

// Collect all possible image sources from listing data
function collectImageSources(listing, contractAddress, tokenId) {
    // Special handling for V-Share contracts
    if (contractAddress && isVShareContract(contractAddress)) {
        const vShareMetadata = getVShareMetadata(contractAddress, tokenId);
        if (vShareMetadata?.image) {
            // Return V-Share SVG as first priority
            const m = listing?.metadata || {};
            const otherSources = [
                m.image, listing?.image, listing?.imageUrl, m.image_url, m.imageUrl
            ].filter(Boolean).map(x => String(x).trim());
            
            return [vShareMetadata.image, ...otherSources];
        }
    }
    
    // Standard image collection for all NFTs
    const m = listing?.metadata || {};
    const sources = [
        m.image, 
        listing?.image, 
        listing?.imageUrl, 
        m.image_url, 
        m.imageUrl
    ];
    
    const seen = new Set();
    return sources
        .filter(Boolean)
        .map(x => String(x).trim())
        .filter(x => seen.has(x) ? false : (seen.add(x), true));
}

// Generate SVG fallback with enhanced visual appeal
function generateSvgFallback({ contractAddress = '', tokenId = '', title = '', width = 300, height = 200 }) {
    // Special handling for V-Share contracts
    if (contractAddress && isVShareContract(contractAddress)) {
        return vShareLpSvgDataUrl({ 
            contract: contractAddress, 
            tokenId: tokenId.toString(), 
            width, 
            height,
            title: 'V-Share',
            subtitle: 'Vmonsters Rev Share' 
        });
    }

    // Generate hash for consistent colors
    const hashString = (str) => {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = (h << 5) - h + str.charCodeAt(i);
            h |= 0;
        }
        return Math.abs(h);
    };

    const seed = `${contractAddress}${tokenId}`;
    const h = hashString(seed);
    const hue = h % 360;
    const hue2 = (hue + 180) % 360;
    const gradId = `g${(h % 1e9).toString(36)}`;
    const block = (h % 7) + 3;
    const label = title ? title.slice(0, 22) : 'Vitruveo NFT';
    
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
            <defs>
                <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="hsl(${hue},70%,18%)"/>
                    <stop offset="100%" stop-color="hsl(${hue2},70%,16%)"/>
                </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#${gradId})"/>
            ${Array.from({ length: block }).map((_, i) => {
                const a = (h + i * 97) % 360;
                const r = 14 + ((h >> i) % 40);
                const cx = (width / (block + 1)) * (i + 1);
                const cy = (height / (block + 1)) * ((i % 3) + 1);
                return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${a},70%,60%,0.25)"/>`;
            }).join('')}
            <text x="50%" y="${height - 14}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto" font-size="14" fill="rgba(255,255,255,0.9)" text-anchor="middle">${label}</text>
        </svg>`;
    
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
const NFTImage = ({ 
    src, 
    listing = null,
    contractAddress = '',
    tokenId = '',
    alt = 'NFT', 
    className = '', 
    width = 300, 
    height = 200,
    showRetry = true,
    onLoad,
    onError,
    placeholder = '🖼️'
}) => {
    const [currentImageUrl, setCurrentImageUrl] = useState(null);
    const [gatewayIndex, setGatewayIndex] = useState(0);
    const [availableGateways, setAvailableGateways] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [loadAttempts, setLoadAttempts] = useState(0);
    const [fallbackUrl, setFallbackUrl] = useState(null);

    // Simplified and reliable image source resolution
    useEffect(() => {
        const resolveImageSources = async () => {
            setIsLoading(true);
            setHasError(false);
            setGatewayIndex(0);
            setLoadAttempts(0);
            
            // Generate fallback SVG immediately
            const fallback = generateSvgFallback({ 
                contractAddress, 
                tokenId, 
                title: alt, 
                width, 
                height 
            });
            setFallbackUrl(fallback);

            // Collect all possible image sources
            let imageSources = [];
            
            if (src) {
                // Direct src parameter
                imageSources = [src];
            } else if (listing || contractAddress) {
                // Extract from listing data or contract info
                imageSources = collectImageSources(listing, contractAddress, tokenId);
            }

            if (!imageSources.length) {
                debugLog('🔍 [NFT Image] No image sources found, using fallback');
                setCurrentImageUrl(fallback);
                setIsLoading(false);
                return;
            }

            // Expand all sources to candidate URLs with multiple gateways
            const candidates = [];
            const seen = new Set();
            
            for (const source of imageSources) {
                for (const candidate of expandToCandidateUrls(source)) {
                    if (!seen.has(candidate)) {
                        seen.add(candidate);
                        candidates.push(candidate);
                    }
                }
            }

            if (!candidates.length) {
                debugLog('🔍 [NFT Image] No valid candidates generated, using fallback');
                setCurrentImageUrl(fallback);
                setIsLoading(false);
                return;
            }

            setAvailableGateways(candidates);
            debugLog(`🔍 [NFT Image] Testing ${candidates.length} gateway candidates for ${contractAddress}:${tokenId}`);

            // Try to find working image with simplified approach
            try {
                const workingUrl = await findFirstWorkingImage(candidates);
                debugLog(`✅ [NFT Image] Successfully found working URL: ${workingUrl}`);
                setCurrentImageUrl(workingUrl);
                setIsLoading(false);
                setHasError(false);
            } catch (error) {
                debugWarn(`❌ [NFT Image] All gateways failed for ${contractAddress}:${tokenId}:`, error.message);
                debugLog(`🔄 [NFT Image] Using fallback SVG for ${contractAddress}:${tokenId}`);
                setCurrentImageUrl(fallback);
                setIsLoading(false);
                setHasError(false); // Don't show error when we have fallback
            }
        };

        resolveImageSources();
    }, [src, listing, contractAddress, tokenId, alt, width, height]);

    // Simplified manual retry function
    const retryImageLoad = useCallback(() => {
        if (availableGateways.length > 0 && loadAttempts < 3) {
            setLoadAttempts(prev => prev + 1);
            setIsLoading(true);
            setHasError(false);
            
            // For retry, try the next available gateway
            const nextIndex = loadAttempts % availableGateways.length;
            const nextUrl = availableGateways[nextIndex];
            
            debugLog(`🔄 [NFT Image] Manual retry attempt ${loadAttempts + 1} with URL: ${nextUrl}`);
            setCurrentImageUrl(nextUrl);
            setIsLoading(false);
        }
    }, [availableGateways, loadAttempts]);

    // Handle image load events with additional validation
    const handleImageLoad = useCallback((e) => {
        const img = e.target;
        
        // Additional validation to prevent black box display
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            debugLog(`✅ [NFT Image] Successfully rendered: ${currentImageUrl} (${img.naturalWidth}x${img.naturalHeight})`);
            setIsLoading(false);
            setHasError(false);
            onLoad?.(e);
        } else {
            debugWarn(`⚠️ [NFT Image] Image appears to have loaded but has no dimensions: ${currentImageUrl}`);
            
            // If the image loaded but has no dimensions, try the fallback
            if (fallbackUrl && currentImageUrl !== fallbackUrl) {
                debugLog(`🔄 [NFT Image] Using fallback due to dimension issue: ${fallbackUrl}`);
                setCurrentImageUrl(fallbackUrl);
            } else {
                setIsLoading(false);
                setHasError(true);
            }
        }
    }, [currentImageUrl, fallbackUrl, onLoad]);

    const handleImageError = useCallback((e) => {
        const img = e.target;
        debugWarn(`❌ [NFT Image] Failed to render: ${currentImageUrl}`, e?.type || 'unknown error');
        
        // Enhanced black box detection
        const potentialBlackBox = (
            (!img.naturalWidth && !img.naturalHeight && img.complete) ||
            (img.naturalWidth === 0 && img.naturalHeight === 0) ||
            (img.complete && !img.src.startsWith('data:'))
        );
        
        if (potentialBlackBox) {
            debugWarn(`🚫 [NFT Image] Detected black box issue for: ${currentImageUrl}`);
            
            // For black box issues, try to force reload with more aggressive cache busting
            if (!currentImageUrl.includes('force=') && !currentImageUrl.startsWith('data:')) {
                const timestamp = Date.now();
                const randomStr = Math.random().toString(36).substring(7);
                const forceReloadUrl = currentImageUrl + 
                    (currentImageUrl.includes('?') ? '&' : '?') + 
                    `force=${timestamp}&fix=blackbox&rnd=${randomStr}&nocache=1&reload=force`;
                    
                debugLog(`🔄 [NFT Image] Attempting aggressive force reload: ${forceReloadUrl}`);
                setCurrentImageUrl(forceReloadUrl);
                return; // Don't proceed to fallback yet
            }
        }
        
        // If we have a fallback URL and current image is not already the fallback
        if (fallbackUrl && currentImageUrl !== fallbackUrl) {
            debugLog(`🔄 [NFT Image] Using fallback SVG: ${fallbackUrl}`);
            setCurrentImageUrl(fallbackUrl);
            setIsLoading(false);
            setHasError(false);
        } else {
            // If we're already showing fallback or don't have one, show error state
            setIsLoading(false);
            setHasError(true);
        }
        
        onError?.(e);
    }, [currentImageUrl, fallbackUrl, onError]);

    // Render loading state
    if (isLoading) {
        return (
            <div className={`nft-image-container ${className}`} style={{ width, height }}>
                {currentImageUrl && (
                    <img
                        src={currentImageUrl}
                        alt={alt}
                        className="nft-image loading"
                        onLoad={handleImageLoad}
                        onError={handleImageError}
                        style={{ 
                            width: '100%', 
                            height: '100%', 
                            objectFit: 'cover',
                            backgroundColor: 'transparent',
                            border: 'none',
                            outline: 'none',
                            display: 'block',
                            opacity: '0.8'
                        }}
                        crossOrigin="anonymous"
                        loading="eager"
                        decoding="sync"
                        fetchPriority="high"
                        referrerPolicy="no-referrer"
                    />
                )}
                <div className="nft-image-loading-overlay">
                    <div className="nft-image-spinner"></div>
                </div>
            </div>
        );
    }

    // Render error state with retry option
    if (hasError) {
        return (
            <div className={`nft-image-container nft-image-error ${className}`} style={{ width, height }}>
                <div className="nft-image-placeholder">
                    <div className="placeholder-icon">{placeholder}</div>
                    <div className="placeholder-text">Image unavailable</div>
                    {showRetry && loadAttempts < 3 && (
                        <button 
                            className="retry-button"
                            onClick={retryImageLoad}
                            type="button"
                        >
                            🔄 Retry
                        </button>
                    )}
                    {availableGateways.length > 1 && (
                        <div className="gateway-info">
                            Tried {availableGateways.length} gateways
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // Render successful image
    return (
        <div className={`nft-image-container ${className}`} style={{ width, height }}>
            <img
                src={currentImageUrl}
                alt={alt}
                className="nft-image loaded"
                onLoad={handleImageLoad}
                onError={handleImageError}
                style={{ 
                    width: '100%', 
                    height: '100%', 
                    objectFit: 'cover',
                    backgroundColor: 'transparent',
                    border: 'none',
                    outline: 'none',
                    display: 'block',
                    opacity: '1'
                }}
                crossOrigin="anonymous"
                loading="eager"
                decoding="sync"
                fetchPriority="high"
                referrerPolicy="no-referrer"
            />
        </div>
    );
};

export default NFTImage;