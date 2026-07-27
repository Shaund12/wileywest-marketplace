/**
 * BlockDust backend — the self-hosted replacement for Supabase + Vercel.
 *
 * Responsibilities:
 *   1. Serve the built SPA from ../dist (SPA fallback to index.html).
 *   2. Expose the ported Vercel serverless routes under /api/* so the
 *      frontend's relative fetch('/api/...') calls resolve here (this is what
 *      fixes the 405s that happened under plain nginx).
 *   3. Expose the PostgREST-lite data API under /api/db used by the frontend
 *      pgRestClient shim (replaces browser → Supabase access).
 *   4. Run the former Vercel crons as internal setInterval loops, so no
 *      external cron pinging is needed:
 *        - sync-listings           every 5 min   (vercel.json every-5)
 *        - sync-user-collections   (on-demand only; nothing to schedule
 *                                    without a wallet, matching the original
 *                                    handler which no-ops without a wallet)
 *        - prewarm-cache queue     every 2 min   (vercel.json every-2)
 *
 * Env:
 *   PORT                     default 8787
 *   DATABASE_URL             pg DSN (default → local blockdust db, see pgClient)
 *   VITE_RPC_URL             chain RPC (default https://rpc.vitruveo.xyz)
 *   VITE_MARKETPLACE_ADDRESS marketplace contract (required for sync crons)
 *   ENABLE_CRONS             set to "false" to disable the internal intervals
 */

const path = require('path');
const { Readable } = require('stream');
const express = require('express');
const cors = require('cors');
const sharp = require('sharp');

const { healthCheck } = require('./db/pgClient');
const dbRouter = require('./routes/db');
const { corsOptions, rateLimit, securityHeaders } = require('./middleware/security');

// Ported serverless handlers (Vercel (req,res) signature → Express compatible)
const syncListings = require('./api/sync-listings');
const syncUserCollections = require('./api/sync-user-collections');
const instantSync = require('./api/instant-sync');
const metadataCache = require('./api/metadata-cache');
const imageProxy = require('./api/image-proxy');
const prewarmCache = require('./api/prewarm-cache');
const cacheMetrics = require('./api/cache-metrics');
const explorer = require('./api/explorer');
const { collectHealthSnapshot, renderHealthPage } = require('./healthPage');

const app = express();
const PORT = parseInt(process.env.PORT || '8787', 10);

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(securityHeaders);
app.use(cors(corsOptions()));
app.use('/api', rateLimit({ windowMs: 60_000, max: 300, name: 'api' }));
app.use('/api/rpc', rateLimit({ windowMs: 60_000, max: 120, name: 'rpc' }));
app.use('/api/ipfs', rateLimit({ windowMs: 60_000, max: 120, name: 'ipfs' }));
app.use('/api/media', rateLimit({ windowMs: 60_000, max: 120, name: 'media' }));
app.use('/api/db', rateLimit({ windowMs: 60_000, max: 120, name: 'database' }));
app.use('/api/metadata-cache', rateLimit({ windowMs: 60_000, max: 30, name: 'metadata-cache' }));
app.use('/api/image-proxy', rateLimit({ windowMs: 60_000, max: 60, name: 'image-proxy' }));
app.use('/api/prewarm-cache', rateLimit({ windowMs: 60_000, max: 20, name: 'prewarm' }));
app.use('/api/cache-metrics', rateLimit({ windowMs: 60_000, max: 30, name: 'cache-metrics' }));
app.use('/api/explorer', rateLimit({ windowMs: 60_000, max: 90, name: 'explorer' }));
app.use('/api/instant-sync', rateLimit({ windowMs: 60_000, max: 10, name: 'instant-sync' }));
app.use(express.json({ limit: '256kb', strict: true }));
app.use('/api/sync-user-collections', rateLimit({
    windowMs: 10 * 60_000,
    max: 6,
    name: 'collection-sync',
    keyFn: (req) => `${req.ip}:${String(req.body?.walletAddress || '').toLowerCase()}`,
}));

