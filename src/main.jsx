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
            // Expose to devtools
            window.__APP_ERRORS__ = buf;
            // Optional: dispatch event for in-app toasts
            window.dispatchEvent(new CustomEvent('app:error', { detail: buf[buf.length - 1] }));
            // Keep console noise useful
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
            // Hook for external sink
            if (typeof window.__APP_METRICS_HOOK === 'function') {
                try { window.__APP_METRICS_HOOK(metric); } catch { }
            }
            // Dev-friendly console in non-prod
            if (!import.meta.env.PROD) console.info('[PerfMetric]', metric);
        };

        // Largest Contentful Paint
        const lcpObs = new PerformanceObserver((entryList) => {
            const entries = entryList.getEntries();
            const last = entries[entries.length - 1];
            if (last) emit({ name: 'LCP', value: last.startTime, detail: last });
        });
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });

        // Cumulative Layout Shift
        let clsValue = 0;
        const clsObs = new PerformanceObserver((entryList) => {
            for (const e of entryList.getEntries()) {
                if (!e.hadRecentInput) clsValue += e.value;
            }
            emit({ name: 'CLS', value: Number(clsValue.toFixed(4)) });
        });
        clsObs.observe({ type: 'layout-shift', buffered: true });

        // First Input Delay (approx via first-input)
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

// Optional PWA registration (safe if plugin not installed)
function registerPWA() {
    if (!('serviceWorker' in navigator)) return;
    ric(async () => {
        try {
            // vite-plugin-pwa virtual module (wrapped so it won't crash if absent)
            const mod = await import(/* @vite-ignore */ 'virtual:pwa-register').catch(() => null);
            if (mod?.registerSW) {
                mod.registerSW({ immediate: true, onRegistered(r) { if (!import.meta.env.PROD) console.log('[PWA] SW registered', r); } });
            }
        } catch { /* ignore */ }
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

    // Mark render timing
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

    // Defer non-critical work
    ric(() => {
        installPerfObservers();
        registerPWA();
    });
})();