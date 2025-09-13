/**
 * Unified NFT Image component with robust IPFS gateway retry logic
 * Ensures consistent image loading across all pages in the marketplace
 */

import React, { useState, useEffect, useCallback } from 'react';
import { resolveImageUrl } from '../utils/metadataLoader';
import { debugLog, debugWarn } from '../utils/debugUtils';
import './NFTImage.css';

const NFTImage = ({ 
    src, 
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

    // Initialize image URLs when src changes
    useEffect(() => {
        if (!src) {
            setCurrentImageUrl(null);
            setIsLoading(false);
            setHasError(true);
            return;
        }

        const initializeImage = async () => {
            setIsLoading(true);
            setHasError(false);
            setGatewayIndex(0);
            setLoadAttempts(0);

            try {
                const resolvedUrls = await resolveImageUrl(src);
                const allUrls = [resolvedUrls.primary, ...resolvedUrls.fallbacks].filter(Boolean);
                
                setAvailableGateways(allUrls);
                setCurrentImageUrl(allUrls[0]);
                
                debugLog(`🔍 [NFT Image] Initialized with ${allUrls.length} gateway options for: ${src}`);
            } catch (error) {
                debugWarn('Failed to resolve image URLs:', error);
                setHasError(true);
                setIsLoading(false);
            }
        };

        initializeImage();
    }, [src]);

    // Try next gateway when current one fails
    const tryNextGateway = useCallback(() => {
        if (gatewayIndex < availableGateways.length - 1) {
            const nextIndex = gatewayIndex + 1;
            const nextUrl = availableGateways[nextIndex];
            
            debugLog(`🔄 [NFT Image] Trying gateway ${nextIndex + 1}/${availableGateways.length}: ${nextUrl}`);
            
            setGatewayIndex(nextIndex);
            setCurrentImageUrl(nextUrl);
            setLoadAttempts(prev => prev + 1);
            setHasError(false);
            
            return true;
        }
        
        debugWarn(`❌ [NFT Image] All ${availableGateways.length} gateways exhausted for: ${src}`);
        return false;
    }, [gatewayIndex, availableGateways, src]);

    // Handle successful image load
    const handleImageLoad = useCallback((e) => {
        debugLog(`✅ [NFT Image] Successfully loaded via gateway ${gatewayIndex + 1}: ${currentImageUrl}`);
        setIsLoading(false);
        setHasError(false);
        onLoad?.(e);
    }, [currentImageUrl, gatewayIndex, onLoad]);

    // Handle image load error
    const handleImageError = useCallback((e) => {
        debugWarn(`❌ [NFT Image] Failed to load: ${currentImageUrl}`);
        
        // Try next gateway if available
        if (tryNextGateway()) {
            // Successfully switched to next gateway, don't show error yet
            return;
        }
        
        // All gateways failed
        setIsLoading(false);
        setHasError(true);
        onError?.(e);
    }, [currentImageUrl, tryNextGateway, onError]);

    // Manual retry function
    const retryImageLoad = useCallback(() => {
        if (gatewayIndex < availableGateways.length - 1) {
            tryNextGateway();
        } else {
            // Restart from first gateway
            setGatewayIndex(0);
            setCurrentImageUrl(availableGateways[0]);
            setHasError(false);
            setIsLoading(true);
            setLoadAttempts(prev => prev + 1);
        }
    }, [gatewayIndex, availableGateways, tryNextGateway]);

    // Render loading state
    if (isLoading && currentImageUrl) {
        return (
            <div className={`nft-image-container ${className}`} style={{ width, height }}>
                <img
                    src={currentImageUrl}
                    alt={alt}
                    className="nft-image loading"
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
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
                            Tried {gatewayIndex + 1}/{availableGateways.length} gateways
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
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
        </div>
    );
};

export default NFTImage;