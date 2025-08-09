import React from 'react';
import './EmptyState.css';

function EmptyState({ 
    icon, 
    title, 
    description, 
    actionText, 
    onAction, 
    secondaryActionText,
    onSecondaryAction,
    className = '' 
}) {
    return (
        <div className={`empty-state ${className}`}>
            <div className="empty-state-content">
                <div className="empty-state-icon">
                    {icon || '🔍'}
                </div>
                <h3 className="empty-state-title">{title}</h3>
                <p className="empty-state-description">{description}</p>
                <div className="empty-state-actions">
                    {onAction && actionText && (
                        <button 
                            className="primary-button"
                            onClick={onAction}
                        >
                            {actionText}
                        </button>
                    )}
                    {onSecondaryAction && secondaryActionText && (
                        <button 
                            className="secondary-button"
                            onClick={onSecondaryAction}
                        >
                            {secondaryActionText}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

export default EmptyState;