/**
 * The /api/db surface is the only path from the browser to PostgreSQL, so its
 * allowlist is the security boundary for the whole app. These tests pin the
 * rules that backend/routes/db.js enforces.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeDbApp } from '../helpers/testApp.js';

const post = (app, body) => request(app).post('/api/db/query').send(body);

describe('table allowlist', () => {
    it('rejects a table that is not registered', async () => {
        const { app, calls } = makeDbApp();
        const res = await post(app, { table: 'pg_shadow', op: 'select' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PGRST205');
        // The critical assertion: an unknown table never reaches the database.
        expect(calls).toHaveLength(0);
    });

    it('refuses private tables even though they are registered', async () => {
        const { app, calls } = makeDbApp();
        for (const table of ['metadata_cache', 'sanctions_blocklist', 'dmca_takedowns', 'compliance_settings']) {
            const res = await post(app, { table, op: 'select' });
            expect(res.status, `${table} must be private`).toBe(403);
            expect(res.body.error.code).toBe('PGRST301');
        }
        expect(calls).toHaveLength(0);
    });

    it('returns an empty result for soft-missing tables instead of erroring', async () => {
        const { app, calls } = makeDbApp();
        // Some pages probe tables that were never ported off Supabase. They
        // must degrade to "no rows" so the UI renders rather than throwing.
        for (const table of ['legal_docs', 'marketplace_auctions', 'auction_listings', 'ma_gmv_trailing_365']) {
            const res = await post(app, { table, op: 'select' });
            expect(res.status, table).toBe(200);
            expect(res.body).toEqual({ data: [], count: 0 });
        }
        expect(calls).toHaveLength(0);
    });

    it('allows a select on a public table', async () => {
        const { app, calls } = makeDbApp(() => ({ rows: [{ listing_id: 1 }], rowCount: 1 }));
        const res = await post(app, { table: 'marketplace_listings', op: 'select' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([{ listing_id: 1 }]);
        expect(calls).toHaveLength(1);
    });
});

describe('column and filter validation', () => {
    it('rejects a filter on an unknown column', async () => {
        const { app } = makeDbApp();
        const res = await post(app, {
            table: 'marketplace_listings',
            op: 'select',
            filters: [{ col: 'password', type: 'eq', value: 'x' }],
        });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/Unknown column/);
    });

    it('rejects an unsupported filter operator', async () => {
        const { app } = makeDbApp();
        const res = await post(app, {
            table: 'marketplace_listings',
            op: 'select',
            filters: [{ col: 'seller', type: 'dropTable', value: 'x' }],
        });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/Unsupported filter/);
    });

    it('silently drops unknown columns from a select list', async () => {
        const { app, calls } = makeDbApp();
        await post(app, {
            table: 'marketplace_listings',
            op: 'select',
            columns: 'seller,token_id,secret_column',
        });

        expect(calls[0].text).toContain('"seller", "token_id"');
        expect(calls[0].text).not.toContain('secret_column');
    });

    it('ignores an ORDER BY on an unknown column rather than interpolating it', async () => {
        const { app, calls } = makeDbApp();
        await post(app, {
            table: 'marketplace_listings',
            op: 'select',
            order: { col: 'price_per_unit; DROP TABLE users', ascending: true },
        });

        expect(calls[0].text).not.toMatch(/DROP TABLE/i);
        expect(calls[0].text).not.toContain('ORDER BY');
    });

    it('caps the IN filter at 100 values', async () => {
        const { app } = makeDbApp();
        const res = await post(app, {
            table: 'marketplace_listings',
            op: 'select',
            filters: [{ col: 'listing_id', type: 'in', value: Array.from({ length: 101 }, (_, i) => i) }],
        });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/Too many values/);
    });

    it('turns an empty IN list into a false predicate', async () => {
        const { app, calls } = makeDbApp();
        await post(app, {
            table: 'marketplace_listings',
            op: 'select',
            filters: [{ col: 'listing_id', type: 'in', value: [] }],
        });

        expect(calls[0].text).toContain('WHERE false');
    });

    it('renders `is null` without binding a parameter', async () => {
        const { app, calls } = makeDbApp();
        await post(app, {
            table: 'marketplace_listings',
            op: 'select',
            filters: [{ col: 'sale_status', type: 'is', value: null }],
        });

        expect(calls[0].text).toContain('"sale_status" IS NULL');
    });
});

describe('SQL injection resistance', () => {
    // Values must always travel as bound parameters, never as SQL text.
    const payloads = [
        "'; DROP TABLE marketplace_listings; --",
        "1 OR 1=1",
        "\\'; DELETE FROM user_profiles WHERE 't'='t",
        "0x27 UNION SELECT * FROM sanctions_blocklist",
    ];

    for (const payload of payloads) {
        it(`binds rather than interpolates: ${payload.slice(0, 32)}`, async () => {
            const { app, calls } = makeDbApp();
            await post(app, {
                table: 'marketplace_listings',
                op: 'select',
                filters: [{ col: 'seller', type: 'eq', value: payload }],
            });

            const { text, params } = calls[0];
            expect(text).not.toContain(payload);
            expect(text).toContain('"seller" = $1');
            expect(params).toContain(payload);
        });
    }

    it('keeps injection payloads out of update SET clauses', async () => {
        const { app, calls } = makeDbApp();
        await post(app, {
            table: 'marketplace_listings',
            op: 'update',
            values: { name: "'); DROP TABLE x; --" },
            filters: [{ col: 'listing_id', type: 'eq', value: 7 }],
        });

        expect(calls[0].text).not.toMatch(/DROP TABLE/i);
        expect(calls[0].text).toContain('"name" = $1');
    });
});

describe('limits and pagination', () => {
    it('applies the default limit when none is given', async () => {
        const { app, calls } = makeDbApp();
        await post(app, { table: 'marketplace_listings', op: 'select' });
        expect(calls[0].params).toContain(100);
    });

    it('clamps an oversized limit to the maximum', async () => {
        const { app, calls } = makeDbApp();
        await post(app, { table: 'marketplace_listings', op: 'select', limitN: 99999 });
        expect(calls[0].params).toContain(500);
    });

    it('coerces a non-numeric limit to the default', async () => {
        const { app, calls } = makeDbApp();
        await post(app, { table: 'marketplace_listings', op: 'select', limitN: 'all' });
        expect(calls[0].params).toContain(100);
    });

    it('floors a negative offset at zero', async () => {
        const { app, calls } = makeDbApp();
        await post(app, { table: 'marketplace_listings', op: 'select', offset: -50 });
        expect(calls[0].text).toContain('OFFSET');
        expect(calls[0].params).toContain(0);
    });

    it('supports head+count without selecting rows', async () => {
        const { app, calls } = makeDbApp(() => ({ rows: [{ count: 42 }], rowCount: 1 }));
        const res = await post(app, { table: 'marketplace_listings', op: 'select', head: true, count: 'exact' });

        expect(res.body).toEqual({ data: null, count: 42 });
        expect(calls[0].text).toContain('COUNT(*)');
    });
});

describe('write protection', () => {
    it('never allows deletes', async () => {
        const { app, calls } = makeDbApp();
        const res = await post(app, { table: 'marketplace_listings', op: 'delete' });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PGRST302');
        expect(calls).toHaveLength(0);
    });

    it('rejects an unsupported op', async () => {
        const { app } = makeDbApp();
        const res = await post(app, { table: 'marketplace_listings', op: 'truncate' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PGRST100');
    });

    it('caps bulk writes at 25 rows', async () => {
        const { app } = makeDbApp();
        const rows = Array.from({ length: 26 }, (_, i) => ({ listing_id: i }));
        const res = await post(app, { table: 'marketplace_listings', op: 'insert', rows });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/maximum of 25 rows/);
    });

    it('requires an identity filter on update', async () => {
        const { app, calls } = makeDbApp();
        const res = await post(app, {
            table: 'marketplace_listings',
            op: 'update',
            values: { name: 'renamed' },
            filters: [],
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PGRST099');
        expect(calls).toHaveLength(0);
    });

    it('rejects an update filtered on a non-identity column', async () => {
        // Without this rule a caller could rewrite every row owned by anyone.
        const { app } = makeDbApp();
        const res = await post(app, {
            table: 'marketplace_listings',
            op: 'update',
            values: { name: 'renamed' },
            filters: [{ col: 'active', type: 'eq', value: true }],
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PGRST099');
    });

    it('requires both wallet and chain filters when updating a profile', async () => {
        const { app } = makeDbApp();
        const res = await post(app, {
            table: 'user_profiles',
            op: 'update',
            values: { nfts: [] },
            filters: [{ col: 'wallet_address', type: 'eq', value: '0xabc' }],
        });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/wallet and chain/);
    });

    it('accepts a profile update carrying both filters', async () => {
        const { app, calls } = makeDbApp(() => ({ rows: [], rowCount: 1 }));
        const res = await post(app, {
            table: 'user_profiles',
            op: 'update',
            values: { sync_status: 'done' },
            filters: [
                { col: 'wallet_address', type: 'eq', value: '0xabc' },
                { col: 'chain_id', type: 'eq', value: 7847 },
            ],
        });

        expect(res.status).toBe(200);
        expect(calls[0].text).toContain('UPDATE "user_profiles"');
    });

    it('rejects an invalid upsert conflict target', async () => {
        const { app } = makeDbApp();
        const res = await post(app, {
            table: 'marketplace_listings',
            op: 'upsert',
            rows: [{ listing_id: 1 }],
            onConflict: 'nonexistent_col',
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PGRST104');
    });

    it('infers the conflict target per table on upsert', async () => {
        const { app, calls } = makeDbApp(() => ({ rows: [], rowCount: 1 }));
        await post(app, { table: 'marketplace_listings', op: 'upsert', rows: [{ listing_id: 1, name: 'x' }] });
        expect(calls[0].text).toContain('ON CONFLICT ("listing_id") DO UPDATE SET');

        const { app: app2, calls: calls2 } = makeDbApp(() => ({ rows: [], rowCount: 1 }));
        await post(app2, { table: 'user_profiles', op: 'upsert', rows: [{ wallet_address: '0x1', chain_id: 7847 }] });
        expect(calls2[0].text).toContain('ON CONFLICT ("wallet_address", "chain_id")');
    });

    it('honours ignoreDuplicates as DO NOTHING', async () => {
        const { app, calls } = makeDbApp(() => ({ rows: [], rowCount: 0 }));
        await post(app, {
            table: 'marketplace_listings',
            op: 'upsert',
            rows: [{ listing_id: 1 }],
            ignoreDuplicates: true,
        });

        expect(calls[0].text).toContain('DO NOTHING');
    });

    it('drops unknown columns from an insert', async () => {
        const { app, calls } = makeDbApp(() => ({ rows: [], rowCount: 1 }));
        await post(app, {
            table: 'marketplace_listings',
            op: 'insert',
            rows: [{ listing_id: 1, is_admin: true }],
        });

        expect(calls[0].text).not.toContain('is_admin');
        expect(calls[0].text).toContain('"listing_id"');
    });

    it('errors when an insert has no valid columns at all', async () => {
        const { app } = makeDbApp();
        const res = await post(app, {
            table: 'marketplace_listings',
            op: 'insert',
            rows: [{ nope: 1 }],
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PGRST204');
    });

    it('short-circuits an empty insert without touching the database', async () => {
        const { app, calls } = makeDbApp();
        const res = await post(app, { table: 'marketplace_listings', op: 'insert', rows: [] });

        expect(res.status).toBe(200);
        expect(calls).toHaveLength(0);
    });
});

describe('rpc allowlist', () => {
    it('rejects an unlisted function', async () => {
        const { app, calls } = makeDbApp();
        const res = await request(app).post('/api/db/rpc/pg_sleep').send({});

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PGRST202');
        expect(calls).toHaveLength(0);
    });

    it('passes allowlisted functions through with bound arguments', async () => {
        const { app, calls } = makeDbApp(() => ({ rows: [{ data: { blocked: false } }], rowCount: 1 }));
        const res = await request(app)
            .post('/api/db/rpc/rpc_check_sanctions')
            .send({ wallet_address: '0xdeadbeef' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ blocked: false });
        expect(calls[0].params).toEqual(['0xdeadbeef']);
    });

    it('serialises the DMCA payload as a single jsonb parameter', async () => {
        const { app, calls } = makeDbApp(() => ({ rows: [{ data: { id: 1 } }], rowCount: 1 }));
        await request(app)
            .post('/api/db/rpc/rpc_dmca_create')
            .send({ payload: { complainant_name: 'A', infringing_urls: ['u'] } });

        expect(calls[0].params).toHaveLength(1);
        expect(JSON.parse(calls[0].params[0])).toEqual({ complainant_name: 'A', infringing_urls: ['u'] });
    });

    it('surfaces a database failure as a 400 rather than a 500', async () => {
        const { app } = makeDbApp(() => { throw new Error('function does not exist'); });
        const res = await request(app).post('/api/db/rpc/rpc_check_sanctions').send({ wallet_address: '0x1' });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/does not exist/);
    });
});
