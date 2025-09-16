import { useState, useEffect, useRef, useMemo } from 'react';

export function useVirtualization({
    count,
    getSize,
    overscan = 5,
    scrollElement = null
}) {
    const [scrollTop, setScrollTop] = useState(0);
    const [isScrolling, setIsScrolling] = useState(false);
    const scrollTimeoutRef = useRef();

    // Calculate total height
    const totalHeight = useMemo(() => {
        let height = 0;
        for (let i = 0; i < count; i++) {
            height += getSize(i);
        }
        return height;
    }, [count, getSize]);

    // Get visible range
    const visibleRange = useMemo(() => {
        if (!scrollElement) return { start: 0, end: Math.min(count, overscan * 2) };

        const containerHeight = scrollElement.clientHeight || 600;
        const scrollTop = scrollElement.scrollTop || 0;

        let start = 0;
        let end = count;
        let accumulatedHeight = 0;

        // Find start index
        for (let i = 0; i < count; i++) {
            const itemHeight = getSize(i);
            if (accumulatedHeight + itemHeight > scrollTop) {
                start = Math.max(0, i - overscan);
                break;
            }
            accumulatedHeight += itemHeight;
        }

        // Find end index
        accumulatedHeight = 0;
        for (let i = 0; i < count; i++) {
            const itemHeight = getSize(i);
            if (accumulatedHeight > scrollTop + containerHeight) {
                end = Math.min(count, i + overscan);
                break;
            }
            accumulatedHeight += itemHeight;
        }

        return { start, end };
    }, [scrollTop, count, getSize, overscan, scrollElement]);

    // Calculate virtual items
    const virtualItems = useMemo(() => {
        const items = [];
        let accumulatedHeight = 0;

        for (let i = visibleRange.start; i < visibleRange.end; i++) {
            const size = getSize(i);
            
            items.push({
                index: i,
                start: accumulatedHeight,
                size,
                end: accumulatedHeight + size
            });

            accumulatedHeight += size;
        }

        return items;
    }, [visibleRange, getSize]);

    // Handle scroll events
    useEffect(() => {
        if (!scrollElement) return;

        const handleScroll = () => {
            setScrollTop(scrollElement.scrollTop);
            setIsScrolling(true);

            // Clear existing timeout
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }

            // Set scrolling to false after scroll ends
            scrollTimeoutRef.current = setTimeout(() => {
                setIsScrolling(false);
            }, 150);
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            scrollElement.removeEventListener('scroll', handleScroll);
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }
        };
    }, [scrollElement]);

    // Scroll to specific index
    const scrollToIndex = (index) => {
        if (!scrollElement || index < 0 || index >= count) return;

        let accumulatedHeight = 0;
        for (let i = 0; i < index; i++) {
            accumulatedHeight += getSize(i);
        }

        scrollElement.scrollTo({
            top: accumulatedHeight,
            behavior: 'smooth'
        });
    };

    return {
        virtualItems,
        totalHeight,
        scrollToIndex,
        isScrolling,
        visibleRange
    };
}