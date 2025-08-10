import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSupabase } from '../context/SupabaseContext';

const nf = (n) => new Intl.NumberFormat().format(n ?? 0);
const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function useRelativeTime(ts) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 10_000);
        return () => clearInterval(id);
    }, []);
    if (!ts) return '—';
    const diff = Math.max(0, now - new Date(ts).getTime());
    const s = Math.floor(diff / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}

function Sparkline({ points = [], width = 160, height = 36, pad = 4 }) {
    if (!points.length) return null;
    const max = 100; // ratio %
    const min = 0;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const step = points.length > 1 ? w / (points.length - 1) : 0;
    const toY = (v) => pad + h - ((v - min) / (max - min)) * h;
    const toX = (i) => pad + i * step;

    const d = points
        .map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(2)} ${toY(v).toFixed(2)}`)
        .join(' ');

    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            <path d={d} fill="none" stroke="currentColor" strokeOpacity="0.9" strokeWidth="2" />
            {/* baseline */}
            <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} stroke="currentColor" strokeOpacity="0.15" />
        </svg>
    );
}

export default function CacheStats() {
    const { isConnected, cacheStats = {}, clearCache, refreshCacheStats } = useSupabase();
    const [clearing, setClearing] = useState(false);
    const [copied, setCopied] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(false);

    const hits = toNum(cacheStats.hits);
    const misses = toNum(cacheStats.misses);
    const updates = toNum(cacheStats.updates);
    const errors = toNum(cacheStats.errors);
    const total = hits + misses;

    const hitRatio = useMemo(() => (total ? (hits / total) * 100 : 0), [hits, total]);
    const hitRatioText = useMemo(() => (total ? hitRatio.toFixed(1) : '0.0'), [hitRatio, total]);

    const lastUpdatedAgo = useRelativeTime(cacheStats.updatedAt);
    const approxSizeKB = useMemo(() => {
        try {
            const json = JSON.stringify(cacheStats);
            return Math.max(1, Math.round((json.length * 2) / 1024)); // ~UTF-16
        } catch {
            return 0;
        }
    }, [cacheStats]);

    // Keep a rolling window of ratios for the sparkline
    const ratiosRef = useRef([]);
    const [ratios, setRatios] = useState([]);
    const signature = `${hits}|${misses}|${updates}|${errors}`;
    useEffect(() => {
        const next = [...ratiosRef.current, Math.max(0, Math.min(100, hitRatio))];
        if (next.length > 26) next.splice(0, next.length - 26);
        ratiosRef.current = next;
        setRatios(next.slice());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);

    // Optional auto-refresh if context exposes refreshCacheStats
    useEffect(() => {
        if (!autoRefresh || typeof refreshCacheStats !== 'function') return;
        const id = setInterval(() => {
            refreshCacheStats().catch(() => { });
        }, 15_000);
        return () => clearInterval(id);
    }, [autoRefresh, refreshCacheStats]);

    const onClear = async () => {
        if (clearing) return;
        const ok = window.confirm('Clear all cached marketplace data?');
        if (!ok) return;
        try {
            setClearing(true);
            await clearCache?.();
        } finally {
            setClearing(false);
        }
    };

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify(cacheStats, null, 2));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch { }
    };

    const onExport = () => {
        const blob = new Blob([JSON.stringify(cacheStats, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `cache-stats-${ts}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    if (!isConnected) {
        return (
            <div className="cache-stats" style={styles.cardOffline} role="status" aria-live="polite">
                <div style={styles.head}>
                    <div style={styles.titleWrap}>
                        <span style={styles.title}>📊 Cache</span>
                        <span style={{ ...styles.pill, ...styles.pillWarn }}>Direct mode</span>
                    </div>
                </div>
                <p style={styles.muted}>Supabase caching disabled.</p>
            </div>
        );
    }

    const canRefresh = typeof refreshCacheStats === 'function';

    return (
        <div className="cache-stats" style={styles.card} role="region" aria-label="Cache performance">
            <div style={styles.head}>
                <div style={styles.titleWrap}>
                    <span style={styles.liveDot} title="Realtime connected" aria-label="Realtime connected" />
                    <span style={styles.title}>Cache</span>
                    <span style={{ ...styles.pill, ...styles.pillOk }}>{hitRatioText}% hit</span>
                </div>
                <div style={styles.actions}>
                    {canRefresh && (
                        <label style={styles.toggleLabel} title="Auto refresh every 15s">
                            <input
                                type="checkbox"
                                checked={autoRefresh}
                                onChange={(e) => setAutoRefresh(e.target.checked)}
                                style={styles.toggle}
                            />
                            auto
                        </label>
                    )}
                    <button style={styles.btn} onClick={onCopy} title="Copy diagnostics">
                        {copied ? '✅ Copied' : '📋 Copy'}
                    </button>
                    <button style={styles.btn} onClick={onExport} title="Export JSON">
                        ⬇️ Export
                    </button>
                    <button style={{ ...styles.btn, ...styles.btnDanger }} onClick={onClear} disabled={clearing}>
                        {clearing ? '…Clearing' : '🧹 Clear'}
                    </button>
                </div>
            </div>

            {/* Sparkline */}
            <div style={styles.sparkRow}>
                <Sparkline points={ratios} />
                <span style={styles.sparkLabel}>hit ratio trend</span>
            </div>

            {/* Metrics */}
            <div style={styles.grid}>
                <Metric label="Hits" value={nf(hits)} accent="ok" />
                <Metric label="Misses" value={nf(misses)} />
                <Metric label="Hit Ratio" value={`${hitRatioText}%`} />
                <Metric label="Updates" value={nf(updates)} />
                <Metric label="Errors" value={nf(errors)} accent={errors ? 'danger' : undefined} />
                <Metric label="Size (approx)" value={`${nf(approxSizeKB)} KB`} />
            </div>

            <div style={styles.foot}>
                <span style={styles.muted}>
                    Last update: {lastUpdatedAgo}
                    {cacheStats.mode ? ` • Mode: ${cacheStats.mode}` : ''}
                    {cacheStats.ttlSeconds ? ` • TTL: ${cacheStats.ttlSeconds}s` : ''}
                </span>
            </div>
        </div>
    );
}

