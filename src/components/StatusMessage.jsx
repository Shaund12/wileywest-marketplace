import React from 'react';
import { scopedClass } from '../utils/nftUtils';
import './StatusMessage.css';

/**
 * Enhanced status message component with support for different types and persistence
 * @param {Object} props - Component props
 * @param {string} props.message - Message to display
 * @param {string} props.persistentMessage - Persistent message (shows until cleared)
 * @param {string} props.type - Message type ('info', 'success', 'warning', 'error')
 * @param {Function} props.onClearPersistent - Callback to clear persistent message
 * @param {boolean} props.showPersistent - Whether to show persistent messages
 */
function StatusMessage({ 
    message, 
    persistentMessage, 
    type = 'info', 
    onClearPersistent,
    showPersistent = true 
}) {
    const getIcon = (messageType) => {
        switch (messageType) {
            case 'success': return '✅';
            case 'warning': return '⚠️';
            case 'error': return '❌';
            case 'info':
            default: return 'ℹ️';
        }
    };

    const getPersistentType = (msg) => {
        if (msg.toLowerCase().includes('stale') || msg.toLowerCase().includes('outdated')) {
            return 'warning';
        }
        if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('failed')) {
            return 'error';
        }
        return 'info';
    };

    return (
        <div className={scopedClass('status-container', 'StatusMessage')}>
            {/* Regular status message */}
            {message && (
                <div 
                    className={`${scopedClass('status-message', 'StatusMessage')} ${scopedClass(`status-${type}`, 'StatusMessage')}`}
                    role="status"
                    aria-live="polite"
                >
                    <span className={scopedClass('status-icon', 'StatusMessage')}>
                        {getIcon(type)}
                    </span>
                    <span className={scopedClass('status-text', 'StatusMessage')}>
                        {message}
                    </span>
                </div>
            )}

            {/* Persistent status message */}
            {showPersistent && persistentMessage && (
                <div 
                    className={`${scopedClass('persistent-message', 'StatusMessage')} ${scopedClass(`status-${getPersistentType(persistentMessage)}`, 'StatusMessage')}`}
                    role="alert"
                    aria-live="assertive"
                >
                    <span className={scopedClass('status-icon', 'StatusMessage')}>
                        {getIcon(getPersistentType(persistentMessage))}
                    </span>
                    <span className={scopedClass('status-text', 'StatusMessage')}>
                        {persistentMessage}
                    </span>
                    {onClearPersistent && (
                        <button
                            className={scopedClass('clear-button', 'StatusMessage')}
                            onClick={onClearPersistent}
                            aria-label="Clear persistent message"
                            title="Dismiss this message"
                        >
                            ✕
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Simplified status display for inline use
 */
export function InlineStatus({ message, type = 'info' }) {
    if (!message) return null;

    const getIcon = (messageType) => {
        switch (messageType) {
            case 'success': return '✅';
            case 'warning': return '⚠️';  
            case 'error': return '❌';
            case 'loading': return '🔄';
            case 'info':
            default: return 'ℹ️';
        }
    };

    return (
        <span 
            className={`${scopedClass('inline-status', 'StatusMessage')} ${scopedClass(`inline-${type}`, 'StatusMessage')}`}
            role="status"
            aria-live="polite"
        >
            <span className={scopedClass('inline-icon', 'StatusMessage')}>
                {getIcon(type)}
            </span>
            {message}
        </span>
    );
}

export default StatusMessage;