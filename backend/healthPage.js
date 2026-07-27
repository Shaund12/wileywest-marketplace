const packageInfo = require('../package.json');

const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m`;
    return `${seconds}s`;
}

async function measure(id, label, detail, check) {
    const started = performance.now();
    try {
        const result = await check();
        return {
            id,
            label,
            detail,
            ok: result !== false,
            latencyMs: Math.max(0, Math.round(performance.now() - started)),
        };
    } catch {
        return {
            id,
            label,
            detail,
            ok: false,
            latencyMs: Math.max(0, Math.round(performance.now() - started)),
        };
    }
}

async function checkRpc(url, expectedChainId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_chainId',
                params: [],
            }),
            signal: controller.signal,
        });
        if (!response.ok) return false;
        const payload = await response.json();
        return Number.parseInt(payload.result, 16) === expectedChainId;
    } finally {
        clearTimeout(timeout);
    }
}

async function collectHealthSnapshot({ healthCheck, rpcTargets }) {
    const requestStarted = performance.now();
    const [database, hyve, vitruveo] = await Promise.all([
        measure('database', 'Marketplace database', 'Listings, profiles, and cached metadata', healthCheck),
        measure('hyve', 'Hyve network', 'Chain 7847 marketplace connectivity', () =>
            checkRpc(rpcTargets.hyve, 7847)),
        measure('vitruveo', 'Vitruveo network', 'Chain 1490 marketplace connectivity', () =>
            checkRpc(rpcTargets.vitruveo, 1490)),
    ]);

    const api = {
        id: 'api',
        label: 'BlockDust API',
        detail: 'Customer API and marketplace services',
        ok: true,
        latencyMs: Math.max(0, Math.round(performance.now() - requestStarted)),
    };
    const services = [api, database, hyve, vitruveo];
    const healthyCount = services.filter((service) => service.ok).length;
    const ok = healthyCount === services.length;

    return {
        ok,
        db: database.ok,
        status: ok ? 'operational' : healthyCount > 0 ? 'degraded' : 'outage',
        timestamp: new Date().toISOString(),
        startedAt: new Date(PROCESS_STARTED_AT).toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        version: packageInfo.version,
        services,
    };
}

function serviceCard(service) {
    return `
        <article class="service-card" data-service="${service.id}">
            <div class="service-icon" aria-hidden="true">
                <span></span>
            </div>
            <div class="service-copy">
                <h3>${service.label}</h3>
                <p>${service.detail}</p>
            </div>
            <div class="service-metric">
                <strong class="service-state ${service.ok ? 'is-up' : 'is-down'}">${service.ok ? 'Operational' : 'Degraded'}</strong>
                <span class="latency">${service.latencyMs} ms</span>
            </div>
        </article>`;
}

function renderHealthPage(snapshot) {
    const isOperational = snapshot.status === 'operational';
    const initialJson = JSON.stringify(snapshot).replace(/</g, '\\u003c');
    const statusTitle = isOperational ? 'All systems operational' : 'Some systems are degraded';
    const statusCopy = isOperational
        ? 'BlockDust is online and every monitored service is responding normally.'
        : 'BlockDust is online, but one or more dependencies are responding abnormally.';

    return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Live operational status for the BlockDust NFT marketplace, API, database, and supported networks.">
    <meta name="color-scheme" content="dark light">
    <title>BlockDust Status</title>
    <script>
        try {
            const saved = localStorage.getItem('theme');
            const theme = saved === 'light' || saved === 'dark'
                ? saved
                : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
            document.documentElement.dataset.theme = theme;
        } catch {}
    </script>
    <style>
        :root {
            color-scheme: dark;
            --bg: #07090f;
            --surface: rgba(18, 23, 34, .78);
            --surface-solid: #111722;
            --surface-raised: #171e2b;
            --text: #f1f5fb;
            --muted: #929daf;
            --faint: #657186;
            --border: rgba(156, 174, 205, .14);
            --border-strong: rgba(156, 174, 205, .24);
            --green: #27e7a1;
            --green-rgb: 39, 231, 161;
            --cyan: #39d6ed;
            --purple: #8a6cff;
            --amber: #ffbd52;
            --red: #ff6680;
            --shadow: 0 26px 80px rgba(0, 0, 0, .34);
        }
        :root[data-theme="light"] {
            color-scheme: light;
            --bg: #f4f7fb;
            --surface: rgba(255, 255, 255, .84);
            --surface-solid: #ffffff;
            --surface-raised: #f3f6fa;
            --text: #172033;
            --muted: #59657a;
            --faint: #7a869a;
            --border: rgba(31, 48, 78, .12);
            --border-strong: rgba(31, 48, 78, .2);
            --green: #087f5b;
            --green-rgb: 8, 127, 91;
            --cyan: #087f98;
            --purple: #6346d8;
            --amber: #9c6500;
            --red: #c3314d;
            --shadow: 0 26px 70px rgba(39, 54, 82, .12);
        }
        * { box-sizing: border-box; }
        html { min-width: 320px; background: var(--bg); }
        body {
            min-height: 100vh;
            margin: 0;
            color: var(--text);
            background:
                radial-gradient(900px 480px at 12% -8%, rgba(98, 74, 220, .16), transparent 68%),
                radial-gradient(800px 460px at 94% 12%, rgba(31, 201, 170, .12), transparent 70%),
                var(--bg);
            font: 15px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            -webkit-font-smoothing: antialiased;
        }
        body::before {
            content: "";
            position: fixed;
            inset: 0;
            z-index: -1;
            opacity: .3;
            background-image:
                linear-gradient(var(--border) 1px, transparent 1px),
                linear-gradient(90deg, var(--border) 1px, transparent 1px);
            background-size: 48px 48px;
            mask-image: linear-gradient(to bottom, black, transparent 55%);
            pointer-events: none;
        }
        a { color: inherit; }
        button { font: inherit; }
        .shell { width: min(1080px, calc(100% - 40px)); margin: 0 auto; }
        .site-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 82px;
            border-bottom: 1px solid var(--border);
        }
        .brand {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
        }
        .brand-mark {
            display: grid;
            place-items: center;
            width: 38px;
            height: 38px;
            border: 1px solid rgba(var(--green-rgb), .35);
            border-radius: 12px;
            color: var(--green);
            background: linear-gradient(145deg, rgba(var(--green-rgb), .14), rgba(138, 108, 255, .15));
            box-shadow: inset 0 0 18px rgba(var(--green-rgb), .08), 0 0 24px rgba(var(--green-rgb), .08);
            font-size: 13px;
            font-weight: 850;
            letter-spacing: -.06em;
        }
        .brand-name { display: block; font-size: 16px; font-weight: 760; letter-spacing: -.01em; }
        .brand-sub { display: block; color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
        .header-actions { display: flex; align-items: center; gap: 9px; }
        .back-link, .theme-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 38px;
            border: 1px solid var(--border);
            border-radius: 10px;
            color: var(--muted);
            background: var(--surface);
            text-decoration: none;
            cursor: pointer;
            transition: 160ms ease;
        }
        .back-link { padding: 0 14px; }
        .theme-toggle { width: 38px; padding: 0; }
        .back-link:hover, .theme-toggle:hover {
            border-color: var(--border-strong);
            color: var(--text);
            transform: translateY(-1px);
        }
        main { padding: clamp(54px, 8vw, 92px) 0 58px; }
        .eyebrow {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 18px;
            color: var(--muted);
            font-size: 12px;
            font-weight: 700;
            letter-spacing: .12em;
            text-transform: uppercase;
        }
        .live-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--green);
            box-shadow: 0 0 0 0 rgba(var(--green-rgb), .4);
            animation: pulse 2.4s ease-out infinite;
        }
        .hero {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            align-items: end;
            gap: 30px;
            margin-bottom: 36px;
        }
        h1 {
            max-width: 720px;
            margin: 0;
            font-size: clamp(38px, 6vw, 68px);
            line-height: .98;
            letter-spacing: -.055em;
        }
        .hero-copy {
            max-width: 650px;
            margin: 20px 0 0;
            color: var(--muted);
            font-size: clamp(16px, 2vw, 19px);
        }
        .overall-badge {
            display: inline-flex;
            align-items: center;
            gap: 9px;
            padding: 10px 14px;
            border: 1px solid rgba(var(--green-rgb), .3);
            border-radius: 999px;
            color: var(--green);
            background: rgba(var(--green-rgb), .08);
            font-size: 13px;
            font-weight: 750;
            white-space: nowrap;
        }
        .overall-badge.is-degraded {
            border-color: color-mix(in srgb, var(--amber) 35%, transparent);
            color: var(--amber);
            background: color-mix(in srgb, var(--amber) 9%, transparent);
        }
        .status-panel {
            position: relative;
            padding: clamp(22px, 4vw, 34px);
            overflow: hidden;
            border: 1px solid var(--border);
            border-radius: 24px;
            background: var(--surface);
            box-shadow: var(--shadow);
            backdrop-filter: blur(18px);
        }
        .status-panel::after {
            content: "";
            position: absolute;
            inset: 0 auto 0 0;
            width: 3px;
            background: linear-gradient(var(--green), var(--cyan));
        }
        .panel-heading {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 20px;
            margin-bottom: 12px;
        }
        .panel-heading h2 { margin: 0; font-size: 20px; letter-spacing: -.02em; }
        .last-checked { color: var(--faint); font-size: 12px; white-space: nowrap; }
        .services { display: grid; gap: 1px; margin-top: 22px; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: var(--border); }
        .service-card {
            display: grid;
            grid-template-columns: 38px minmax(0, 1fr) auto;
            align-items: center;
            gap: 14px;
            min-height: 88px;
            padding: 17px 20px;
            background: var(--surface-solid);
        }
        .service-icon {
            display: grid;
            place-items: center;
            width: 36px;
            height: 36px;
            border: 1px solid rgba(var(--green-rgb), .22);
            border-radius: 11px;
            background: rgba(var(--green-rgb), .07);
        }
        .service-icon span {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--green);
            box-shadow: 0 0 14px rgba(var(--green-rgb), .65);
        }
        .service-card.is-down .service-icon { border-color: color-mix(in srgb, var(--red) 25%, transparent); background: color-mix(in srgb, var(--red) 8%, transparent); }
        .service-card.is-down .service-icon span { background: var(--red); box-shadow: 0 0 14px color-mix(in srgb, var(--red) 60%, transparent); }
        .service-copy h3 { margin: 0 0 2px; font-size: 15px; letter-spacing: -.01em; }
        .service-copy p { margin: 0; color: var(--muted); font-size: 13px; }
        .service-metric { display: grid; justify-items: end; gap: 3px; }
        .service-state { color: var(--green); font-size: 13px; }
        .service-state.is-down { color: var(--red); }
        .latency { color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
        .meta-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 14px;
            margin-top: 14px;
        }
        .meta-card {
            padding: 18px 20px;
            border: 1px solid var(--border);
            border-radius: 15px;
            background: var(--surface);
        }
        .meta-card span { display: block; color: var(--faint); font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
        .meta-card strong { display: block; margin-top: 7px; font-size: 16px; font-variant-numeric: tabular-nums; }
        .incident {
            display: flex;
            align-items: flex-start;
            gap: 14px;
            margin-top: 14px;
            padding: 20px;
            border: 1px solid var(--border);
            border-radius: 15px;
            background: var(--surface);
        }
        .incident-mark {
            display: grid;
            place-items: center;
            flex: 0 0 auto;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            color: var(--green);
            background: rgba(var(--green-rgb), .1);
            font-weight: 900;
        }
        .incident h2 { margin: 1px 0 3px; font-size: 15px; }
        .incident p { margin: 0; color: var(--muted); font-size: 13px; }
        footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 20px;
            padding: 25px 0 38px;
            border-top: 1px solid var(--border);
            color: var(--faint);
            font-size: 12px;
        }
        footer nav { display: flex; gap: 18px; }
        footer a { text-decoration: none; }
        footer a:hover { color: var(--text); }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
        @keyframes pulse {
            0% { box-shadow: 0 0 0 0 rgba(var(--green-rgb), .4); }
            65%, 100% { box-shadow: 0 0 0 9px rgba(var(--green-rgb), 0); }
        }
        @media (max-width: 700px) {
            .shell { width: min(100% - 28px, 1080px); }
            .back-link { display: none; }
            .hero { grid-template-columns: 1fr; align-items: start; }
            .overall-badge { width: fit-content; }
            .panel-heading { align-items: flex-start; flex-direction: column; gap: 4px; }
            .service-card { grid-template-columns: 34px minmax(0, 1fr); padding: 15px; }
            .service-metric { grid-column: 2; justify-items: start; grid-auto-flow: column; gap: 8px; }
            .meta-grid { grid-template-columns: 1fr; }
            footer { align-items: flex-start; flex-direction: column; }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
        }
    </style>
</head>
<body>
    <header class="shell site-header">
        <a class="brand" href="/" aria-label="Return to BlockDust marketplace">
            <span class="brand-mark" aria-hidden="true">BD</span>
            <span>
                <span class="brand-name">BlockDust</span>
                <span class="brand-sub">System status</span>
            </span>
        </a>
        <div class="header-actions">
            <a class="back-link" href="/">Back to marketplace</a>
            <button class="theme-toggle" type="button" aria-label="Toggle color theme" title="Toggle color theme"><span aria-hidden="true">◐</span></button>
        </div>
    </header>

    <main class="shell">
        <div class="eyebrow"><span class="live-dot" aria-hidden="true"></span>Live service health</div>
        <section class="hero" aria-labelledby="page-title">
            <div>
                <h1 id="page-title">${statusTitle}</h1>
                <p class="hero-copy">${statusCopy}</p>
            </div>
            <div class="overall-badge ${isOperational ? '' : 'is-degraded'}" role="status">
                <span aria-hidden="true">${isOperational ? '✓' : '!'}</span>
                <span class="overall-label">${isOperational ? 'Operational' : 'Degraded performance'}</span>
            </div>
        </section>

        <section class="status-panel" aria-labelledby="services-heading">
            <div class="panel-heading">
                <h2 id="services-heading">Service availability</h2>
                <span class="last-checked">Checked <time datetime="${snapshot.timestamp}">just now</time></span>
            </div>
            <div class="services">${snapshot.services.map(serviceCard).join('')}</div>
        </section>

        <section class="meta-grid" aria-label="Runtime details">
            <div class="meta-card"><span>API version</span><strong>v${snapshot.version}</strong></div>
            <div class="meta-card"><span>Current uptime</span><strong id="uptime">${formatDuration(snapshot.uptimeSeconds)}</strong></div>
            <div class="meta-card"><span>Automatic refresh</span><strong>Every 30 seconds</strong></div>
        </section>

        <section class="incident" aria-labelledby="incident-title">
            <div class="incident-mark" aria-hidden="true">${isOperational ? '✓' : '!'}</div>
            <div>
                <h2 id="incident-title">${isOperational ? 'No active incidents' : 'Service degradation detected'}</h2>
                <p id="incident-copy">${isOperational ? 'There are no active incidents affecting BlockDust services.' : 'Our live checks detected a service that needs attention. This page will update automatically.'}</p>
            </div>
        </section>
    </main>

    <footer class="shell">
        <span>© ${new Date().getFullYear()} BlockDust · Live infrastructure status</span>
        <nav aria-label="Status page links">
            <a href="/api/health?format=json">JSON API</a>
            <a href="/">Marketplace</a>
        </nav>
    </footer>

    <script>
        const initialStatus = ${initialJson};
        const state = { lastTimestamp: initialStatus.timestamp };
        const $ = (selector, root = document) => root.querySelector(selector);

        function duration(totalSeconds) {
            const seconds = Math.max(0, Math.floor(totalSeconds));
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            if (days) return days + 'd ' + hours + 'h';
            if (hours) return hours + 'h ' + minutes + 'm';
            if (minutes) return minutes + 'm';
            return seconds + 's';
        }

        function update(snapshot) {
            const operational = snapshot.status === 'operational';
            state.lastTimestamp = snapshot.timestamp;
            $('#page-title').textContent = operational ? 'All systems operational' : 'Some systems are degraded';
            $('.hero-copy').textContent = operational
                ? 'BlockDust is online and every monitored service is responding normally.'
                : 'BlockDust is online, but one or more dependencies are responding abnormally.';
            const badge = $('.overall-badge');
            badge.classList.toggle('is-degraded', !operational);
            $('.overall-label', badge).textContent = operational ? 'Operational' : 'Degraded performance';

            snapshot.services.forEach((service) => {
                const card = document.querySelector('[data-service="' + service.id + '"]');
                if (!card) return;
                card.classList.toggle('is-down', !service.ok);
                const label = $('.service-state', card);
                label.textContent = service.ok ? 'Operational' : 'Degraded';
                label.className = 'service-state ' + (service.ok ? 'is-up' : 'is-down');
                $('.latency', card).textContent = service.latencyMs + ' ms';
            });

            const incidentMark = $('.incident-mark');
            incidentMark.textContent = operational ? '✓' : '!';
            $('#incident-title').textContent = operational ? 'No active incidents' : 'Service degradation detected';
            $('#incident-copy').textContent = operational
                ? 'There are no active incidents affecting BlockDust services.'
                : 'Our live checks detected a service that needs attention. This page will update automatically.';
            $('#uptime').textContent = duration(snapshot.uptimeSeconds);
            const time = $('.last-checked time');
            time.dateTime = snapshot.timestamp;
            time.textContent = 'just now';
        }

        async function refresh() {
            try {
                const response = await fetch('/api/health?format=json', {
                    headers: { accept: 'application/json' },
                    cache: 'no-store'
                });
                if (!response.ok) throw new Error('Health request failed');
                update(await response.json());
            } catch {
                $('.last-checked time').textContent = 'refresh unavailable';
            }
        }

        $('.theme-toggle').addEventListener('click', () => {
            const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
            document.documentElement.dataset.theme = next;
            try { localStorage.setItem('theme', next); } catch {}
        });

        setInterval(refresh, 30000);
        setInterval(() => {
            const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(state.lastTimestamp)) / 1000));
            $('.last-checked time').textContent = elapsed < 5 ? 'just now' : elapsed + 's ago';
        }, 1000);
    </script>
</body>
</html>`;
}

module.exports = { collectHealthSnapshot, renderHealthPage, formatDuration };
