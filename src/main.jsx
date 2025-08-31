import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// requestIdleCallback fallback
const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 250));

// Add helpful classes to <html>
(function setupDocumentClasses() {
    try {
        const html = document.documentElement;
        html.classList.add('has-js');
        const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        const apply = () => {
            if (mql?.matches) html.classList.add('reduced-motion');
            else html.classList.remove('reduced-motion');
        };
        apply();
        mql?.addEventListener?.('change', apply);
    } catch { /* ignore */ }
})();

// Global error capture (surface silent crashes)
(function installErrorHandlers() {
    try {
        const buf = [];
        const push = (e) => {
            buf.push({
                time: Date.now(),
                message: e?.message || String(e?.reason || e),
                stack: e?.error?.stack || e?.reason?.stack || null,
            });
            window.__APP_ERRORS__ = buf;
            window.dispatchEvent(new CustomEvent('app:error', { detail: buf[buf.length - 1] }));
            console.error('[AppError]', buf[buf.length - 1]);
        };
        window.addEventListener('error', push);
        window.addEventListener('unhandledrejection', push);
    } catch { /* ignore */ }
})();

// Performance observers (LCP, CLS, FID-like via first-input)
function installPerfObservers() {
    if (!('PerformanceObserver' in window)) return;
    try {
        const emit = (metric) => {
            if (typeof window.__APP_METRICS_HOOK === 'function') {
                try { window.__APP_METRICS_HOOK(metric); } catch { }
            }
            if (!import.meta.env.PROD) console.info('[PerfMetric]', metric);
        };

        const lcpObs = new PerformanceObserver((entryList) => {
            const entries = entryList.getEntries();
            const last = entries[entries.length - 1];
            if (last) emit({ name: 'LCP', value: last.startTime, detail: last });
        });
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });

        let clsValue = 0;
        const clsObs = new PerformanceObserver((entryList) => {
            for (const e of entryList.getEntries()) {
                if (!e.hadRecentInput) clsValue += e.value;
            }
            emit({ name: 'CLS', value: Number(clsValue.toFixed(4)) });
        });
        clsObs.observe({ type: 'layout-shift', buffered: true });

        const fidObs = new PerformanceObserver((entryList) => {
            const first = entryList.getEntries()[0];
            if (first) {
                const fid = first.processingStart - first.startTime;
                emit({ name: 'FID', value: fid, detail: first });
            }
        });
        fidObs.observe({ type: 'first-input', buffered: true });
    } catch { /* ignore */ }
}

// Optional PWA registration without plugin dependency
function registerPWA() {
    if (!('serviceWorker' in navigator)) return;
    // Only attempt if you actually ship /sw.js (set VITE_ENABLE_SW=1 to opt-in)
    if (!import.meta.env.VITE_ENABLE_SW) return;
    ric(async () => {
        try {
            const reg = await navigator.serviceWorker.register('/sw.js'); // safe even if 404 (caught)
            if (!import.meta.env.PROD) console.log('[PWA] SW registered', reg);
        } catch (e) {
            if (!import.meta.env.PROD) console.log('[PWA] SW registration skipped:', e?.message || e);
        }
    });
}

// Mount app (safe root lookup)
(function mount() {
    const rootEl = document.getElementById('root');
    if (!rootEl) {
        console.error('[App] Root element #root not found.');
        const warn = document.createElement('div');
        warn.textContent = 'Application failed to start: missing #root element.';
        warn.style.cssText = 'padding:12px;color:#fff;background:#b00020;font-family:system-ui;border-radius:8px;margin:12px;';
        document.body.appendChild(warn);
        return;
    }

    try { performance.mark('app-render-start'); } catch { }

    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );

    try {
        performance.mark('app-render-end');
        performance.measure('app-render', 'app-render-start', 'app-render-end');
        const m = performance.getEntriesByName('app-render').pop();
        if (m && !import.meta.env.PROD) console.info('[PerfMetric]', { name: 'APP_RENDER_MS', value: Math.round(m.duration) });
    } catch { }

    ric(() => {
        installPerfObservers();
        registerPWA();
    });
})();