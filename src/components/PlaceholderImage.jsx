import React, { useState, useEffect } from 'react';
import './PlaceholderImage.css';

function PlaceholderImage({ 
    src, 
    alt, 
    className = '', 
    seed = 'default',
    width = 300,
    height = 300,
    // New props for better NFT handling
    contractAddress = null,
    tokenId = null,
    metadata = null
}) {
    const [imageError, setImageError] = useState(false);
    const [imageLoading, setImageLoading] = useState(true);
    const [currentSrc, setCurrentSrc] = useState(src);
    const [fallbackAttempts, setFallbackAttempts] = useState(0);

    // Enhanced image source resolution with metadata fallbacks
    const getImageSources = () => {
        const sources = [];
        
        // Primary source
        if (src && typeof src === 'string' && src.trim() !== '') {
            sources.push(src.trim());
        }
        
        // Metadata-based fallbacks
        if (metadata) {
            if (metadata.image) sources.push(metadata.image);
            if (metadata.image_url) sources.push(metadata.image_url);
            if (metadata.imageUrl) sources.push(metadata.imageUrl);
            if (metadata.animation_url) sources.push(metadata.animation_url);
        }
        
        // Remove duplicates and process IPFS URLs
        const uniqueSources = [...new Set(sources)].map(source => {
            if (source.startsWith('ipfs://')) {
                return source.replace('ipfs://', 'https://ipfs.io/ipfs/');
            }
            return source;
        });
        
        return uniqueSources;
    };

    const imageSources = getImageSources();

    // Reset states when src changes
    useEffect(() => {
        setImageError(false);
        setImageLoading(true);
        setFallbackAttempts(0);
        setCurrentSrc(src);
    }, [src]);

    const handleImageError = () => {
        console.log(`Image load failed for: ${currentSrc}`);
        
        // Try next fallback source
        if (fallbackAttempts < imageSources.length - 1) {
            const nextAttempt = fallbackAttempts + 1;
            const nextSrc = imageSources[nextAttempt];
            console.log(`Trying fallback ${nextAttempt}: ${nextSrc}`);
            setFallbackAttempts(nextAttempt);
            setCurrentSrc(nextSrc);
            setImageLoading(true);
            return;
        }
        
        // All sources failed
        setImageError(true);
        setImageLoading(false);
    };

    const handleImageLoad = () => {
        console.log(`Image loaded successfully: ${currentSrc}`);
        setImageLoading(false);
        setImageError(false);
    };

    // Generate a deterministic color based on seed
    const generateColor = (seed) => {
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            const char = seed.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        
        // Generate colors in the cyberpunk theme
        const colors = [
            'linear-gradient(135deg, #5533ff, #7755ff)',
            'linear-gradient(135deg, #ff3366, #ff5588)',
            'linear-gradient(135deg, #22cc88, #44ee99)',
            'linear-gradient(135deg, #ffaa33, #ffcc55)',
            'linear-gradient(135deg, #8855ff, #aa77ff)',
            'linear-gradient(135deg, #ff6633, #ff8855)',
            'linear-gradient(135deg, #33ccff, #55eeff)',
            'linear-gradient(135deg, #cc33ff, #ee55ff)'
        ];
        
        const index = Math.abs(hash) % colors.length;
        return colors[index];
    };

    const placeholderStyle = {
        background: generateColor(seed),
        width: width,
        height: height
    };

    // Show placeholder if no image sources available or all failed
    if ((imageSources.length === 0) || (imageError && fallbackAttempts >= imageSources.length - 1)) {
        return (
            <div 
                className={`placeholder-image ${className}`}
                style={placeholderStyle}
                aria-label={alt}
            >
                <div className="placeholder-content">
                    <div className="placeholder-icon">🖼️</div>
                    <div className="placeholder-text">NFT</div>
                </div>
            </div>
        );
    }

    return (
        <div className={`image-container ${className}`}>
            {imageLoading && (
                <div 
                    className="placeholder-image loading"
                    style={placeholderStyle}
                >
                    <div className="placeholder-content">
                        <div className="loading-spinner"></div>
                    </div>
                </div>
            )}
            <img
                src={currentSrc}
                alt={alt}
                className={`nft-image ${imageLoading ? 'loading' : ''}`}
                onError={handleImageError}
                onLoad={handleImageLoad}
                style={{ display: imageLoading ? 'none' : 'block' }}
                key={`${currentSrc}-${fallbackAttempts}`} // Force re-render on source change
            />
        </div>
    );
}

export default PlaceholderImage;