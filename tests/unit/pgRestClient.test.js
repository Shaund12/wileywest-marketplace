/**
 * src/lib/pgRestClient.js — the Supabase-compatible shim every page uses.
 *
 * Its contract has two halves, and both matter:
 *   1. it must translate the fluent chain into the exact spec /api/db expects
 *   2. it must return Supabase's { data, error } shape, including on failure,
 *      because callers destructure that instead of using try/catch
 * A regression here breaks every data-driven page at once, quietly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPgRestClient } from '../../src/lib/pgRestClient.js';

/** Captures the outbound request and replies with a canned payload. */
function stubFetch({ ok = true, status = 200, body = { data: [], count: 0 } } = {}) {
    const calls = [];
    const fn = vi.fn(async (url, init) => {
        calls.push({ url, init, spec: init?.body ? JSON.parse(init.body) : null });
        return {
            ok,
            status,
            json: async () => body,
        };
    });
    vi.stubGlobal('fetch', fn);
    return calls;
}

const client = () => createPgRestClient('/api/db');

beforeEach(() => {
    vi.unstubAllGlobals();
});

describe('query building', () => {
    it('posts a select spec to /api/db/query', async () => {
        const calls = stubFetch();
        await client().from('marketplace_listings').select('*');

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('/api/db/query');
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].spec).toMatchObject({ table: 'marketplace_listings', op: 'select', columns: '*' });
    });

    it('accumulates chained filters in order', async () => {
        const calls = stubFetch();
        await client()
            .from('marketplace_listings')
            .select('*')
            .eq('active', true)
            .gt('price_per_unit', '100')
            .ilike('name', '%ninja%');

        expect(calls[0].spec.filters).toEqual([
            { col: 'active', type: 'eq', value: true },
            { col: 'price_per_unit', type: 'gt', value: '100' },
            { col: 'name', type: 'ilike', value: '%ninja%' },
        ]);
    });

    it('supports every filter operator the backend understands', async () => {
        const calls = stubFetch();
        await client().from('marketplace_listings').select('*')
            .eq('a', 1).neq('b', 2).gt('c', 3).gte('d', 4)
            .lt('e', 5).lte('f', 6).like('g', 'x').ilike('h', 'y')
            .is('i', null).in('j', [1, 2]);

        expect(calls[0].spec.filters.map((f) => f.type)).toEqual([
            'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in',
        ]);
    });

    it('defaults order to ascending and honours an explicit descending', async () => {
        const calls = stubFetch();
        await client().from('t').select('*').order('created_at');
        expect(calls[0].spec.order).toEqual({ col: 'created_at', ascending: true });

        const calls2 = stubFetch();
        await client().from('t').select('*').order('created_at', { ascending: false });
        expect(calls2[0].spec.order).toEqual({ col: 'created_at', ascending: false });
    });

    it('translates range(from, to) into limit + offset', async () => {
        const calls = stubFetch();
        // Supabase range is inclusive on both ends: 10..19 is 10 rows.
        await client().from('t').select('*').range(10, 19);

        expect(calls[0].spec.limitN).toBe(10);
        expect(calls[0].spec.offset).toBe(10);
    });

    it('passes head/count options through for count-only queries', async () => {
        const calls = stubFetch({ body: { data: null, count: 7 } });
        const res = await client().from('t').select('*', { count: 'exact', head: true });

        expect(calls[0].spec.head).toBe(true);
        expect(calls[0].spec.count).toBe('exact');
        expect(res.count).toBe(7);
    });
});

describe('writes', () => {
    it('wraps a single insert row into an array', async () => {
        const calls = stubFetch();
        await client().from('t').insert({ a: 1 });

        expect(calls[0].spec.op).toBe('insert');
        expect(calls[0].spec.rows).toEqual([{ a: 1 }]);
        // Supabase does not return rows unless .select() is chained.
        expect(calls[0].spec.returning).toBe(false);
    });

    it('flips returning to true when .select() is chained onto a write', async () => {
        const calls = stubFetch();
        await client().from('t').insert({ a: 1 }).select('*');

        expect(calls[0].spec.returning).toBe(true);
        // .select() must not downgrade the write back to a plain select.
        expect(calls[0].spec.op).toBe('insert');
    });

    it('forwards onConflict and ignoreDuplicates on upsert', async () => {
        const calls = stubFetch();
        await client().from('t').upsert([{ a: 1 }], { onConflict: 'a', ignoreDuplicates: true });

        expect(calls[0].spec).toMatchObject({ op: 'upsert', onConflict: 'a', ignoreDuplicates: true });
    });

    it('sends update values alongside filters', async () => {
        const calls = stubFetch();
        await client().from('t').update({ status: 'sold' }).eq('id', 3);

        expect(calls[0].spec.op).toBe('update');
        expect(calls[0].spec.values).toEqual({ status: 'sold' });
        expect(calls[0].spec.filters).toEqual([{ col: 'id', type: 'eq', value: 3 }]);
    });

    it('marks deletes so the backend can refuse them', async () => {
        const calls = stubFetch();
        await client().from('t').delete().eq('id', 1);
        expect(calls[0].spec.op).toBe('delete');
    });
});

