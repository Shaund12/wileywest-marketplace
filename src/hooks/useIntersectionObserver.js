import { useState, useEffect, useRef } from 'react';

export function useIntersectionObserver({
    threshold = 0,
    root = null,
    rootMargin = '0px',
    freezeOnceVisible = false
}) {
    const [entry, setEntry] = useState();
    const [node, setNode] = useState(null);
    const observer = useRef();

    const frozen = entry?.isIntersecting && freezeOnceVisible;

    const updateEntry = ([entry]) => {
        setEntry(entry);
    };

    useEffect(() => {
        const node = observer.current; // Memoize the ref value
        if (frozen || !node) return;

        const hasIOSupport = !!window.IntersectionObserver;
        if (!hasIOSupport) return;

        const observerParams = { threshold, root, rootMargin };
        const observerInstance = new IntersectionObserver(updateEntry, observerParams);

        observerInstance.observe(node);

        return () => observerInstance.disconnect();
    }, [threshold, root, rootMargin, frozen]);

    const targetRef = (node) => {
        if (node !== null) {
            observer.current = node;
            setNode(node);
        }
    };

    return {
        targetRef,
        entry,
        isIntersecting: !!entry?.isIntersecting,
        node
    };
}