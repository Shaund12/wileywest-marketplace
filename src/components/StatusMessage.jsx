import React, { useEffect, useMemo, useRef, useState } from 'react';
import { scopedClass } from '../utils/nftUtils';
import './StatusMessage.css';

/**
 * Enhanced status message / toast
 *
 * Props:
 * - message: string | ReactNode
 * - type: 'info' | 'success' | 'warning' | 'error' | 'loading' (default 'info')
 * - persistentMessage?: string | ReactNode
 * - showPersistent?: boolean (default true)
 * - onClearPersistent?: () => void
 *
 * - dismissible?: boolean (default true) – shows ✕
 * - onClear?: () => void – clears the transient (non-persistent) message
 * - autoHide?: boolean (default false) – auto dismiss transient message
 * - duration?: number ms (default 5000) – used if autoHide
 * - progress?: number 0..1 – if provided, determinate progress bar (overrides auto)
 *
 * - icon?: ReactNode – override emoji
 * - details?: ReactNode – collapsible details content
 * - actions?: Array<{ label: string, onClick: () => void, kind?: 'primary'|'ghost' }>
 * - timestamp?: Date | number | string – shows “x min ago” chip
 * - compact?: boolean – tighter padding
 */
function StatusMessage({
    message,
    type = 'info',
    persistentMessage,
    onClearPersistent,
    showPersistent = true,

    // Enhancements
    dismissible = true,
    onClear,
    autoHide = false,
    duration = 5000,
    progress,

    icon,
    details,
    actions = [],
    timestamp,
    compact = false,
}) {
    const [open, setOpen] = useState(Boolean(message));
    const [expanded, setExpanded] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [autoPct, setAutoPct] = useState(0);
    const startRef = useRef(0);
    const rafRef = useRef();

    useEffect(() => {
        setOpen(Boolean(message));
        setAutoPct(0);
        startRef.current = performance.now();
    }, [message]);

    // Auto-dismiss for transient (non-persistent) messages
    useEffect(() => {
        if (!autoHide || !message || !open || !duration) return;
        const tick = (t) => {
            if (hovered) {
                rafRef.current = requestAnimationFrame(tick);
                return;
            }
            const elapsed = t - startRef.current;
            const p = Math.min(1, elapsed / duration);
            setAutoPct(p);
            if (p >= 1) {
                setOpen(false);
                onClear?.();
                return;
            }
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [autoHide, message, open, duration, hovered, onClear]);

    // ESC key dismiss for transient
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') {
                if (open && message && dismissible) {
                    setOpen(false);
                    onClear?.();
                }
                if (showPersistent && persistentMessage && onClearPersistent) {
                    onClearPersistent();
                }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, message, dismissible, persistentMessage, showPersistent, onClear, onClearPersistent]);

    const getIcon = (messageType) => {
        if (icon) return icon;
        switch (messageType) {
            case 'success': return '✅';
            case 'warning': return '⚠️';
            case 'error': return '❌';
            case 'loading': return '🔄';
            default: return 'ℹ️';
        }
    };

    const persistentType = useMemo(() => {
        if (!persistentMessage) return 'info';
        const m = String(persistentMessage).toLowerCase();
        if (m.includes('stale') || m.includes('outdated')) return 'warning';
        if (m.includes('error') || m.includes('failed')) return 'error';
        return 'info';
    }, [persistentMessage]);

    const { role, ariaLive } = useMemo(() => {
        switch (type) {
            case 'error': return { role: 'alert', ariaLive: 'assertive' };
            case 'warning': return { role: 'status', ariaLive: 'assertive' };
            default: return { role: 'status', ariaLive: 'polite' };
        }
    }, [type]);

    const tsChip = useMemo(() => {
        if (!timestamp) return null;
        const dt = new Date(timestamp);
        if (isNaN(dt.getTime())) return null;
        const sec = Math.max(0, (Date.now() - dt.getTime()) / 1000);
        if (sec < 60) return `${Math.floor(sec)}s ago`;
        const min = sec / 60;
        if (min < 60) return `${Math.floor(min)}m ago`;
        const hrs = min / 60;
        return `${Math.floor(hrs)}h ago`;
    }, [timestamp]);

    const containerCls = scopedClass('status-container', 'StatusMessage');

    const transientCls = `${scopedClass('status-message', 'StatusMessage')} ${scopedClass(
        `status-${type}`,
        'StatusMessage'
    )} ${compact ? 'is-compact' : ''}`.trim();

    const persistentCls = `${scopedClass('persistent-message', 'StatusMessage')} ${scopedClass(
        `status-${persistentType}`,
        'StatusMessage'
    )}`.trim();

    const pct = typeof progress === 'number'
        ? Math.max(0, Math.min(1, progress))
        : autoPct;

    return (
        <div className={containerCls}>
            {/* Transient / regular message */}
            {open && message && (
                <div
                    className={transientCls}
                    role={role}
                    aria-live={ariaLive}
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                >
                    <span className={scopedClass('status-icon', 'StatusMessage')}>
                        {getIcon(type)}
                    </span>

                    <div className={scopedClass('status-text', 'StatusMessage')} style={{ display: 'grid', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span>{message}</span>
                            {tsChip && (
                                <span
                                    aria-label={`timestamp ${tsChip}`}
                                    style={{
                                        fontSize: '0.75rem',
                                        opacity: 0.8,
                                        padding: '0.1rem 0.4rem',
                                        borderRadius: 4,
                                        border: '1px solid currentColor',
                                        background: 'rgba(255,255,255,0.06)',
                                    }}
                                >
                                    {tsChip}
                                </span>
                            )}
                        </div>

                        {/* Details toggle */}
                        {details && (
                            <details style={{ marginTop: 2 }} open={expanded} onToggle={(e) => setExpanded(e.target.open)}>
                                <summary style={{ cursor: 'pointer', opacity: 0.9 }}>Details</summary>
                                <div style={{ marginTop: 6, opacity: 0.95 }}>{details}</div>
                            </details>
                        )}

                        {/* Actions */}
                        {actions?.length > 0 && (
                            <div className="StatusMessage__actions" style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                                {actions.map((a, i) => (
                                    <button
                                        key={i}
                                        onClick={a.onClick}
                                        className="StatusMessage__action-btn"
                                        style={{
                                            appearance: 'none',
                                            border: '1px solid currentColor',
                                            background: a.kind === 'primary' ? 'currentColor' : 'transparent',
                                            color: a.kind === 'primary' ? '#0b0f14' : 'inherit',
                                            padding: '0.35rem 0.6rem',
                                            borderRadius: 6,
                                            fontWeight: 600,
                                            fontSize: '0.85rem',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {a.label}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Progress bar (auto or determinate) */}
                        {(autoHide || typeof progress === 'number') && (
                            <div
                                aria-hidden
                                style={{
                                    position: 'relative',
                                    height: 4,
                                    borderRadius: 999,
                                    background: 'rgba(255,255,255,0.12)',
                                    overflow: 'hidden',
                                    marginTop: 8,
                                }}
                            >
                                <div
                                    style={{
                                        width: `${Math.round(pct * 100)}%`,
                                        height: '100%',
                                        background:
                                            type === 'success'
                                                ? 'linear-gradient(90deg, #10b981, #34d399)'
                                                : type === 'warning'
                                                    ? 'linear-gradient(90deg, #f59e0b, #fbbf24)'
                                                    : type === 'error'
                                                        ? 'linear-gradient(90deg, #ef4444, #f87171)'
                                                        : 'linear-gradient(90deg, #3b82f6, #60a5fa)',
                                        transition: 'width .15s linear',
                                    }}
                                />
                            </div>
                        )}
                    </div>

                    {dismissible && (
                        <button
                            className={scopedClass('clear-button', 'StatusMessage')}
                            onClick={() => { setOpen(false); onClear?.(); }}
                            aria-label="Dismiss message"
                            title="Dismiss"
                        >
                            ✕
                        </button>
                    )}
                </div>
            )}

            {/* Persistent message (sticky) */}
            {showPersistent && persistentMessage && (
                <div className={persistentCls} role="alert" aria-live="assertive">
                    <span className={scopedClass('status-icon', 'StatusMessage')}>
                        {getIcon(persistentType)}
                    </span>
                    <span className={scopedClass('status-text', 'StatusMessage')}>
                        {persistentMessage}
                    </span>
                    {onClearPersistent && (
                        <button
                            className={scopedClass('clear-button', 'StatusMessage')}
                            onClick={onClearPersistent}
                            aria-label="Clear persistent message"
                            title="Dismiss"
                        >
                            ✕
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/* Compact inline chip (unchanged API) */
export function InlineStatus({ message, type = 'info' }) {
    if (!message) return null;

    const icon = (() => {
        switch (type) {
            case 'success': return '✅';
            case 'warning': return '⚠️';
            case 'error': return '❌';
            case 'loading': return '🔄';
            default: return 'ℹ️';
        }
    })();

    return (
        <span
            className={`${scopedClass('inline-status', 'StatusMessage')} ${scopedClass(`inline-${type}`, 'StatusMessage')}`}
            role={type === 'error' ? 'alert' : 'status'}
            aria-live={type === 'error' ? 'assertive' : 'polite'}
        >
            <span className={scopedClass('inline-icon', 'StatusMessage')}>
                {icon}
            </span>
            {message}
        </span>
    );
}

export default StatusMessage;
