/**
 * Smoke tests against a REAL running backend (real Express, real PostgreSQL).
 *
 * These are the tests that catch what mocks cannot: a missing table, an
 * unapplied migration, a dead RPC upstream, a bad systemd env. They are
 * deliberately read-only — a smoke run must never mutate marketplace data.
 *
 * Skipped unless SMOKE_BASE_URL is set, so `npm test` passes on a bare
 * checkout with no database:
 *
 *   npm run test:smoke                                  # localhost:8787
 *   SMOKE_BASE_URL=https://blockdust.pyvendr.com npm run test:smoke
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS || 15_000);

// describe.skipIf keeps the suite reported-but-skipped rather than failing.
const suite = describe.skipIf(!BASE);

async function get(pathname, init) {
    const res = await fetch(new URL(pathname, BASE), {
        signal: AbortSignal.timeout(TIMEOUT),
        ...init,
    });
    return res;
}

async function postJson(pathname, body) {
    return get(pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

suite('backend smoke', () => {
    beforeAll(() => {
        if (!BASE) return;
        // Fail fast and loudly rather than emitting 20 confusing errors.
        console.log(`smoke target: ${BASE}`);
    });

    it('is reachable and reports healthy', async () => {
        const res = await get('/api/health?format=json');
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.ok, `health reported: ${JSON.stringify(body.services)}`).toBe(true);
        expect(body.db, 'database must be connected').toBe(true);
    });

    it('serves the built SPA at the root', async () => {
        const res = await get('/');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/html/);
        expect(await res.text()).toMatch(/<div id="root">|<script/i);
    });

    it('falls back to index.html for client-side routes', async () => {
        // React Router owns these paths; the server must not 404 them.
        for (const route of ['/marketplace', '/profile', '/sell']) {
            const res = await get(route);
            expect(res.status, route).toBe(200);
            expect(res.headers.get('content-type'), route).toMatch(/html/);
        }
    });

    it('sets the security headers on API responses', async () => {
        const res = await get('/api/health?format=json');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
    });

    it('queries a real table through /api/db', async () => {
        const res = await postJson('/api/db/query', {
            table: 'marketplace_listings',
            op: 'select',
            columns: 'listing_id,seller',
            limitN: 1,
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        // The table must exist and be queryable; emptiness is fine.
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);
    });

    it('enforces the table allowlist on the live server', async () => {
        const res = await postJson('/api/db/query', { table: 'pg_shadow', op: 'select' });
        expect(res.status).toBe(400);
    });

    it('refuses private tables on the live server', async () => {
        const res = await postJson('/api/db/query', { table: 'sanctions_blocklist', op: 'select' });
        expect(res.status).toBe(403);
    });

    it('refuses deletes on the live server', async () => {
        const res = await postJson('/api/db/query', {
            table: 'marketplace_listings',
            op: 'delete',
            filters: [{ col: 'listing_id', type: 'eq', value: -1 }],
        });
        expect(res.status).toBe(403);
    });

    it('has the compliance RPCs installed in the database', async () => {
        // Catches a schema.sql that was never applied — the functions are
        // SECURITY DEFINER and cannot be exercised any other way.
        const res = await postJson('/api/db/rpc/rpc_check_sanctions', {
            wallet_address: '0x0000000000000000000000000000000000000000',
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('data');
    });

    it('proxies a live RPC call for each chain', async () => {
        for (const chain of ['hyve', 'vitruveo']) {
            const res = await postJson(`/api/rpc/${chain}`, {
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_blockNumber',
                params: [],
            });

            expect(res.status, chain).toBe(200);
            const body = await res.json();
            expect(body.result, `${chain} should return a block number`).toMatch(/^0x[0-9a-f]+$/i);
        }
    });

    it('rejects a non-allowlisted RPC method on the live server', async () => {
        const res = await postJson('/api/rpc/hyve', {
            jsonrpc: '2.0',
            id: 1,
            method: 'admin_addPeer',
            params: [],
        });
        expect(res.status).toBe(400);
    });

    it('exposes cache metrics', async () => {
        const res = await get('/api/cache-metrics');
        expect(res.status).toBe(200);
        expect(await res.json()).toHaveProperty('success');
    });

    /**
     * Kept last on purpose: this burst spends the shared /api budget (300/min)
     * as well as the /api/db one, so any test running after it in the same
     * minute would see 429s. Opt in with SMOKE_RATE_LIMIT=1 — it makes the
     * target briefly unavailable, which is rude against a live deployment.
     */
    it.runIf(process.env.SMOKE_RATE_LIMIT === '1')(
        'applies rate limiting under a burst',
        async () => {
            const burst = await Promise.all(
                Array.from({ length: 140 }, () =>
                    postJson('/api/db/query', { table: 'marketplace_listings', op: 'select', limitN: 1 })
                        .then((r) => r.status)
                        .catch(() => 0)),
            );

            const limited = burst.filter((s) => s === 429);
            expect(limited.length, 'expected some requests to be rate limited').toBeGreaterThan(0);
        },
        30_000,
    );
});

// Always-present guard so the file reports something useful when skipped.
describe('smoke configuration', () => {
    it('explains how to run smoke tests when unconfigured', () => {
        if (!BASE) {
            console.log('SMOKE_BASE_URL not set — smoke tests skipped. Run `npm run test:smoke` with the backend up.');
        }
        expect(true).toBe(true);
    });
});
