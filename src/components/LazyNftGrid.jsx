import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCachedMetadata, getProxyImageUrl, batchPrewarm } from '../utils/edgeCacheUtils';
import { debugLog, debugWarn } from '../utils/debugUtils';
import LoadingSkeleton from './LoadingSkeleton';
import './LazyNftGrid.css';

// Lazy NFT Grid with Edge Cache Integration
function LazyNftGrid({ 
    nfts = [], 
    onNftClick, 
    currentView = 'grid',
    contractInfo = {},
    batchSize = 24,
    preloadBatches = 2,
    enableInfiniteScroll = true 
}) {
    const navigate = useNavigate();
    const [visibleNfts, setVisibleNfts] = useState([]);
    const [loadedMetadata, setLoadedMetadata] = useState({});
    const [isLoadingBatch, setIsLoadingBatch] = useState(false);
    const [loadedBatches, setLoadedBatches] = useState(0);
    const [hasMoreToLoad, setHasMoreToLoad] = useState(true);
    
    // Intersection Observer refs
    const loadMoreRef = useRef(null);
    const observerRef = useRef(null);

    // Calculate total batches
    const totalBatches = Math.ceil(nfts.length / batchSize);

    // Initialize with first batch
    useEffect(() => {
        if (nfts.length > 0) {
            const firstBatch = nfts.slice(0, batchSize);
            setVisibleNfts(firstBatch);
            setLoadedBatches(1);
            setHasMoreToLoad(nfts.length > batchSize);
            
            // Pre-warm and load metadata for first batch
            loadBatchMetadata(firstBatch, 'initial');
        } else {
            setVisibleNfts([]);
            setLoadedBatches(0);
            setHasMoreToLoad(false);
        }
    }, [nfts, batchSize]);

    // Setup Intersection Observer for infinite scroll
    useEffect(() => {
        if (!enableInfiniteScroll || !loadMoreRef.current) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const [entry] = entries;
                if (entry.isIntersecting && hasMoreToLoad && !isLoadingBatch) {
                    loadNextBatch();
                }
            },
            {
                threshold: 0.1,
                rootMargin: '100px' // Start loading before element is fully visible
            }
        );

        observer.observe(loadMoreRef.current);
        observerRef.current = observer;

        return () => {
            if (observerRef.current) {
                observerRef.current.disconnect();
            }
        };
    }, [hasMoreToLoad, isLoadingBatch, enableInfiniteScroll]);

    // Load metadata for a batch of NFTs using edge cache
    const loadBatchMetadata = useCallback(async (batchNfts, batchType = 'lazy') => {
        if (!batchNfts || batchNfts.length === 0) return;

        const batchStartTime = Date.now();
        debugLog(`🚀 [LAZY GRID] Loading metadata for ${batchNfts.length} NFTs (${batchType} batch)`);

        try {
            // Step 1: Pre-warm the cache for instant loading
            if (batchType === 'initial') {
                debugLog('🔥 [LAZY GRID] Pre-warming cache for initial batch...');
                await batchPrewarm(batchNfts);
            }

            // Step 2: Load metadata with edge cache for each NFT
            const metadataPromises = batchNfts.map(async (nft) => {
                const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                
                try {
                    // Check if already loaded
                    if (loadedMetadata[key]?.loaded) {
                        return { key, metadata: loadedMetadata[key] };
                    }

                    // Load from edge cache
                    const metadata = await getCachedMetadata(nft.contractAddress, nft.tokenId);
                    
                    // Process image URL through proxy
                    if (metadata.image) {
                        const proxyImageUrl = await getProxyImageUrl(metadata.image);
                        metadata.imageUrl = proxyImageUrl;
                        metadata.image = proxyImageUrl;
                    }

                    return { key, metadata };
                } catch (error) {
                    debugWarn(`Failed to load metadata for ${key}:`, error);
                    return {
                        key,
                        metadata: {
                            name: `NFT #${nft.tokenId}`,
                            description: 'Metadata unavailable',
                            image: generateFallbackImage(nft.contractAddress, nft.tokenId),
                            imageUrl: generateFallbackImage(nft.contractAddress, nft.tokenId),
                            error: error.message,
                            loaded: true,
                            loading: false
                        }
                    };
                }
            });

            // Wait for all metadata to load
            const results = await Promise.all(metadataPromises);
            
            // Update state with loaded metadata
            const newMetadata = {};
            let successCount = 0;
            
            results.forEach(({ key, metadata }) => {
                if (metadata) {
                    newMetadata[key] = { ...metadata, loaded: true, loading: false };
                    if (!metadata.error) successCount++;
                }
            });

            setLoadedMetadata(prev => ({ ...prev, ...newMetadata }));
            
            const loadTime = Date.now() - batchStartTime;
            debugLog(`✅ [LAZY GRID] Batch metadata loaded: ${successCount}/${batchNfts.length} successful in ${loadTime}ms`);

        } catch (error) {
            debugWarn(`[LAZY GRID] Batch metadata loading failed:`, error);
        }
    }, [loadedMetadata]);

    // Load next batch of NFTs
    const loadNextBatch = useCallback(async () => {
        if (isLoadingBatch || !hasMoreToLoad) return;

        setIsLoadingBatch(true);
        
        try {
            const startIndex = loadedBatches * batchSize;
            const endIndex = Math.min(startIndex + batchSize, nfts.length);
            const nextBatch = nfts.slice(startIndex, endIndex);
            
            if (nextBatch.length === 0) {
                setHasMoreToLoad(false);
                return;
            }

            debugLog(`📦 [LAZY GRID] Loading batch ${loadedBatches + 1}/${totalBatches} (${nextBatch.length} NFTs)`);

            // Add to visible NFTs
            setVisibleNfts(prev => [...prev, ...nextBatch]);
            setLoadedBatches(prev => prev + 1);
            
            // Load metadata for this batch
            await loadBatchMetadata(nextBatch, 'lazy');
            
            // Check if this was the last batch
            if (endIndex >= nfts.length) {
                setHasMoreToLoad(false);
            }

            // Pre-load next batch if we're close to the end and there are more batches
            if (loadedBatches + 1 < totalBatches && loadedBatches + 1 <= preloadBatches) {
                const preloadStartIndex = endIndex;
                const preloadEndIndex = Math.min(preloadStartIndex + batchSize, nfts.length);
                const preloadBatch = nfts.slice(preloadStartIndex, preloadEndIndex);
                
                if (preloadBatch.length > 0) {
                    debugLog(`🔄 [LAZY GRID] Pre-loading next batch for smoother scrolling...`);
                    // Pre-warm without waiting
                    batchPrewarm(preloadBatch).catch(error => 
                        debugWarn('Pre-load batch pre-warming failed:', error)
                    );
                }
            }

        } finally {
            setIsLoadingBatch(false);
        }
    }, [isLoadingBatch, hasMoreToLoad, loadedBatches, batchSize, nfts, totalBatches, preloadBatches, loadBatchMetadata]);

    // Manual load more for button fallback
    const loadMoreManually = useCallback(() => {
        if (!isLoadingBatch && hasMoreToLoad) {
            loadNextBatch();
        }
    }, [isLoadingBatch, hasMoreToLoad, loadNextBatch]);

    // Generate fallback image for NFTs without images
    const generateFallbackImage = useCallback((contractAddress, tokenId) => {
        try {
            const hash = contractAddress.toLowerCase() + tokenId.toString();
            let hashNum = 0;
            for (let i = 0; i < hash.length; i++) {
                hashNum = ((hashNum << 5) - hashNum) + hash.charCodeAt(i);
                hashNum = hashNum & hashNum;
            }

            const hue1 = Math.abs(hashNum % 360);
            const hue2 = (hue1 + 180) % 360;
            const collectionInfo = contractInfo[contractAddress] || {};
            const shortName = (collectionInfo.symbol || collectionInfo.name || '').substring(0, 8);

            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='%230f0f0f'/%3E%3Ccircle cx='150' cy='150' r='90' fill='none' stroke='hsl(${hue1},80%,60%)' stroke-width='2'/%3E%3Ccircle cx='150' cy='150' r='40' fill='%230f0f0f' stroke='%23ffffff' stroke-width='1' stroke-opacity='0.4'/%3E%3Ctext x='150' y='140' font-family='monospace' font-size='22' fill='%23ffffff' text-anchor='middle' font-weight='bold'%3E%23${tokenId}%3C/text%3E%3Ctext x='150' y='170' font-family='monospace' font-size='18' fill='hsl(${hue1},80%,60%)' text-anchor='middle'%3E${shortName}%3C/text%3E%3C/svg%3E`;
        } catch (err) {
            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%23000'/%3E%3Ctext x='150' y='150' fill='%23fff' text-anchor='middle' font-size='24'%3E%23${tokenId}%3C/text%3E%3C/svg%3E`;
        }
    }, [contractInfo]);

    // Render NFT card
    const renderNftCard = useCallback((nft) => {
        const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
        const metadata = loadedMetadata[key] || {};
        const isLoading = metadata.loading || (!metadata.loaded && !metadata.error);
        const error = metadata.error;
        const fallbackImg = generateFallbackImage(nft.contractAddress, nft.tokenId);
        const imageUrl = metadata.imageUrl || fallbackImg;
        const name = metadata.name || `NFT #${nft.tokenId}`;
        const collectionInfo = contractInfo[nft.contractAddress] || {};

        if (currentView === 'grid') {
            return (
                <div key={key} className="nft-card" onClick={() => onNftClick && onNftClick(nft)}>
                    <div className="nft-card-inner">
                        <div className="nft-image">
                            {isLoading ? (
                                <div className="loading-image">
                                    <div className="loading-spinner small"></div>
                                    <span className="loading-text">Loading...</span>
                                </div>
                            ) : error ? (
                                <div className="error-image">
                                    <span>❌</span>
                                    <img src={fallbackImg} alt={name} className="fallback" />
                                </div>
                            ) : (
                                <img
                                    src={imageUrl}
                                    alt={name}
                                    onError={(e) => {
                                        e.target.onerror = null;
                                        if (e.target.src !== fallbackImg) {
                                            e.target.src = fallbackImg;
                                            e.target.classList.add('fallback');
                                        }
                                    }}
                                    onLoad={(e) => {
                                        if (e.target.naturalWidth === 0 || e.target.naturalHeight === 0) {
                                            e.target.onerror(e);
                                        }
                                    }}
                                />
                            )}
                        </div>
                        <div className="nft-details">
                            <h3 title={name}>{name}</h3>
                            <p className="collection-name" title={collectionInfo.name || 'Unknown Collection'}>
                                {collectionInfo.name || 'Unknown Collection'}
                                {collectionInfo.symbol ? ` (${collectionInfo.symbol})` : ''}
                            </p>
                            <div className="nft-footer">
                                <div className="nft-type-badge">{nft.type}</div>
                                {nft.type === 'ERC1155' && nft.balance > 1 && (
                                    <div className="nft-quantity">×{nft.balance}</div>
                                )}
                            </div>
                        </div>
                        <div className="nft-actions">
                            <button
                                className="primary-button full-width"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`;
                                }}
                            >
                                List for Sale
                            </button>
                            <button
                                className="secondary-button full-width"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    navigate(`/auctions/create?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`);
                                }}
                                style={{ marginTop: '0.5rem' }}
                            >
                                Create Auction
                            </button>
                        </div>
                    </div>
                </div>
            );
        } else {
            // List view
            return (
                <div key={key} className="nft-list-item">
                    <div className="nft-list-image" onClick={() => onNftClick && onNftClick(nft)}>
                        {isLoading ? (
                            <div className="loading-image">
                                <div className="loading-spinner small"></div>
                            </div>
                        ) : error ? (
                            <div className="error-image">
                                <span>❌</span>
                                <img src={fallbackImg} alt={name} className="fallback" />
                            </div>
                        ) : (
                            <img
                                src={imageUrl}
                                alt={name}
                                onError={(e) => {
                                    e.target.onerror = null;
                                    if (e.target.src !== fallbackImg) {
                                        e.target.src = fallbackImg;
                                        e.target.classList.add('fallback');
                                    }
                                }}
                            />
                        )}
                    </div>
                    <div className="nft-list-details" onClick={() => onNftClick && onNftClick(nft)}>
                        <h3>{name}</h3>
                        <p className="collection-name">
                            {collectionInfo.name || 'Unknown Collection'}
                            {collectionInfo.symbol ? ` (${collectionInfo.symbol})` : ''}
                        </p>
                        <div className="nft-list-meta">
                            <span className="nft-type-badge">{nft.type}</span>
                            {nft.type === 'ERC1155' && nft.balance > 1 && (
                                <span className="nft-quantity">Quantity: {nft.balance}</span>
                            )}
                            <span className="token-id">ID: {nft.tokenId}</span>
                        </div>
                    </div>
                    <div className="nft-list-actions">
                        <button
                            className="primary-button"
                            onClick={() => window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`}
                        >
                            List for Sale
                        </button>
                        <button
                            className="secondary-button"
                            onClick={() => navigate(`/auctions/create?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`)}
                        >
                            Create Auction
                        </button>
                        <button
                            className="secondary-button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onNftClick && onNftClick(nft);
                            }}
                        >
                            View Details
                        </button>
                    </div>
                </div>
            );
        }
    }, [loadedMetadata, currentView, contractInfo, onNftClick, navigate, generateFallbackImage]);

    return (
        <div className="lazy-nft-grid">
            {/* Loading progress indicator */}
            {nfts.length > batchSize && (
                <div className="lazy-grid-progress">
                    <div className="progress-text">
                        Showing {visibleNfts.length} of {nfts.length} NFTs
                        {loadedBatches > 0 && (
                            <span className="batch-info"> • Batch {loadedBatches}/{totalBatches}</span>
                        )}
                    </div>
                    <div className="progress-bar">
                        <div 
                            className="progress-fill" 
                            style={{ width: `${(visibleNfts.length / nfts.length) * 100}%` }}
                        />
                    </div>
                </div>
            )}

            {/* NFT Grid */}
            <div className={`nfts-${currentView}`}>
                {visibleNfts.map(nft => renderNftCard(nft))}
            </div>

            {/* Loading indicator and infinite scroll trigger */}
            {hasMoreToLoad && (
                <div className="lazy-grid-footer">
                    {isLoadingBatch && (
                        <>
                            <div className="batch-loading">
                                <div className="loading-spinner"></div>
                                <span>Loading more NFTs...</span>
                            </div>
                            
                            {/* Show skeleton placeholders while loading */}
                            <div className={`nfts-${currentView}`}>
                                <LoadingSkeleton 
                                    type={currentView === 'grid' ? 'card' : 'list'}
                                    count={Math.min(batchSize, 8)} // Show up to 8 skeletons
                                />
                            </div>
                        </>
                    )}
                    
                    {/* Intersection observer target for infinite scroll */}
                    {enableInfiniteScroll && (
                        <div 
                            ref={loadMoreRef} 
                            className="load-more-trigger"
                            style={{ height: '10px', margin: '20px 0' }}
                        />
                    )}
                    
                    {/* Manual load more button */}
                    {!isLoadingBatch && (
                        <button 
                            className="secondary-button load-more-button"
                            onClick={loadMoreManually}
                            disabled={isLoadingBatch}
                        >
                            Load More NFTs ({nfts.length - visibleNfts.length} remaining)
                        </button>
                    )}
                </div>
            )}

            {/* Completion message */}
            {!hasMoreToLoad && visibleNfts.length > 0 && nfts.length > batchSize && (
                <div className="lazy-grid-complete">
                    <span>✅ All {nfts.length} NFTs loaded</span>
                </div>
            )}
        </div>
    );
}

export default LazyNftGrid;