const RPC_TARGETS = Object.freeze({
    hyve: process.env.HYVE_RPC_URL || 'https://rpc.hyvechain.com',
    // VITE_RPC_URL is the backend's active marketplace chain (Hyve in
    // production), so it must not be reused as the Vitruveo endpoint.
    vitruveo: process.env.VITRUVEO_RPC_URL || 'https://rpc.vitruveo.ai',
});
const RPC_READ_FALLBACKS = Object.freeze({
    hyve: ['https://explorer.hyvechain.com/api/eth-rpc'],
    vitruveo: ['https://explorer.vitruveo.ai/api/eth-rpc'],
});
const RPC_METHODS = new Set([
    'eth_blockNumber',
    'eth_call',
    'eth_chainId',
    'eth_estimateGas',
    'eth_feeHistory',
    'eth_gasPrice',
    'eth_getBalance',
    'eth_getBlockByHash',
    'eth_getBlockByNumber',
    'eth_getCode',
    'eth_getLogs',
    'eth_getStorageAt',
    'eth_getTransactionByHash',
    'eth_getTransactionCount',
    'eth_getTransactionReceipt',
    'eth_maxPriorityFeePerGas',
    'eth_sendRawTransaction',
    'net_version',
]);
const RPC_MUTATIONS = new Set(['eth_sendRawTransaction']);
const rpcCache = new Map();
const rpcInFlight = new Map();

const IPFS_GATEWAYS = Object.freeze({
    ipfs: ['https://dweb.link/ipfs/', 'https://ipfs.io/ipfs/'],
    ipns: ['https://dweb.link/ipns/', 'https://ipfs.io/ipns/'],
});

const isReadOnlyRpcBody = (body) => {
    const calls = Array.isArray(body) ? body : [body];
    return calls.length > 0 && calls.every(({ method } = {}) => !RPC_MUTATIONS.has(method));
};

function validateRpcBody(body) {
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > 20) return 'RPC batch size must be between 1 and 20';
    for (const call of calls) {
        if (!call || call.jsonrpc !== '2.0' || !RPC_METHODS.has(call.method)) {
            return `RPC method not allowed: ${call?.method || 'invalid request'}`;
        }
        if (call.params !== undefined && !Array.isArray(call.params)) return 'RPC params must be an array';
    }
    return null;
}

function rpcCacheTtl(method) {
    if (['eth_chainId', 'net_version', 'eth_getCode'].includes(method)) return 60 * 60_000;
    if (method === 'eth_blockNumber') return 1_500;
    if (['eth_call', 'eth_getBalance', 'eth_getTransactionCount', 'eth_gasPrice', 'eth_maxPriorityFeePerGas'].includes(method)) return 3_000;
    if (['eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getTransactionByHash'].includes(method)) return 5_000;
    if (method === 'eth_getTransactionReceipt') return 4_000;
    if (method === 'eth_getLogs') return 10_000;
    return 0;
}

function rpcCacheKey(chain, call) {
    return `${chain}:${call.method}:${JSON.stringify(call.params || [])}`;
}

function withRequestId(rawBody, id) {
    try {
        const parsed = JSON.parse(rawBody);
        if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') parsed.id = id;
        return JSON.stringify(parsed);
    } catch {
        return rawBody;
    }
}

function setRpcCache(key, value, ttl) {
    if (!ttl) return;
    if (rpcCache.size >= 2_000) rpcCache.delete(rpcCache.keys().next().value);
    rpcCache.set(key, { value, expiresAt: Date.now() + ttl });
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    const snapshot = await collectHealthSnapshot({ healthCheck, rpcTargets: RPC_TARGETS });
    res.set('Cache-Control', 'no-store, max-age=0');

    const wantsHtml = req.query.format !== 'json' && req.accepts(['html', 'json']) === 'html';
    if (!wantsHtml) return res.json(snapshot);

    res.set({
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
    });
    return res.type('html').send(renderHealthPage(snapshot));
});