function Metric({ label, value, accent }) {
    return (
        <div style={styles.metric}>
            <span style={styles.label}>{label}</span>
            <span
                style={{
                    ...styles.value,
                    ...(accent === 'ok' ? styles.valueOk : {}),
                    ...(accent === 'danger' ? styles.valueDanger : {}),
                }}
            >
                {value}
            </span>
        </div>
    );
}

/* minimal inline styles to avoid external css file */
const styles = {
    card: {
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
        color: '#e6e8ee',
        borderRadius: 12,
        padding: 12,
        fontSize: 12,
    },
    cardOffline: {
        border: '1px solid rgba(255,136,0,0.25)',
        background: 'rgba(255,136,0,0.08)',
        color: '#e6e8ee',
        borderRadius: 12,
        padding: 12,
        fontSize: 12,
    },
    head: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        marginBottom: 6,
    },
    titleWrap: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontWeight: 700,
        letterSpacing: '.2px',
    },
    title: { fontWeight: 700 },
    liveDot: {
        width: 8, height: 8, borderRadius: 9999,
        background: '#00ff88',
        boxShadow: '0 0 0 4px rgba(0,255,136,0.12)',
        animation: 'cachePulse 1.8s infinite ease-in-out',
    },
    actions: { display: 'inline-flex', alignItems: 'center', gap: 6 },
    btn: {
        appearance: 'none',
        fontSize: 11,
        padding: '4px 8px',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(255,255,255,0.03)',
        color: '#e6e8ee',
        cursor: 'pointer',
    },
    btnDanger: {
        borderColor: 'rgba(255,92,147,0.35)',
        color: '#ff5c93',
        background: 'rgba(255,92,147,0.08)',
    },
    pill: {
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.15)',
    },
    pillOk: { color: '#00d18f', borderColor: 'rgba(0,209,143,0.4)', background: 'rgba(0,209,143,0.08)' },
    pillWarn: { color: '#ffb14a', borderColor: 'rgba(255,177,74,0.4)', background: 'rgba(255,177,74,0.08)' },

    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0,1fr))',
        gap: 8,
        marginTop: 8,
    },
    metric: {
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: '8px 10px',
        background: 'rgba(255,255,255,0.03)',
    },
    label: { display: 'block', fontSize: 11, color: '#a6accd', marginBottom: 2 },
    value: { fontWeight: 800, fontSize: 14, letterSpacing: '.2px' },
    valueOk: { color: '#00d18f' },
    valueDanger: { color: '#ff5c93' },

    foot: { marginTop: 8, borderTop: '1px dashed rgba(255,255,255,0.10)', paddingTop: 6 },
    muted: { color: '#a6accd' },

    sparkRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    sparkLabel: { color: '#a6accd', fontSize: 11 },

    toggleLabel: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#a6accd', cursor: 'pointer' },
    toggle: { margin: 0 },
};

/* keyframes via style tag to keep single-file component */
if (typeof document !== 'undefined' && !document.getElementById('cache-stats-kf')) {
    const style = document.createElement('style');
    style.id = 'cache-stats-kf';
    style.textContent = `
  @keyframes cachePulse {
    0% { box-shadow: 0 0 0 0 rgba(0,255,136,0.18); }
    100% { box-shadow: 0 0 0 6px rgba(0,255,136,0); }
  }`;
    document.head.appendChild(style);
}
