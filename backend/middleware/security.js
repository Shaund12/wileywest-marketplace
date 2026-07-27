const DEFAULT_ORIGINS = ['https://blockdust.pyvendr.com'];

function parseOrigins() {
    const configured = String(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return new Set(configured.length ? configured : DEFAULT_ORIGINS);
}

function securityHeaders(req, res, next) {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
        'Cross-Origin-Resource-Policy': 'same-site',
    });
    next();
}

function corsOptions() {
    const allowed = parseOrigins();
    return {
        credentials: false,
        methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Accept'],
        maxAge: 86400,
        origin(origin, callback) {
            // Non-browser callers do not send Origin. Browser callers must be
            // the deployed app (plus explicitly configured staging origins).
            if (!origin || allowed.has(origin)) return callback(null, true);
            return callback(null, false);
        },
    };
}

const buckets = new Map();
let lastSweep = 0;

function sweepExpired(now) {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}

function rateLimit({ windowMs, max, name, keyFn }) {
    return (req, res, next) => {
        const now = Date.now();
        sweepExpired(now);
        const subject = keyFn ? keyFn(req) : req.ip;
        const key = `${name}:${subject || 'unknown'}`;
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;

        const remaining = Math.max(0, max - bucket.count);
        const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.set({
            'RateLimit-Limit': String(max),
            'RateLimit-Remaining': String(remaining),
            'RateLimit-Reset': String(resetSeconds),
        });
        if (bucket.count > max) {
            res.set('Retry-After', String(resetSeconds));
            return res.status(429).json({
                error: 'Too many requests',
                retryAfterSeconds: resetSeconds,
            });
        }
        return next();
    };
}

module.exports = { corsOptions, rateLimit, securityHeaders };