// ── Browser-safe RPC proxy ────────────────────────────────────────────────
// Hyve's public RPC does not return browser CORS headers. Keep the upstream
// whitelist server-side so this cannot be turned into an open proxy.
app.post('/api/rpc/:chain', async (req, res) => {
    const target = RPC_TARGETS[req.params.chain];
    if (!target) return res.status(404).json({ error: 'Unsupported chain' });
    const validationError = validateRpcBody(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const readOnly = isReadOnlyRpcBody(req.body);
    const targets = readOnly ? [target, ...(RPC_READ_FALLBACKS[req.params.chain] || [])] : [target];
    const singleCall = !Array.isArray(req.body) ? req.body : null;
    const ttl = singleCall && readOnly ? rpcCacheTtl(singleCall.method) : 0;
    const cacheKey = ttl ? rpcCacheKey(req.params.chain, singleCall) : null;

    if (cacheKey) {
        const cached = rpcCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            res.set('X-BlockDust-RPC-Cache', 'HIT');
            return res.status(cached.value.status)
                .type(cached.value.type)
                .send(withRequestId(cached.value.body, singleCall.id));
        }
        if (cached) rpcCache.delete(cacheKey);
    }

    const execute = async () => {
        let lastError = null;
        for (const rpcUrl of targets) {
            try {
                const upstream = await fetchWithTimeout(rpcUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify(req.body),
                }, readOnly ? 7_000 : 15_000);
                const body = await upstream.text();
                if (!upstream.ok && rpcUrl !== targets.at(-1)) {
                    lastError = new Error(`Upstream returned HTTP ${upstream.status}`);
                    continue;
                }
                return {
                    status: upstream.status,
                    type: upstream.headers.get('content-type') || 'application/json',
                    body,
                };
            } catch (error) {
                lastError = error;
            }
        }
        const error = new Error(lastError?.name === 'AbortError' ? 'All RPC endpoints timed out' : lastError?.message);
        error.status = 502;
        throw error;
    };

    let promise = cacheKey ? rpcInFlight.get(cacheKey) : null;
    const coalesced = !!promise;
    if (!promise) {
        promise = execute();
        if (cacheKey) {
            rpcInFlight.set(cacheKey, promise);
            promise.finally(() => rpcInFlight.delete(cacheKey)).catch(() => undefined);
        }
    }

    try {
        const result = await promise;
        if (cacheKey && result.status === 200) setRpcCache(cacheKey, result, ttl);
        res.set('X-BlockDust-RPC-Cache', coalesced ? 'COALESCED' : 'MISS');
        return res.status(result.status)
            .type(result.type)
            .send(singleCall ? withRequestId(result.body, singleCall.id) : result.body);
    } catch (error) {
        return res.status(error.status || 502).json({
            error: 'RPC upstream unavailable',
            detail: error.message,
        });
    }
});

// Same-origin IPFS/IPNS gateway failover. Browser-side gateway rotation creates
// noisy DNS/CORS errors and exposes availability differences to customers.
app.get('/api/ipfs/:namespace/*', async (req, res) => {
    const gateways = IPFS_GATEWAYS[req.params.namespace];
    const resource = req.params[0];
    if (!gateways || !resource || resource.includes('..') || /[\s\\]/.test(resource)) {
        return res.status(400).json({ error: 'Invalid IPFS resource' });
    }

    const safePath = resource.split('/').map(encodeURIComponent).join('/');
    let lastError = null;
    for (const gateway of gateways) {
        try {
            const upstream = await fetchWithTimeout(`${gateway}${safePath}`, {
                headers: { accept: req.get('accept') || '*/*' },
                redirect: 'follow',
            }, 10_000);
            if (!upstream.ok || !upstream.body) {
                lastError = new Error(`Gateway returned HTTP ${upstream.status}`);
                continue;
            }
            res.status(200);
            res.set({
                'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
                'Cache-Control': req.params.namespace === 'ipfs'
                    ? 'public, max-age=31536000, immutable'
                    : 'public, max-age=300, stale-while-revalidate=3600',
                'X-Content-Type-Options': 'nosniff',
            });
            return Readable.fromWeb(upstream.body).pipe(res);
        } catch (error) {
            lastError = error;
        }
    }
    return res.status(502).json({
        error: 'IPFS resource unavailable',
        detail: lastError?.name === 'AbortError' ? 'All IPFS gateways timed out' : lastError?.message,
    });
});

// CID-addressed responsive thumbnails. Grid cards should not transfer a
// multi-megabyte original merely to display a few hundred CSS pixels.
app.get('/api/media/:width/:namespace/*', async (req, res) => {
    const width = Number(req.params.width);
    const gateways = IPFS_GATEWAYS[req.params.namespace];
    const resource = req.params[0];
    if (![240, 400, 640, 960].includes(width)
        || !gateways
        || !resource
        || resource.includes('..')
        || /[\s\\]/.test(resource)) {
        return res.status(400).json({ error: 'Invalid media request' });
    }

    const safePath = resource.split('/').map(encodeURIComponent).join('/');
    let lastError = null;
    for (const gateway of gateways) {
        try {
            const upstream = await fetchWithTimeout(`${gateway}${safePath}`, {
                headers: { accept: 'image/*' },
                redirect: 'follow',
            }, 10_000);
            if (!upstream.ok) {
                lastError = new Error(`Gateway returned HTTP ${upstream.status}`);
                continue;
            }
            const declaredSize = Number(upstream.headers.get('content-length') || 0);
            if (declaredSize > 25 * 1024 * 1024) throw new Error('Source image is too large');
            const source = Buffer.from(await upstream.arrayBuffer());
            if (source.length > 25 * 1024 * 1024) throw new Error('Source image is too large');
            const output = await sharp(source, {
                failOn: 'error',
                limitInputPixels: 40_000_000,
                animated: false,
            })
                .rotate()
                .resize({ width, withoutEnlargement: true })
                .webp({ quality: 78, effort: 4 })
                .toBuffer();
            res.set({
                'Content-Type': 'image/webp',
                'Content-Length': String(output.length),
                'Cache-Control': req.params.namespace === 'ipfs'
                    ? 'public, max-age=31536000, immutable'
                    : 'public, max-age=300, stale-while-revalidate=3600',
                'X-Content-Type-Options': 'nosniff',
            });
            return res.status(200).send(output);
        } catch (error) {
            lastError = error;
        }
    }
    return res.status(502).json({
        error: 'NFT thumbnail unavailable',
        detail: lastError?.name === 'AbortError' ? 'All media gateways timed out' : lastError?.message,
    });
});