describe('single / maybeSingle', () => {
    it('unwraps the first row for single()', async () => {
        stubFetch({ body: { data: [{ id: 1 }, { id: 2 }], count: 2 } });
        const res = await client().from('t').select('*').single();

        expect(res.data).toEqual({ id: 1 });
        expect(res.error).toBeNull();
    });

    it('returns a PGRST116 error when single() finds nothing', async () => {
        stubFetch({ body: { data: [], count: 0 } });
        const res = await client().from('t').select('*').single();

        expect(res.data).toBeNull();
        expect(res.error.code).toBe('PGRST116');
    });

    it('returns null without an error when maybeSingle() finds nothing', async () => {
        stubFetch({ body: { data: [], count: 0 } });
        const res = await client().from('t').select('*').maybeSingle();

        expect(res.data).toBeNull();
        expect(res.error).toBeNull();
    });
});

describe('error handling', () => {
    it('surfaces a backend error payload as { error } rather than throwing', async () => {
        stubFetch({ ok: false, status: 403, body: { error: { message: 'nope', code: 'PGRST301' } } });
        const res = await client().from('sanctions_blocklist').select('*');

        expect(res.data).toBeNull();
        expect(res.error).toEqual({ message: 'nope', code: 'PGRST301' });
    });

    it('synthesises an error when the response has no JSON body', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 500,
            json: async () => { throw new Error('not json'); },
        })));

        const res = await client().from('t').select('*');
        expect(res.error.code).toBe('HTTP500');
    });

    it('converts a network failure into a NETWORK error instead of rejecting', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

        // Must resolve, not reject — callers destructure rather than catch.
        const res = await client().from('t').select('*');
        expect(res.error.code).toBe('NETWORK');
        expect(res.error.message).toBe('offline');
    });
});

describe('rpc', () => {
    it('posts args to the named function endpoint', async () => {
        const calls = stubFetch({ body: { data: { blocked: false } } });
        const res = await client().rpc('rpc_check_sanctions', { wallet_address: '0x1' });

        expect(calls[0].url).toBe('/api/db/rpc/rpc_check_sanctions');
        expect(calls[0].spec).toEqual({ wallet_address: '0x1' });
        expect(res.data).toEqual({ blocked: false });
    });

    it('url-encodes the function name', async () => {
        const calls = stubFetch({ body: { data: null } });
        await client().rpc('weird name/../x');
        expect(calls[0].url).toBe('/api/db/rpc/weird%20name%2F..%2Fx');
    });

    it('returns an error object when the rpc fails', async () => {
        stubFetch({ ok: false, status: 400, body: { error: { message: 'bad', code: 'PGRST202' } } });
        const res = await client().rpc('nope');

        expect(res.data).toBeNull();
        expect(res.error.code).toBe('PGRST202');
    });
});

describe('realtime no-ops', () => {
    // Realtime was dropped in the Postgres migration. The surface must stay
    // chainable so existing subscription code neither throws nor spams.
    it('keeps channel() chainable and reports SUBSCRIBED', async () => {
        stubFetch();
        const cb = vi.fn();
        const ch = client().channel('listings').on('postgres_changes', {}, () => {}).subscribe(cb);

        expect(cb).toHaveBeenCalledWith('SUBSCRIBED');
        expect(typeof ch.unsubscribe).toBe('function');
        await expect(ch.send()).resolves.toEqual({ status: 'ok' });
    });

    it('performs no network traffic for realtime calls', async () => {
        const calls = stubFetch();
        const c = client();
        c.channel('a').on('x', {}, () => {}).subscribe();
        await c.removeAllChannels();
        await c.removeChannel();

        expect(calls).toHaveLength(0);
    });
});
