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

    // Generate a beautiful NFT-style SVG fallback image
    const generateFallbackImage = (seed, contractAddress, tokenId) => {
        try {
            // Create deterministic values from seed
            let hash = 0;
            for (let i = 0; i < seed.length; i++) {
                const char = seed.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32-bit integer
            }

            // Generate dynamic angles and colors
            const angle = Math.abs(hash % 360);
            const hue1 = Math.abs(hash % 360);
            const hue2 = (hue1 + 180) % 360;

            // Extract collection info for display
            let collectionName = 'NFT';
            let displayTokenId = tokenId || '?';
            
            if (contractAddress && contractAddress.length > 10) {
                const shortContract = contractAddress.slice(0, 6) + '...' + contractAddress.slice(-4);
                collectionName = shortContract;
            }

            // Create an SVG that looks like a professional NFT with cyberpunk style
            const svgContent = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'>
                <rect width='300' height='300' fill='%230f0f0f'/>
                <circle cx='150' cy='150' r='120' fill='none' stroke='hsl(${hue1},80%,50%)' stroke-width='2' stroke-opacity='0.3'/>
                <circle cx='150' cy='150' r='90' fill='none' stroke='hsl(${hue2},80%,60%)' stroke-width='2'/>
                <path d='M150,60 A90,90 0 0 1 ${150 + 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue1},80%,60%)' stroke-width='8' fill='none'/>
                <path d='M150,60 A90,90 0 0 0 ${150 - 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue2},80%,60%)' stroke-width='8' fill='none'/>
                <circle cx='150' cy='150' r='40' fill='%230f0f0f' stroke='%23ffffff' stroke-width='1' stroke-opacity='0.4'/>
                <text x='150' y='140' font-family='monospace' font-size='22' fill='%23ffffff' text-anchor='middle' font-weight='bold'>%23${displayTokenId}</text>
                <text x='150' y='170' font-family='monospace' font-size='14' fill='hsl(${hue1},80%,60%)' text-anchor='middle'>${collectionName}</text>
                <text x='150' y='230' font-family='monospace' font-size='12' fill='%23ffffff' text-anchor='middle' font-weight='bold' opacity='0.7'>NFT</text>
            </svg>`;

            return `data:image/svg+xml,${encodeURIComponent(svgContent)}`;
        } catch (err) {
            console.error("Error generating NFT SVG:", err);
            // Ultra simple fallback
            return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><rect width='300' height='300' fill='#000'/><text x='150' y='150' fill='#fff' text-anchor='middle' font-size='24'>#${tokenId || '?'}</text></svg>`)}`;
        }
    };

    const placeholderStyle = {
        background: generateColor(seed),
        width: width,
        height: height
    };

    // Show NFT-style SVG fallback if no image sources available or all failed
    if ((imageSources.length === 0) || (imageError && fallbackAttempts >= imageSources.length - 1)) {
        const fallbackImageUrl = generateFallbackImage(seed, contractAddress, tokenId);
        
        return (
            <div className={`image-container ${className}`}>
                <img
                    src={fallbackImageUrl}
                    alt={alt}
                    className="nft-image"
                    style={{ width: width, height: height, objectFit: 'cover' }}
                    onError={(e) => {
                        // If SVG generation somehow fails, show simple gradient placeholder
                        e.target.style.display = 'none';
                        e.target.nextElementSibling.style.display = 'flex';
                    }}
                />
                <div 
                    className={`placeholder-image ${className}`}
                    style={{...placeholderStyle, display: 'none'}}
                    aria-label={alt}
                >
                    <div className="placeholder-content">
                        <div className="placeholder-icon">🖼️</div>
                        <div className="placeholder-text">NFT</div>
                    </div>
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