// ── Data API (frontend pgRestClient) ───────────────────────────────────────
app.use('/api/db', dbRouter);

// ── Ported serverless routes ───────────────────────────────────────────────
app.all('/api/sync-listings', (req, res) => syncListings(req, res));
app.all('/api/sync-user-collections', (req, res) => syncUserCollections(req, res));
app.all('/api/instant-sync', (req, res) => instantSync(req, res));
app.get('/api/metadata-cache', (req, res) => metadataCache(req, res));
app.get('/api/image-proxy', (req, res) => imageProxy(req, res));
app.all('/api/prewarm-cache', (req, res) => prewarmCache(req, res));
app.get('/api/cache-metrics', (req, res) => cacheMetrics(req, res));

// Blockscout-backed chain exploration. Read-only, allowlisted upstreams,
// server-side cached — see backend/api/explorer.js for why this is proxied.
app.get('/api/explorer/:chain/collections', (req, res) => explorer(req, res));
app.get('/api/explorer/:chain/collections/:address', (req, res) => explorer(req, res));
app.get('/api/explorer/:chain/collections/:address/instances', (req, res) => {
    req.params.section = 'instances';
    return explorer(req, res);
});

// ── Static SPA + fallback ──────────────────────────────────────────────────
const distDir = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distDir));
// SPA fallback: any non-/api GET returns index.html (mirrors vercel.json rewrite)
app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
        if (err) res.status(404).send('Build not found. Run `npm run build` first.');
    });
});

// ── Internal crons (replaces vercel.json crons) ────────────────────────────
function startCrons() {
    if (process.env.ENABLE_CRONS === 'false') {
        console.log('⏸  Internal crons disabled (ENABLE_CRONS=false)');
        return;
    }
    const hasMarketplace = process.env.VITE_MARKETPLACE_ADDRESS &&
        process.env.VITE_MARKETPLACE_ADDRESS !== '0x0000000000000000000000000000000000000000';

    // sync-listings every 5 minutes (lite mode, like the cron path did)
    if (hasMarketplace) {
        const runSync = async () => {
            try {
                const stats = await syncListings.syncListings({ liteSync: true });
                console.log(`[cron sync-listings] upserted=${stats.upserted} canceled=${stats.canceled} block=${stats.effectiveToBlock}`);
            } catch (e) { console.warn('[cron sync-listings] failed:', e.message); }
        };
        setInterval(runSync, 5 * 60 * 1000);
        setTimeout(runSync, 15 * 1000); // kick once shortly after boot
    } else {
        console.log('ℹ️  VITE_MARKETPLACE_ADDRESS not set — skipping sync-listings cron');
    }

    // prewarm-cache queue every 2 minutes
    const runPrewarm = async () => {
        try {
            const stats = await prewarmCache.processPrewarmQueue();
            if (stats.processed) console.log(`[cron prewarm] processed=${stats.processed} ok=${stats.successful} fail=${stats.failed}`);
        } catch (e) { console.warn('[cron prewarm] failed:', e.message); }
    };
    setInterval(runPrewarm, 2 * 60 * 1000);
}

app.listen(PORT, () => {
    console.log(`🚀 BlockDust backend listening on http://127.0.0.1:${PORT}`);
    console.log(`   Serving SPA from: ${distDir}`);
    healthCheck().then((ok) => console.log(`   Postgres: ${ok ? 'connected ✅' : 'NOT reachable ❌ (set DATABASE_URL / create db)'}`));
    startCrons();
});

module.exports = app;
