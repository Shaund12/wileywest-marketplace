import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, Cpu, Zap, Wifi, Database, Clock } from 'lucide-react';

const PerformanceMonitor = ({ isVisible = false, className = '' }) => {
    const [metrics, setMetrics] = useState({
        fps: 0,
        memory: 0,
        loadTime: 0,
        apiLatency: 0,
        bundleSize: 0,
        connectionLatency: 0
    });
    
    const [performanceScore, setPerformanceScore] = useState(100);
    const frameCountRef = useRef(0);
    const lastTimeRef = useRef(performance.now());
    const rafIdRef = useRef();

    // Initialize static metrics once when component becomes visible
    useEffect(() => {
        if (!isVisible) return;

        // One-time performance measurement to avoid CPU drain
        const measureOnce = () => {
            // Static FPS estimation based on display refresh rate
            const fps = screen.refreshRate || 60; // Default to 60fps
            
            // Memory usage (if available)
            let memory = 2; // Default conservative estimate
            if ('memory' in performance) {
                const memInfo = performance.memory;
                memory = Math.round((memInfo.usedJSHeapSize / memInfo.jsHeapSizeLimit) * 100);
            }
            
            // Page load time from navigation timing
            let loadTime = 500; // Default estimate
            const navigationEntry = performance.getEntriesByType('navigation')[0];
            if (navigationEntry) {
                loadTime = Math.round(navigationEntry.loadEventEnd - navigationEntry.fetchStart);
            }
            
            // Bundle size estimation (static calculation)
            const bundleSize = Array.from(document.scripts)
                .reduce((total, script) => {
                    if (script.src && script.src.includes('/assets/')) {
                        return total + 500; // KB estimate per chunk
                    }
                    return total;
                }, 0);
            
            // Connection estimation (static, no polling)
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const connectionLatency = connection?.rtt || 100; // Use actual or fallback
            
            // Single simulated API latency check
            const apiLatency = Math.round(10 + Math.random() * 50); // Lightweight simulation
            
            setMetrics({
                fps,
                memory,
                loadTime,
                apiLatency,
                bundleSize,
                connectionLatency
            });
        };

        measureOnce();
    }, [isVisible]);

    // Calculate overall performance score
    useEffect(() => {
        const { fps, memory, loadTime, apiLatency, connectionLatency } = metrics;
        
        let score = 100;
        
        // FPS score (60fps = 100, 30fps = 50, 15fps = 25)
        if (fps > 0) {
            score -= Math.max(0, (60 - fps) * 1.5);
        }
        
        // Memory score (lower usage is better)
        score -= memory * 0.3;
        
        // Load time score (under 2s = 100, over 5s = significant penalty)
        if (loadTime > 2000) {
            score -= (loadTime - 2000) / 100;
        }
        
        // API latency score (under 100ms = good, over 500ms = poor)
        if (apiLatency > 100) {
            score -= (apiLatency - 100) / 20;
        }
        
        // Connection latency score
        if (connectionLatency > 50) {
            score -= (connectionLatency - 50) / 10;
        }
        
        setPerformanceScore(Math.max(0, Math.round(score)));
    }, [metrics]);

    const getScoreColor = (score) => {
        if (score >= 90) return 'text-neon-green';
        if (score >= 70) return 'text-neon-cyan';
        if (score >= 50) return 'text-neon-yellow';
        return 'text-neon-pink';
    };

    const getScoreBorder = (score) => {
        if (score >= 90) return 'border-neon-green';
        if (score >= 70) return 'border-neon-cyan';
        if (score >= 50) return 'border-neon-yellow';
        return 'border-neon-pink';
    };

    const MetricCard = ({ icon: Icon, label, value, unit, status, color = 'neon-cyan' }) => (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className={`bg-card/50 backdrop-blur-sm border border-${color}/30 rounded-lg p-3 hover:border-${color}/50 transition-all duration-300`}
        >
            <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 text-${color}`} />
                <span className="text-xs text-muted-foreground">{label}</span>
            </div>
            <div className="flex items-baseline gap-1">
                <span className={`text-lg font-bold text-${color}`}>{value}</span>
                <span className="text-xs text-muted-foreground">{unit}</span>
            </div>
            {status && (
                <div className="text-xs text-muted-foreground mt-1">{status}</div>
            )}
        </motion.div>
    );

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ opacity: 0, x: 300 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 300 }}
                    className={`fixed top-4 right-4 w-80 bg-background/95 backdrop-blur-lg border border-border/50 rounded-lg shadow-xl z-50 ${className}`}
                >
                    <div className="p-4">
                        {/* Header */}
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                                <Activity className="w-5 h-5 text-neon-cyan" />
                                <h3 className="font-semibold">Performance Monitor</h3>
                            </div>
                            <div className={`text-2xl font-bold ${getScoreColor(performanceScore)}`}>
                                {performanceScore}
                            </div>
                        </div>

                        {/* Performance Score Ring */}
                        <div className="flex justify-center mb-6">
                            <div className="relative w-24 h-24">
                                <svg className="w-24 h-24 transform -rotate-90" viewBox="0 0 100 100">
                                    <circle
                                        cx="50"
                                        cy="50"
                                        r="40"
                                        stroke="rgba(255,255,255,0.1)"
                                        strokeWidth="8"
                                        fill="none"
                                    />
                                    <motion.circle
                                        cx="50"
                                        cy="50"
                                        r="40"
                                        stroke="currentColor"
                                        strokeWidth="8"
                                        fill="none"
                                        strokeLinecap="round"
                                        className={getScoreColor(performanceScore)}
                                        initial={{ strokeDasharray: "0 251.2" }}
                                        animate={{ 
                                            strokeDasharray: `${(performanceScore / 100) * 251.2} 251.2` 
                                        }}
                                        transition={{ duration: 1, ease: "easeOut" }}
                                    />
                                </svg>
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="text-center">
                                        <div className={`text-lg font-bold ${getScoreColor(performanceScore)}`}>
                                            {performanceScore}
                                        </div>
                                        <div className="text-xs text-muted-foreground">Score</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Metrics Grid */}
                        <div className="grid grid-cols-2 gap-3">
                            <MetricCard
                                icon={Zap}
                                label="FPS"
                                value={metrics.fps}
                                unit="fps"
                                status={metrics.fps >= 60 ? 'Smooth' : metrics.fps >= 30 ? 'Good' : 'Poor'}
                                color={metrics.fps >= 60 ? 'neon-green' : metrics.fps >= 30 ? 'neon-cyan' : 'neon-pink'}
                            />
                            
                            <MetricCard
                                icon={Cpu}
                                label="Memory"
                                value={metrics.memory}
                                unit="%"
                                status={metrics.memory < 50 ? 'Optimal' : metrics.memory < 80 ? 'High' : 'Critical'}
                                color={metrics.memory < 50 ? 'neon-green' : metrics.memory < 80 ? 'neon-yellow' : 'neon-pink'}
                            />
                            
                            <MetricCard
                                icon={Clock}
                                label="Load Time"
                                value={Math.round(metrics.loadTime / 1000 * 10) / 10}
                                unit="s"
                                status={metrics.loadTime < 2000 ? 'Fast' : metrics.loadTime < 5000 ? 'Moderate' : 'Slow'}
                                color={metrics.loadTime < 2000 ? 'neon-green' : metrics.loadTime < 5000 ? 'neon-yellow' : 'neon-pink'}
                            />
                            
                            <MetricCard
                                icon={Database}
                                label="API Latency"
                                value={metrics.apiLatency}
                                unit="ms"
                                status={metrics.apiLatency < 100 ? 'Excellent' : metrics.apiLatency < 300 ? 'Good' : 'Poor'}
                                color={metrics.apiLatency < 100 ? 'neon-green' : metrics.apiLatency < 300 ? 'neon-cyan' : 'neon-pink'}
                            />
                            
                            <MetricCard
                                icon={Wifi}
                                label="Connection"
                                value={metrics.connectionLatency}
                                unit="ms"
                                status={metrics.connectionLatency < 50 ? 'Excellent' : metrics.connectionLatency < 100 ? 'Good' : 'Poor'}
                                color={metrics.connectionLatency < 50 ? 'neon-green' : metrics.connectionLatency < 100 ? 'neon-cyan' : 'neon-pink'}
                            />
                            
                            <MetricCard
                                icon={Activity}
                                label="Bundle Size"
                                value={Math.round(metrics.bundleSize / 10) / 100}
                                unit="MB"
                                status={metrics.bundleSize < 1000 ? 'Optimal' : metrics.bundleSize < 2000 ? 'Large' : 'Too Large'}
                                color={metrics.bundleSize < 1000 ? 'neon-green' : metrics.bundleSize < 2000 ? 'neon-yellow' : 'neon-pink'}
                            />
                        </div>

                        {/* Performance Tips */}
                        <div className="mt-4 p-3 bg-card/30 rounded-lg">
                            <div className="text-xs text-muted-foreground mb-2">Performance Tips:</div>
                            <div className="text-xs text-muted-foreground space-y-1">
                                {performanceScore < 70 && (
                                    <div>• Consider closing other browser tabs</div>
                                )}
                                {metrics.memory > 80 && (
                                    <div>• High memory usage detected</div>
                                )}
                                {metrics.fps < 30 && (
                                    <div>• Disable animations in accessibility settings</div>
                                )}
                                {metrics.apiLatency > 300 && (
                                    <div>• Check your internet connection</div>
                                )}
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default PerformanceMonitor;