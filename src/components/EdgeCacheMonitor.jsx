/**
 * Edge Cache Monitor - Display cache performance and controls
 * 
 * Features:
 * - Real-time cache hit/miss rates
 * - Performance metrics
 * - Cache control buttons
 * - Edge cache status
 */

import React, { useState, useEffect } from 'react';
import { getCacheMetrics, clearSessionCache, setEdgeCacheEnabled, getCacheStatus } from '../utils/edgeCacheUtils';
import '../cache-monitor.css';

const EdgeCacheMonitor = ({ isVisible = false }) => {
    const [metrics, setMetrics] = useState(null);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(null);
    const [refreshInterval, setRefreshInterval] = useState(null);

    // Load metrics when component becomes visible
    useEffect(() => {
        if (isVisible) {
            loadMetrics();
            // Set up auto-refresh every 30 seconds
            const interval = setInterval(loadMetrics, 30000);
            setRefreshInterval(interval);
            
            return () => {
                if (interval) clearInterval(interval);
            };
        } else {
            if (refreshInterval) {
                clearInterval(refreshInterval);
                setRefreshInterval(null);
            }
        }
    }, [isVisible]);

    const loadMetrics = async () => {
        setLoading(true);
        try {
            const [summary, cacheHealth, latency] = await Promise.all([
                getCacheMetrics(),
                fetch('/api/cache-metrics?type=cache').then(r => r.ok ? r.json() : null),
                fetch('/api/cache-metrics?type=latency').then(r => r.ok ? r.json() : null)
            ]);

            setMetrics({
                summary,
                cache: cacheHealth,
                latency,
                status: getCacheStatus()
            });
        } catch (error) {
            console.error('Failed to load cache metrics:', error);
            setMetrics({ error: error.message });
        } finally {
            setLoading(false);
        }
    };

    const handleClearCache = () => {
        clearSessionCache();
        setStatus('Session cache cleared');
        setTimeout(() => setStatus(null), 2000);
    };

    const handleToggleEdgeCache = () => {
        const currentStatus = getCacheStatus();
        const newEnabled = !currentStatus.edgeEnabled;
        setEdgeCacheEnabled(newEnabled);
        setStatus(`Edge cache ${newEnabled ? 'enabled' : 'disabled'}`);
        setTimeout(() => setStatus(null), 2000);
        loadMetrics(); // Refresh metrics
    };

    const handleRefreshMetrics = () => {
        loadMetrics();
        setStatus('Metrics refreshed');
        setTimeout(() => setStatus(null), 2000);
    };

    if (!isVisible) return null;

    return (
        <div className="edge-cache-monitor">
            <div className="cache-monitor-header">
                <h3>🚀 Edge Cache Performance</h3>
                <div className="cache-controls">
                    <button 
                        onClick={handleRefreshMetrics}
                        className="btn btn-sm btn-outline"
                        disabled={loading}
                    >
                        {loading ? '⟳' : '🔄'} Refresh
                    </button>
                    <button 
                        onClick={handleToggleEdgeCache}
                        className={`btn btn-sm ${metrics?.status?.edgeEnabled ? 'btn-success' : 'btn-outline'}`}
                    >
                        {metrics?.status?.edgeEnabled ? '✅ Enabled' : '❌ Disabled'}
                    </button>
                    <button 
                        onClick={handleClearCache}
                        className="btn btn-sm btn-outline"
                    >
                        🗑️ Clear Session
                    </button>
                </div>
            </div>

            {status && (
                <div className="cache-status-message">
                    {status}
                </div>
            )}

            {loading && !metrics && (
                <div className="cache-loading">
                    Loading metrics...
                </div>
            )}

            {metrics?.error && (
                <div className="cache-error">
                    Error: {metrics.error}
                </div>
            )}

            {metrics && !metrics.error && (
                <div className="cache-metrics-grid">
                    {/* Summary Statistics */}
                    <div className="metric-card">
                        <h4>📊 Summary</h4>
                        <div className="metric-row">
                            <span>Edge Cache:</span>
                            <span className={metrics.status?.edgeEnabled ? 'status-enabled' : 'status-disabled'}>
                                {metrics.status?.edgeEnabled ? 'Enabled' : 'Disabled'}
                            </span>
                        </div>
                        <div className="metric-row">
                            <span>Session Size:</span>
                            <span>{metrics.status?.sessionSize || 0} items</span>
                        </div>
                        {metrics.summary?.total && (
                            <>
                                <div className="metric-row">
                                    <span>Total Requests:</span>
                                    <span>{metrics.summary.total.requests}</span>
                                </div>
                                <div className="metric-row">
                                    <span>Overall Hit Rate:</span>
                                    <span className={metrics.summary.total.overallHitRate > 70 ? 'status-good' : 'status-warning'}>
                                        {metrics.summary.total.overallHitRate.toFixed(1)}%
                                    </span>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Metadata Cache */}
                    {metrics.summary?.summary?.metadata && (
                        <div className="metric-card">
                            <h4>📝 Metadata Cache</h4>
                            <div className="metric-row">
                                <span>Hits:</span>
                                <span className="status-good">{metrics.summary.summary.metadata.hits}</span>
                            </div>
                            <div className="metric-row">
                                <span>Misses:</span>
                                <span className="status-warning">{metrics.summary.summary.metadata.misses}</span>
                            </div>
                            <div className="metric-row">
                                <span>Hit Rate:</span>
                                <span className={metrics.summary.summary.metadata.hitRate > 70 ? 'status-good' : 'status-warning'}>
                                    {metrics.summary.summary.metadata.hitRate.toFixed(1)}%
                                </span>
                            </div>
                            <div className="metric-row">
                                <span>Avg Latency:</span>
                                <span className={metrics.summary.summary.latency.metadata < 1000 ? 'status-good' : 'status-warning'}>
                                    {metrics.summary.summary.latency.metadata}ms
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Image Cache */}
                    {metrics.summary?.summary?.images && (
                        <div className="metric-card">
                            <h4>🖼️ Image Cache</h4>
                            <div className="metric-row">
                                <span>Hits:</span>
                                <span className="status-good">{metrics.summary.summary.images.hits}</span>
                            </div>
                            <div className="metric-row">
                                <span>Misses:</span>
                                <span className="status-warning">{metrics.summary.summary.images.misses}</span>
                            </div>
                            <div className="metric-row">
                                <span>Hit Rate:</span>
                                <span className={metrics.summary.summary.images.hitRate > 70 ? 'status-good' : 'status-warning'}>
                                    {metrics.summary.summary.images.hitRate.toFixed(1)}%
                                </span>
                            </div>
                            <div className="metric-row">
                                <span>Avg Latency:</span>
                                <span className={metrics.summary.summary.latency.images < 2000 ? 'status-good' : 'status-warning'}>
                                    {metrics.summary.summary.latency.images}ms
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Cache Health */}
                    {metrics.cache?.metadata && (
                        <div className="metric-card">
                            <h4>🏥 Cache Health</h4>
                            <div className="metric-row">
                                <span>Metadata Entries:</span>
                                <span>{metrics.cache.metadata.total} total, {metrics.cache.metadata.active} active</span>
                            </div>
                            <div className="metric-row">
                                <span>Image Entries:</span>
                                <span>{metrics.cache.images?.total || 0} total, {metrics.cache.images?.active || 0} active</span>
                            </div>
                            <div className="metric-row">
                                <span>Overall Health:</span>
                                <span className={metrics.cache.health?.metadataHealthy && metrics.cache.health?.imageHealthy ? 'status-good' : 'status-warning'}>
                                    {metrics.cache.health?.metadataHealthy && metrics.cache.health?.imageHealthy ? '✅ Healthy' : '⚠️ Issues'}
                                </span>
                            </div>
                            {metrics.cache.prewarmQueue && (
                                <div className="metric-row">
                                    <span>Pre-warm Queue:</span>
                                    <span>
                                        {metrics.cache.prewarmQueue.pending || 0} pending, 
                                        {metrics.cache.prewarmQueue.completed || 0} completed
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default EdgeCacheMonitor;