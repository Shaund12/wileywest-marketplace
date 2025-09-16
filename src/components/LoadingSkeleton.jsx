import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/utils';
import './LoadingSkeleton.css';

function LoadingSkeleton({ type = 'card', count = 1, className = '' }) {
    const renderSkeleton = () => {
        switch (type) {
            case 'card':
                return (
                    <motion.div 
                        className="skeleton-card cyber-card glass"
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.3 }}
                    >
                        <div className="skeleton-image neon-border-cyan">
                            <div className="skeleton-shimmer" />
                            <div className="skeleton-pulse-overlay" />
                        </div>
                        <div className="skeleton-content">
                            <div className="skeleton-title">
                                <div className="skeleton-shimmer" />
                            </div>
                            <div className="skeleton-subtitle">
                                <div className="skeleton-shimmer" />
                            </div>
                            <div className="skeleton-price">
                                <div className="skeleton-shimmer" />
                            </div>
                            <div className="skeleton-button">
                                <div className="skeleton-shimmer" />
                            </div>
                        </div>
                    </motion.div>
                );
            case 'list':
                return (
                    <motion.div 
                        className="skeleton-list-item glass"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                        <div className="skeleton-image skeleton-small neon-border-pink">
                            <div className="skeleton-shimmer" />
                        </div>
                        <div className="skeleton-content">
                            <div className="skeleton-title">
                                <div className="skeleton-shimmer" />
                            </div>
                            <div className="skeleton-subtitle">
                                <div className="skeleton-shimmer" />
                            </div>
                        </div>
                        <div className="skeleton-price">
                            <div className="skeleton-shimmer" />
                        </div>
                    </motion.div>
                );
            case 'stats':
                return (
                    <motion.div 
                        className="skeleton-stat glass"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                        <div className="skeleton-stat-value">
                            <div className="skeleton-shimmer" />
                        </div>
                        <div className="skeleton-stat-label">
                            <div className="skeleton-shimmer" />
                        </div>
                    </motion.div>
                );
            case 'text':
                return (
                    <motion.div 
                        className="skeleton-text"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.3 }}
                    >
                        <div className="skeleton-line">
                            <div className="skeleton-shimmer" />
                        </div>
                        <div className="skeleton-line short">
                            <div className="skeleton-shimmer" />
                        </div>
                    </motion.div>
                );
            case 'marketplace-grid':
                return (
                    <div className="skeleton-marketplace-grid">
                        {Array.from({ length: 12 }, (_, i) => (
                            <motion.div
                                key={i}
                                className="skeleton-card cyber-card glass"
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ delay: i * 0.05, duration: 0.3 }}
                            >
                                <div className="skeleton-image neon-border-cyan">
                                    <div className="skeleton-shimmer" />
                                    <div className="skeleton-pulse-overlay" />
                                </div>
                                <div className="skeleton-content">
                                    <div className="skeleton-title">
                                        <div className="skeleton-shimmer" />
                                    </div>
                                    <div className="skeleton-price">
                                        <div className="skeleton-shimmer" />
                                    </div>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                );
            default:
                return (
                    <motion.div 
                        className="skeleton-default glass"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.3 }}
                    >
                        <div className="skeleton-shimmer" />
                    </motion.div>
                );
        }
    };

    if (type === 'marketplace-grid') {
        return (
            <div className={cn('loading-skeleton', className)}>
                {renderSkeleton()}
            </div>
        );
    }

    return (
        <div className={cn('loading-skeleton', className)}>
            {Array.from({ length: count }, (_, index) => (
                <motion.div
                    key={index}
                    className="skeleton-item"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1, duration: 0.3 }}
                >
                    {renderSkeleton()}
                </motion.div>
            ))}
        </div>
    );
}

export default LoadingSkeleton;