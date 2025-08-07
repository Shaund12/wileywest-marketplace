import React from 'react';
import { useSupabase } from '../context/SupabaseContext';

const CacheStats = () => {
    const { isConnected, cacheStats, clearCache } = useSupabase();

    if (!isConnected) {
        return (
            <div className="cache-stats offline">
                <h4>📊 Cache Status</h4>
                <p>❌ Supabase caching disabled - running in direct mode</p>
            </div>
        );
    }

    const hitRatio = cacheStats.hits + cacheStats.misses > 0 
        ? ((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(1)
        : 0;

    return (
        <div className="cache-stats">
            <div className="cache-header">
                <h4>📊 Cache Performance</h4>
                <button 
                    onClick={() => clearCache()} 
                    className="clear-cache-btn"
                    title="Clear all cache"
                >
                    🧹 Clear
                </button>
            </div>
            <div className="cache-metrics">
                <div className="metric">
                    <span className="metric-label">Hits:</span>
                    <span className="metric-value">{cacheStats.hits}</span>
                </div>
                <div className="metric">
                    <span className="metric-label">Misses:</span>
                    <span className="metric-value">{cacheStats.misses}</span>
                </div>
                <div className="metric">
                    <span className="metric-label">Hit Ratio:</span>
                    <span className="metric-value">{hitRatio}%</span>
                </div>
                <div className="metric">
                    <span className="metric-label">Updates:</span>
                    <span className="metric-value">{cacheStats.updates}</span>
                </div>
                <div className="metric">
                    <span className="metric-label">Errors:</span>
                    <span className="metric-value">{cacheStats.errors}</span>
                </div>
            </div>
            <div className="cache-status">
                ✅ Real-time caching active
            </div>
            
            <style jsx>{`
                .cache-stats {
                    background: rgba(0, 255, 136, 0.1);
                    border: 1px solid rgba(0, 255, 136, 0.3);
                    border-radius: 8px;
                    padding: 12px;
                    margin: 10px 0;
                    font-size: 12px;
                }
                
                .cache-stats.offline {
                    background: rgba(255, 136, 0, 0.1);
                    border-color: rgba(255, 136, 0, 0.3);
                }
                
                .cache-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                }
                
                .cache-header h4 {
                    margin: 0;
                    color: #00ff88;
                    font-size: 14px;
                }
                
                .clear-cache-btn {
                    background: rgba(255, 0, 0, 0.1);
                    border: 1px solid rgba(255, 0, 0, 0.3);
                    color: #ff4444;
                    padding: 4px 8px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 10px;
                }
                
                .clear-cache-btn:hover {
                    background: rgba(255, 0, 0, 0.2);
                }
                
                .cache-metrics {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 8px;
                    margin-bottom: 8px;
                }
                
                .metric {
                    display: flex;
                    justify-content: space-between;
                }
                
                .metric-label {
                    color: #888;
                }
                
                .metric-value {
                    color: #00ff88;
                    font-weight: bold;
                }
                
                .cache-status {
                    text-align: center;
                    color: #00ff88;
                    font-weight: bold;
                    font-size: 11px;
                }
            `}</style>
        </div>
    );
};

export default CacheStats;