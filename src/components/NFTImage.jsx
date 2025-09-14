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

// Enhanced working image finder with better reliability for IPFS gateways
function findFirstWorkingImage(candidates, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        if (!candidates?.length) return reject(new Error('No candidates'));
        if (typeof window === 'undefined') return reject(new Error('SSR'));
        
        let settled = false;
        let idx = 0;
        
        const testAndValidateUrl = (url) => {
            return new Promise((resolveUrl, rejectUrl) => {
                const testImg = new Image();
                
                // First, test with cache busting to check availability
                const timer1 = setTimeout(() => {
                    testImg.onload = null;
                    testImg.onerror = null;
                    rejectUrl(new Error('Timeout during availability test'));
                }, timeoutMs);
                
                testImg.onload = () => {
                    clearTimeout(timer1);
                    
                    // If cache-busted version works, now test the clean URL
                    const cleanImg = new Image();
                    const timer2 = setTimeout(() => {
                        cleanImg.onload = null;
                        cleanImg.onerror = null;
                        rejectUrl(new Error('Clean URL failed'));
                    }, 2000); // Shorter timeout for clean URL test
                    
                    cleanImg.onload = () => {
                        clearTimeout(timer2);
                        resolveUrl(url); // Return clean URL
                    };
                    
                    cleanImg.onerror = (e) => {
                        clearTimeout(timer2);
                        // If clean URL fails but cache-busted worked, 
                        // we'll use cache-busted URL as fallback
                        debugWarn(`🔄 [NFT Image] Clean URL failed for ${url}, using cache-busted version`);
                        
                        // Check if the error might be CORS-related
                        const corsError = e.target && !e.target.naturalWidth && !e.target.naturalHeight;
                        if (corsError) {
                            debugWarn(`🚫 [NFT Image] Possible CORS issue detected for ${url}`);
                        }
                        
                        resolveUrl(url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now());
                    };
                    
                    // Test clean URL
                    cleanImg.src = url;
                };
                
                testImg.onerror = () => {
                    clearTimeout(timer1);
                    rejectUrl(new Error('URL not available'));
                };
                
                // Test with cache busting first
                testImg.src = url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now();
            });
        };
        
        const tryNext = async () => {
            if (settled) return;
            if (idx >= candidates.length) {
                return reject(new Error('No gateway worked'));
            }
            
            const url = candidates[idx++];
            
            try {
                const workingUrl = await testAndValidateUrl(url);
                if (settled) return;
                settled = true;
                resolve(workingUrl);
            } catch (error) {
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

    // Enhanced image source resolution
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
                debugWarn('🔍 [NFT Image] No image sources found, using fallback');
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
                debugWarn('🔍 [NFT Image] No valid candidates generated, using fallback');
                setCurrentImageUrl(fallback);
                setIsLoading(false);
                return;
            }

            setAvailableGateways(candidates);
            debugLog(`🔍 [NFT Image] Found ${candidates.length} gateway candidates for ${contractAddress}:${tokenId}`);

            // Try to find working image
            try {
                const workingUrl = await findFirstWorkingImage(candidates);
                debugLog(`✅ [NFT Image] Found working URL: ${workingUrl}`);
                setCurrentImageUrl(workingUrl);
                setIsLoading(false);
                setHasError(false);
            } catch (error) {
                debugWarn(`❌ [NFT Image] Enhanced method failed for ${contractAddress}:${tokenId}, trying simplified approach`);
                
                // Fallback: try the first candidate URL directly without complex validation
                if (candidates.length > 0) {
                    debugLog(`🔄 [NFT Image] Trying first candidate directly: ${candidates[0]}`);
                    setCurrentImageUrl(candidates[0]);
                    setIsLoading(false);
                    setHasError(false);
                } else {
                    debugWarn(`❌ [NFT Image] No candidates available, using fallback`);
                    setCurrentImageUrl(fallback);
                    setIsLoading(false);
                    setHasError(false); // Don't show error when we have fallback
                }
            }
        };

        resolveImageSources();
    }, [src, listing, contractAddress, tokenId, alt, width, height]);

    // Manual retry function
    const retryImageLoad = useCallback(() => {
        if (availableGateways.length > 0) {
            setLoadAttempts(prev => prev + 1);
            setIsLoading(true);
            setHasError(false);
            
            // For manual retry, try a more direct approach
            if (loadAttempts >= 1) {
                // After first retry, use direct URL approach
                const directUrl = availableGateways[Math.min(loadAttempts - 1, availableGateways.length - 1)];
                debugLog(`🔄 [NFT Image] Manual retry with direct URL: ${directUrl}`);
                setCurrentImageUrl(directUrl);
                setIsLoading(false);
                return;
            }
            
            // First retry: try sophisticated method again
            findFirstWorkingImage(availableGateways)
                .then(workingUrl => {
                    debugLog(`✅ [NFT Image] Retry found working URL: ${workingUrl}`);
                    setCurrentImageUrl(workingUrl);
                    setIsLoading(false);
                    setHasError(false);
                })
                .catch(() => {
                    debugWarn(`❌ [NFT Image] Retry failed, trying direct approach`);
                    if (availableGateways.length > 0) {
                        const directUrl = availableGateways[0];
                        debugLog(`🔄 [NFT Image] Using direct URL: ${directUrl}`);
                        setCurrentImageUrl(directUrl);
                    } else {
                        setCurrentImageUrl(fallbackUrl);
                    }
                    setIsLoading(false);
                    setHasError(false);
                });
        }
    }, [availableGateways, fallbackUrl, loadAttempts]);

    // Handle image load events
    const handleImageLoad = useCallback((e) => {
        debugLog(`✅ [NFT Image] Successfully loaded: ${currentImageUrl}`);
        setIsLoading(false);
        setHasError(false);
        onLoad?.(e);
    }, [currentImageUrl, onLoad]);

    const handleImageError = useCallback((e) => {
        debugWarn(`❌ [NFT Image] Failed to load: ${currentImageUrl}`, e);
        
        // Check if this might be a CORS issue
        const corsError = e.target && !e.target.naturalWidth && !e.target.naturalHeight;
        if (corsError) {
            debugWarn(`🚫 [NFT Image] Possible CORS issue detected for ${currentImageUrl}`);
        }
        
        // If the current image is not a data URL (fallback), try the fallback
        if (currentImageUrl && !currentImageUrl.startsWith('data:') && fallbackUrl) {
            debugLog(`🔄 [NFT Image] Falling back to SVG: ${fallbackUrl}`);
            setCurrentImageUrl(fallbackUrl);
            setIsLoading(false);
            setHasError(false);
        } else {
            // If even fallback fails, we should try to retry with a different approach
            if (availableGateways.length > 1 && loadAttempts < 2) {
                debugLog(`🔄 [NFT Image] Retrying with simplified approach, attempt ${loadAttempts + 1}`);
                setLoadAttempts(prev => prev + 1);
                setIsLoading(true);
                
                // Try a simplified approach - just use the first gateway URL without complex validation
                const nextGatewayIndex = loadAttempts % availableGateways.length;
                const simpleUrl = availableGateways[nextGatewayIndex];
                if (simpleUrl && simpleUrl !== currentImageUrl) {
                    setCurrentImageUrl(simpleUrl);
                    return;
                }
            }
            
            setIsLoading(false);
            setHasError(true);
        }
        
        onError?.(e);
    }, [currentImageUrl, fallbackUrl, onError, availableGateways, loadAttempts]);

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
                            minHeight: '1px',
                            minWidth: '1px'
                        }}
                        crossOrigin="anonymous"
                        loading="lazy"
                        decoding="async"
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
                    // Add these properties to prevent black box issues
                    backgroundColor: 'transparent',
                    minHeight: '1px',
                    minWidth: '1px'
                }}
                // Add these attributes to help with CORS and loading issues
                crossOrigin="anonymous"
                loading="lazy"
                decoding="async"
            />
        </div>
    );
};

export default NFTImage;