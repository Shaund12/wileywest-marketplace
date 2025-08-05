import React, { useState, useEffect, useCallback } from 'react';
import { useInView } from 'react-intersection-observer';

function LazyNftGrid({ nfts, nftScanner, onNftClick }) {
    const [visibleNfts, setVisibleNfts] = useState([]);
    const [loadedMetadata, setLoadedMetadata] = useState({});
    
    // Use intersection observer to detect when NFTs are in view
    const { ref, inView } = useInView({
        threshold: 0.1,
        triggerOnce: false
    });

    // Load metadata for visible NFTs
    useEffect(() => {
        if (inView && visibleNfts.length > 0) {
            const loadVisibleMetadata = async () => {
                // Find NFTs that need metadata loading
                const unloadedNfts = visibleNfts.filter(nft => {
                    const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                    return !loadedMetadata[key];
                });
                
                if (unloadedNfts.length === 0) return;
                
                // Load metadata for each NFT
                for (const nft of unloadedNfts) {
                    try {
                        const metadata = await nftScanner.getMetadata(
                            nft.contractAddress, 
                            nft.tokenId, 
                            nft.tokenURI
                        );
                        
                        // Add to loaded metadata
                        setLoadedMetadata(prev => ({
                            ...prev,
                            [`${nft.contractAddress.toLowerCase()}-${nft.tokenId}`]: metadata
                        }));
                    } catch (e) {
                        console.warn(`Error loading metadata for ${nft.tokenId}:`, e);
                    }
                }
            };
            
            loadVisibleMetadata();
        }
    }, [inView, visibleNfts, nftScanner, loadedMetadata]);

    // Update visible NFTs when the main nfts array changes
    useEffect(() => {
        setVisibleNfts(nfts.slice(0, 20)); // Start with first 20
    }, [nfts]);

    // Load more NFTs as user scrolls
    const loadMoreNfts = useCallback(() => {
        setVisibleNfts(prev => {
            const currentLength = prev.length;
            const nextBatch = nfts.slice(currentLength, currentLength + 20);
            return [...prev, ...nextBatch];
        });
    }, [nfts]);

    return (
        <div className="lazy-nft-grid">
            <div className="nfts-grid">
                {visibleNfts.map(nft => {
                    const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                    const metadata = loadedMetadata[key] || {};
                    const isLoading = !metadata.loaded;
                    const name = metadata.name || `NFT #${nft.tokenId}`;
                    const imageUrl = metadata.imageUrl || nftScanner.generateFallbackImage(nft.contractAddress, nft.tokenId);
                    
                    return (
                        <div key={key} className="nft-card" onClick={() => onNftClick && onNftClick(nft)}>
                            <div className="nft-image">
                                {isLoading ? (
                                    <div className="loading-image">
                                        <div className="loading-spinner small"></div>
                                    </div>
                                ) : (
                                    <img
                                        src={imageUrl}
                                        alt={name}
                                        onError={(e) => {
                                            e.target.onerror = null;
                                            e.target.src = nftScanner.generateFallbackImage(nft.contractAddress, nft.tokenId);
                                        }}
                                    />
                                )}
                            </div>
                            <div className="nft-details">
                                <h3>{name}</h3>
                                <div className="nft-type-badge">{nft.type}</div>
                            </div>
                        </div>
                    );
                })}
            </div>
            
            {/* Load more trigger element */}
            {visibleNfts.length < nfts.length && (
                <div ref={ref} className="load-more-trigger">
                    {inView && <div className="loading-spinner"></div>}
                </div>
            )}
            
            {/* Load more button as fallback */}
            {visibleNfts.length < nfts.length && !inView && (
                <button className="load-more-button" onClick={loadMoreNfts}>
                    Load More NFTs
                </button>
            )}
        </div>
    );
}

export default LazyNftGrid;