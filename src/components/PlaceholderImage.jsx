import React, { useState } from 'react';
import './PlaceholderImage.css';

function PlaceholderImage({ 
    src, 
    alt, 
    className = '', 
    seed = 'default',
    width = 300,
    height = 300 
}) {
    const [imageError, setImageError] = useState(false);
    const [imageLoading, setImageLoading] = useState(true);

    const handleImageError = () => {
        setImageError(true);
        setImageLoading(false);
    };

    const handleImageLoad = () => {
        setImageLoading(false);
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

    if (imageError || !src) {
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
                src={src}
                alt={alt}
                className={`nft-image ${imageLoading ? 'loading' : ''}`}
                onError={handleImageError}
                onLoad={handleImageLoad}
                style={{ display: imageLoading ? 'none' : 'block' }}
            />
        </div>
    );
}

export default PlaceholderImage;