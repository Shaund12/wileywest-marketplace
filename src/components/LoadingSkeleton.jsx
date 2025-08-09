import React from 'react';
import './LoadingSkeleton.css';

function LoadingSkeleton({ type = 'card', count = 1, className = '' }) {
    const renderSkeleton = () => {
        switch (type) {
            case 'card':
                return (
                    <div className="skeleton-card">
                        <div className="skeleton-image"></div>
                        <div className="skeleton-content">
                            <div className="skeleton-title"></div>
                            <div className="skeleton-subtitle"></div>
                            <div className="skeleton-price"></div>
                            <div className="skeleton-button"></div>
                        </div>
                    </div>
                );
            case 'list':
                return (
                    <div className="skeleton-list-item">
                        <div className="skeleton-image skeleton-small"></div>
                        <div className="skeleton-content">
                            <div className="skeleton-title"></div>
                            <div className="skeleton-subtitle"></div>
                        </div>
                        <div className="skeleton-price"></div>
                    </div>
                );
            case 'stats':
                return (
                    <div className="skeleton-stat">
                        <div className="skeleton-stat-value"></div>
                        <div className="skeleton-stat-label"></div>
                    </div>
                );
            case 'text':
                return (
                    <div className="skeleton-text">
                        <div className="skeleton-line"></div>
                        <div className="skeleton-line short"></div>
                    </div>
                );
            default:
                return <div className="skeleton-default"></div>;
        }
    };

    return (
        <div className={`loading-skeleton ${className}`}>
            {Array.from({ length: count }, (_, index) => (
                <div key={index} className="skeleton-item">
                    {renderSkeleton()}
                </div>
            ))}
        </div>
    );
}

export default LoadingSkeleton;