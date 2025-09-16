import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { useVirtualization } from '../hooks/useVirtualization';
import ListingCard from './ListingCard';
import LoadingSkeleton from './LoadingSkeleton';
import { cn } from '../lib/utils';

const VirtualizedNFTGrid = ({
    items = [],
    loading = false,
    error = null,
    onLoadMore = null,
    hasMore = false,
    className = '',
    itemsPerRow = 4,
    minItemWidth = 280,
    gap = 20,
    overscan = 5
}) => {
    const containerRef = useRef(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    
    // Calculate grid dimensions based on container width
    const gridConfig = useMemo(() => {
        if (containerWidth === 0) return { columns: itemsPerRow, itemWidth: minItemWidth, itemHeight: 400 };
        
        const availableWidth = containerWidth - (gap * (itemsPerRow - 1));
        const calculatedItemWidth = Math.max(minItemWidth, Math.floor(availableWidth / itemsPerRow));
        const columns = Math.floor((containerWidth + gap) / (calculatedItemWidth + gap));
        const itemHeight = calculatedItemWidth * 1.4; // Maintain aspect ratio
        
        return {
            columns: Math.max(1, columns),
            itemWidth: calculatedItemWidth,
            itemHeight
        };
    }, [containerWidth, itemsPerRow, minItemWidth, gap]);

    // Virtualization setup
    const {
        virtualItems,
        totalHeight,
        scrollToIndex,
        isScrolling
    } = useVirtualization({
        count: Math.ceil(items.length / gridConfig.columns),
        getSize: () => gridConfig.itemHeight + gap,
        overscan,
        scrollElement: containerRef.current
    });

    // Intersection observer for infinite scroll
    const { targetRef: loadMoreRef, isIntersecting } = useIntersectionObserver({
        threshold: 0.1,
        rootMargin: '100px'
    });

    // Handle container resize
    useEffect(() => {
        if (!containerRef.current) return;

        const resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                setContainerWidth(entry.contentRect.width);
            }
        });

        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, []);

    // Handle infinite scroll
    useEffect(() => {
        if (isIntersecting && hasMore && !loading && !isLoadingMore && onLoadMore) {
            setIsLoadingMore(true);
            onLoadMore().finally(() => setIsLoadingMore(false));
        }
    }, [isIntersecting, hasMore, loading, isLoadingMore, onLoadMore]);

    // Optimized item renderer with memoization
    const renderItem = useCallback((item, index) => (
        <motion.div
            key={item.id || index}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ 
                duration: 0.3, 
                delay: (index % gridConfig.columns) * 0.05 
            }}
            whileHover={{ y: -5 }}
            style={{
                width: gridConfig.itemWidth,
                height: gridConfig.itemHeight
            }}
        >
            <ListingCard 
                listing={item} 
                className="h-full"
                lazy={true}
                priority={index < gridConfig.columns * 2} // Prioritize first 2 rows
            />
        </motion.div>
    ), [gridConfig]);

    // Get items for a specific row
    const getRowItems = useCallback((rowIndex) => {
        const startIndex = rowIndex * gridConfig.columns;
        const endIndex = Math.min(startIndex + gridConfig.columns, items.length);
        return items.slice(startIndex, endIndex);
    }, [items, gridConfig.columns]);

    if (error) {
        return (
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center justify-center py-16 text-center"
            >
                <div className="text-neon-pink text-6xl mb-4">⚠️</div>
                <h3 className="text-lg font-medium mb-2">Something went wrong</h3>
                <p className="text-muted-foreground mb-4">{error}</p>
                <button 
                    onClick={() => window.location.reload()}
                    className="btn-cyber"
                >
                    Retry
                </button>
            </motion.div>
        );
    }

    if (loading && items.length === 0) {
        return (
            <div className={cn('w-full', className)}>
                <LoadingSkeleton type="marketplace-grid" />
            </div>
        );
    }

    return (
        <div className={cn('w-full', className)}>
            <div
                ref={containerRef}
                className="relative overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-primary/20"
                style={{ height: '70vh' }} // Fixed height for virtualization
            >
                {/* Virtual container */}
                <div style={{ height: totalHeight, position: 'relative' }}>
                    <AnimatePresence mode="popLayout">
                        {virtualItems.map((virtualRow) => {
                            const rowItems = getRowItems(virtualRow.index);
                            
                            return (
                                <motion.div
                                    key={virtualRow.index}
                                    style={{
                                        position: 'absolute',
                                        top: virtualRow.start,
                                        left: 0,
                                        width: '100%',
                                        height: virtualRow.size
                                    }}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                >
                                    <div 
                                        className="flex flex-wrap"
                                        style={{ gap }}
                                    >
                                        {rowItems.map((item, itemIndex) => {
                                            const globalIndex = virtualRow.index * gridConfig.columns + itemIndex;
                                            return renderItem(item, globalIndex);
                                        })}
                                    </div>
                                </motion.div>
                            );
                        })}
                    </AnimatePresence>
                </div>

                {/* Scroll indicator */}
                {isScrolling && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed top-1/2 right-4 transform -translate-y-1/2 bg-primary/20 backdrop-blur-sm border border-primary/30 rounded-full p-2 z-10"
                    >
                        <div className="w-3 h-3 bg-primary rounded-full animate-pulse" />
                    </motion.div>
                )}
            </div>

            {/* Infinite scroll trigger */}
            {hasMore && (
                <div ref={loadMoreRef} className="py-8">
                    <AnimatePresence>
                        {isLoadingMore && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex justify-center"
                            >
                                <LoadingSkeleton type="card" count={gridConfig.columns} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            )}

            {/* Empty state */}
            {!loading && items.length === 0 && (
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center justify-center py-16 text-center"
                >
                    <div className="text-neon-cyan text-6xl mb-4">🛍️</div>
                    <h3 className="text-lg font-medium mb-2">No NFTs found</h3>
                    <p className="text-muted-foreground">Try adjusting your filters or check back later for new listings.</p>
                </motion.div>
            )}

            {/* Performance indicator */}
            {items.length > 100 && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="fixed bottom-4 left-4 bg-card/80 backdrop-blur-sm border border-border/50 rounded-lg px-3 py-2 text-xs text-muted-foreground"
                >
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-neon-green rounded-full animate-pulse" />
                        Virtualized ({items.length} items)
                    </div>
                </motion.div>
            )}
        </div>
    );
};

// Memoized export for performance
export default React.memo(VirtualizedNFTGrid);