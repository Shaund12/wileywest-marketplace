/**
 * backend/middleware/security.js — CORS origin policy, rate limiting, and the
 * standard security headers. These run in front of every /api route, so a
 * regression here is silently exploitable.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, '../../backend/package.json'));
const SECURITY = path.resolve(here, '../../backend/middleware/security.js');

/** Re-require the module so its in-memory rate-limit buckets start empty. */
function freshSecurity() {
    delete require.cache[SECURITY];
    return require(SECURITY);
}

describe('securityHeaders', () => {
    it('sets the hardening headers on every response', async () => {
        const express = require('express');
        const { securityHeaders } = freshSecurity();
        const app = express();
        app.use(securityHeaders);
        app.get('/x', (_req, res) => res.json({ ok: true }));

        const res = await request(app).get('/x');

        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
        // Powerful browser features are denied wholesale — this is a wallet app.
        expect(res.headers['permissions-policy']).toContain('camera=()');
        expect(res.headers['permissions-policy']).toContain('payment=()');
    });
});

describe('corsOptions', () => {
    const originalEnv = process.env.ALLOWED_ORIGINS;
    afterEach(() => {
        if (originalEnv === undefined) delete process.env.ALLOWED_ORIGINS;
        else process.env.ALLOWED_ORIGINS = originalEnv;
    });

    const decide = (corsOptions, origin) =>
        new Promise((resolve) => corsOptions().origin(origin, (_err, allow) => resolve(allow)));

    it('allows the default production origin', async () => {
        delete process.env.ALLOWED_ORIGINS;
        const { corsOptions } = freshSecurity();
        expect(await decide(corsOptions, 'https://blockdust.pyvendr.com')).toBe(true);
    });

    it('rejects an unknown origin', async () => {
        delete process.env.ALLOWED_ORIGINS;
        const { corsOptions } = freshSecurity();
        expect(await decide(corsOptions, 'https://evil.example')).toBe(false);
    });

    it('allows requests with no Origin header (non-browser callers)', async () => {
        delete process.env.ALLOWED_ORIGINS;
        const { corsOptions } = freshSecurity();
        expect(await decide(corsOptions, undefined)).toBe(true);
    });

    it('honours ALLOWED_ORIGINS and replaces the default when set', async () => {
        process.env.ALLOWED_ORIGINS = 'https://staging.example, https://qa.example';
        const { corsOptions } = freshSecurity();

        expect(await decide(corsOptions, 'https://staging.example')).toBe(true);
        expect(await decide(corsOptions, 'https://qa.example')).toBe(true);
        // Configuring origins overrides rather than extends the default list.
        expect(await decide(corsOptions, 'https://blockdust.pyvendr.com')).toBe(false);
    });

    it('restricts methods and headers to what the app actually uses', () => {
        delete process.env.ALLOWED_ORIGINS;
        const { corsOptions } = freshSecurity();
        const opts = corsOptions();

        expect(opts.methods).toEqual(['GET', 'HEAD', 'POST', 'OPTIONS']);
        expect(opts.methods).not.toContain('DELETE');
        expect(opts.credentials).toBe(false);
    });
});

describe('rateLimit', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function appWith(opts) {
        const express = require('express');
        const { rateLimit } = freshSecurity();
        const app = express();
        app.use(express.json());
        app.use(rateLimit(opts));
        app.get('/x', (_req, res) => res.json({ ok: true }));
        app.post('/x', (_req, res) => res.json({ ok: true }));
        return app;
    }

    it('permits requests up to the limit and blocks the next one', async () => {
        const app = appWith({ windowMs: 60_000, max: 3, name: 'test' });

        for (let i = 1; i <= 3; i += 1) {
            const res = await request(app).get('/x');
            expect(res.status, `request ${i}`).toBe(200);
            expect(res.headers['ratelimit-remaining']).toBe(String(3 - i));
        }

        const blocked = await request(app).get('/x');
        expect(blocked.status).toBe(429);
        expect(blocked.body.error).toBe('Too many requests');
        expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('advertises the limit in RateLimit-* headers', async () => {
        const app = appWith({ windowMs: 60_000, max: 10, name: 'hdr' });
        const res = await request(app).get('/x');

        expect(res.headers['ratelimit-limit']).toBe('10');
        expect(res.headers['ratelimit-remaining']).toBe('9');
        expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThan(0);
    });

    it('starts a fresh window once the old one expires', async () => {
        const app = appWith({ windowMs: 1_000, max: 1, name: 'window' });

        expect((await request(app).get('/x')).status).toBe(200);
        expect((await request(app).get('/x')).status).toBe(429);

        vi.advanceTimersByTime(1_500);

        expect((await request(app).get('/x')).status).toBe(200);
    });

    it('buckets by a custom key so one wallet cannot exhaust another', async () => {
        const express = require('express');
        const { rateLimit } = freshSecurity();
        const app = express();
        app.use(express.json());
        app.use(rateLimit({
            windowMs: 60_000,
            max: 1,
            name: 'wallet',
            keyFn: (req) => String(req.body?.walletAddress || '').toLowerCase(),
        }));
        app.post('/x', (_req, res) => res.json({ ok: true }));

        expect((await request(app).post('/x').send({ walletAddress: '0xAAA' })).status).toBe(200);
        expect((await request(app).post('/x').send({ walletAddress: '0xaaa' })).status).toBe(429);
        // A different wallet has its own budget.
        expect((await request(app).post('/x').send({ walletAddress: '0xBBB' })).status).toBe(200);
    });

    it('keeps separate budgets for separately named limiters', async () => {
        const express = require('express');
        const { rateLimit } = freshSecurity();
        const app = express();
        app.use('/a', rateLimit({ windowMs: 60_000, max: 1, name: 'a' }));
        app.use('/b', rateLimit({ windowMs: 60_000, max: 1, name: 'b' }));
        app.get('/a', (_req, res) => res.json({ ok: true }));
        app.get('/b', (_req, res) => res.json({ ok: true }));

        expect((await request(app).get('/a')).status).toBe(200);
        expect((await request(app).get('/a')).status).toBe(429);
        // Exhausting /a must not spend /b's allowance.
        expect((await request(app).get('/b')).status).toBe(200);
    });
});
