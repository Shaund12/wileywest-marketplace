/**
 * Unified NFT Image component with robust IPFS gateway retry logic
 * Ensures consistent image loading across all pages in the marketplace
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { debugLog, debugWarn } from '../utils/debugUtils';
import { isVShareContract, vShareLpSvgDataUrl, getVShareMetadata } from '../utils/vShareUtils';
import { activeChain } from '../config/chains.js';
import { nftThumbnailUrl } from '../utils/mediaUrl';
import './NFTImage.css';

// Enhanced IPFS gateway configuration for maximum reliability
const IPFS_GATEWAYS = [
    '/api/ipfs/ipfs/',
    'https://dweb.link/ipfs/',
    'https://ipfs.io/ipfs/', 
];

const IPNS_GATEWAYS = [
    '/api/ipfs/ipns/',
    'https://dweb.link/ipns/',
    'https://ipfs.io/ipns/', 
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

// Verify a stable URL once. Keeping the URL unchanged allows the browser and
// BlockDust's immutable CID cache to reuse the downloaded response when the
// visible image renders.
function loadStableImage(url, { timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const displayUrl = nftThumbnailUrl(url, 640);
        const img = new Image();
        const timer = setTimeout(() => {
            img.onload = img.onerror = null;
            reject(new Error(`Timeout loading: ${displayUrl}`));
        }, timeout);
        img.onload = () => {
            clearTimeout(timer);
            if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve(displayUrl);
            else reject(new Error(`Image has no dimensions: ${displayUrl}`));
        };
        img.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`Failed to load: ${displayUrl}`));
        };
        img.decoding = 'async';
        img.src = displayUrl;
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
                const workingUrl = await loadStableImage(url, { timeout: timeoutMs });
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
    
    // Standard image collection for all NFTs.
    // `listing` is null whenever the NFT isn't currently for sale, so callers
    // that only have loaded metadata must be able to reach this path too —
    // hence accepting a metadata-shaped object here as well.
    const m = listing?.metadata || listing || {};
    const sources = [
        m.image,
        m.imageUrl,
        m.image_url,
        listing?.image,
        listing?.imageUrl,
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
    const label = title ? title.slice(0, 22) : `${activeChain().name} NFT`;
    
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

    // Key the effect on the resolved source *values*, not object identity.
    // `listing` is a fresh object on every parent render (MarketplaceContext
    // polls), so depending on it re-ran this effect continuously: each pass
    // reset currentImageUrl and re-probed gateways, so an image would paint
    // and then blank out a moment later.
    const sourceKey = useMemo(() => {
        if (src) return String(src);
        return collectImageSources(listing, contractAddress, tokenId).join('|');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, listing?.image, listing?.imageUrl, listing?.metadata?.image, listing?.metadata?.imageUrl, contractAddress, tokenId]);

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
        // sourceKey collapses src/listing into a stable string; alt/width/height
        // are presentational only and must not trigger a re-resolve.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceKey, contractAddress, tokenId]);

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
            // naturalWidth can legitimately be 0 here — an SVG without an
            // intrinsic size reports 0, and so can an image whose decode has
            // not finished. Treating that as failure swapped in the fallback
            // over an image that was about to paint, which looked like the
            // picture appearing and then vanishing. Re-check after a decode
            // before giving up.
            const settle = () => {
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setIsLoading(false);
                    setHasError(false);
                    onLoad?.(e);
                    return;
                }
                debugWarn(`⚠️ [NFT Image] No intrinsic dimensions: ${currentImageUrl}`);
                if (fallbackUrl && currentImageUrl !== fallbackUrl) {
                    setCurrentImageUrl(fallbackUrl);
                } else {
                    setIsLoading(false);
                    setHasError(true);
                }
            };
            if (typeof img.decode === 'function') {
                img.decode().then(settle).catch(settle);
            } else {
                setTimeout(settle, 0);
            }
        }
    }, [currentImageUrl, fallbackUrl, onLoad]);

    const handleImageError = useCallback((e) => {
        const img = e.target;
        debugWarn(`❌ [NFT Image] Failed to render: ${currentImageUrl}`, e?.type || 'unknown error');
        
        // Enhanced black box detection
        // The previous "black box" heuristic included `img.complete && !data:`,
        // which is true of *every* finished non-data image, so an error always
        // triggered a cache-busted refetch. That defeated caching and, since
        // the retry URL differs only by query string, made images reload
        // repeatedly rather than settle. Only the genuine zero-dimension case
        // is worth one retry.
        const zeroDimensions = img.complete && !img.naturalWidth && !img.naturalHeight;

        if (zeroDimensions && !currentImageUrl.includes('retry=') && !currentImageUrl.startsWith('data:')) {
            const retryUrl = currentImageUrl +
                (currentImageUrl.includes('?') ? '&' : '?') +
                `retry=1`;
            debugLog(`🔄 [NFT Image] Single retry for zero-dimension image: ${retryUrl}`);
            setCurrentImageUrl(retryUrl);
            return; // Don't proceed to fallback yet
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
                        loading="lazy"
                        decoding="async"
                        fetchPriority="auto"
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
                loading="lazy"
                decoding="async"
                fetchPriority="auto"
                referrerPolicy="no-referrer"
            />
        </div>
    );
};

export default NFTImage;
