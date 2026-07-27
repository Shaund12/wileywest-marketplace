/**
 * pgRestClient — a tiny Supabase-compatible client that talks to the local
 * BlockDust backend (Express + PostgreSQL) instead of Supabase.
 *
 * Why this exists:
 *   The frontend used the @supabase/supabase-js fluent API in many places
 *   (SupabaseContext.jsx plus several page components):
 *       supabase.from('t').select('*').eq(...).order(...).limit(...)
 *       supabase.from('t').upsert(rows, { onConflict })
 *       supabase.from('t').update({...}).eq(...)
 *       supabase.rpc('fn', args)
 *       supabase.channel('c').on(...).subscribe()   // realtime
 *   Browsers can't connect to Postgres directly, so instead of rewriting
 *   every call site we reproduce that exact surface here and translate each
 *   terminal operation into a POST to /api/db (a PostgREST-lite endpoint on
 *   the backend). This keeps all consumer code (including page files owned by
 *   another agent) working unchanged.
 *
 * Realtime: Postgres logical replication / websockets are out of scope for the
 * self-hosted MVP. channel()/on()/subscribe()/send() are implemented as safe
 * no-ops so existing subscription code neither crashes nor spams. The app
 * already polls and refreshes on its own, so live updates degrade gracefully.
 *
 * Returned shape mirrors Supabase: every awaited query resolves to
 * { data, error } (error is null on success, or { message, code } on failure).
 */

const DEFAULT_BASE = '/api/db';

function makeError(message, code) {
    return { message: message || 'Unknown error', code: code || 'PGRST000', details: null, hint: null };
}

/**
 * Concurrency gate + 429 retry for /api/db.
 *
 * nginx rate-limits this endpoint per IP (rate=5r/s burst=15). Pages that
 * fan out with Promise.all over a list of listings blow straight through the
 * burst and take back a wall of 429s — the requests are not individually
 * excessive, they just all leave at once. Serializing to a small window keeps
 * bursts under the limit while staying fast enough for normal page loads.
 *
 * Kept here rather than at each call site so every consumer of the shim is
 * covered without touching ~20 files.
 */
const MAX_CONCURRENT_DB = 6;
const MAX_RETRIES = 3;

let activeRequests = 0;
const pendingQueue = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function acquireSlot() {
    if (activeRequests < MAX_CONCURRENT_DB) {
        activeRequests += 1;
        return Promise.resolve();
    }
    return new Promise((resolve) => pendingQueue.push(resolve));
}

function releaseSlot() {
    const next = pendingQueue.shift();
    if (next) next();
    else activeRequests -= 1;
}

async function gatedFetch(url, options) {
    await acquireSlot();
    try {
        for (let attempt = 0; ; attempt += 1) {
            const res = await fetch(url, options);
            if (res.status !== 429 || attempt >= MAX_RETRIES) return res;

            // Respect Retry-After when nginx sends it; otherwise back off
            // exponentially with jitter so retries don't resynchronize into
            // another burst.
            const retryAfter = Number.parseFloat(res.headers.get('retry-after') || '');
            const backoff = Number.isFinite(retryAfter)
                ? retryAfter * 1000
                : 250 * 2 ** attempt + Math.random() * 250;
            await sleep(backoff);
        }
    } finally {
        releaseSlot();
    }
}

/**
 * A thenable query builder. Chainable filter/modifier methods accumulate a
 * spec object; awaiting it (or calling .single()/.maybeSingle()) fires the
 * HTTP request.
 */
class QueryBuilder {
    constructor(baseUrl, table, op) {
        this._baseUrl = baseUrl;
        this._spec = {
            table,
            op,                 // 'select' | 'insert' | 'upsert' | 'update' | 'delete'
            columns: '*',
            filters: [],        // { col, type, value }
            order: null,        // { col, ascending }
            limitN: null,
            rows: null,         // for insert/upsert
            values: null,       // for update
            onConflict: null,
            ignoreDuplicates: false,
            returning: true,
            single: false,
            maybeSingle: false,
            count: null,        // 'exact' etc.
            head: false,
        };
    }

    // ── SELECT ──────────────────────────────────────────────────────────────
    select(columns = '*', opts = {}) {
        // Supabase allows .select() as a terminal on insert/update to return rows.
        if (this._spec.op === 'select' || this._spec.op == null) {
            this._spec.op = 'select';
        }
        this._spec.columns = columns || '*';
        if (opts && opts.count) this._spec.count = opts.count;
        if (opts && opts.head) this._spec.head = true;
        this._spec.returning = true;
        return this;
    }

    // ── Filters ─────────────────────────────────────────────────────────────
    eq(col, value) { this._spec.filters.push({ col, type: 'eq', value }); return this; }
    neq(col, value) { this._spec.filters.push({ col, type: 'neq', value }); return this; }
    gt(col, value) { this._spec.filters.push({ col, type: 'gt', value }); return this; }
    gte(col, value) { this._spec.filters.push({ col, type: 'gte', value }); return this; }
    lt(col, value) { this._spec.filters.push({ col, type: 'lt', value }); return this; }
    lte(col, value) { this._spec.filters.push({ col, type: 'lte', value }); return this; }
    like(col, value) { this._spec.filters.push({ col, type: 'like', value }); return this; }
    ilike(col, value) { this._spec.filters.push({ col, type: 'ilike', value }); return this; }
    is(col, value) { this._spec.filters.push({ col, type: 'is', value }); return this; }
    in(col, value) { this._spec.filters.push({ col, type: 'in', value }); return this; }

    // ── Modifiers ───────────────────────────────────────────────────────────
    order(col, opts = {}) {
        this._spec.order = { col, ascending: opts.ascending !== false };
        return this;
    }
    limit(n) { this._spec.limitN = n; return this; }
    range(from, to) { this._spec.limitN = (to - from + 1); this._spec.offset = from; return this; }

    // ── Writes ──────────────────────────────────────────────────────────────
    insert(rows, opts = {}) {
        this._spec.op = 'insert';
        this._spec.rows = Array.isArray(rows) ? rows : [rows];
        this._spec.ignoreDuplicates = !!opts.ignoreDuplicates;
        this._spec.returning = false; // becomes true if .select() is chained
        return this;
    }
    upsert(rows, opts = {}) {
        this._spec.op = 'upsert';
        this._spec.rows = Array.isArray(rows) ? rows : [rows];
        this._spec.onConflict = opts.onConflict || null;
        this._spec.ignoreDuplicates = !!opts.ignoreDuplicates;
        this._spec.returning = false;
        return this;
    }
    update(values) {
        this._spec.op = 'update';
        this._spec.values = values;
        this._spec.returning = false;
        return this;
    }
    delete() {
        this._spec.op = 'delete';
        this._spec.returning = false;
        return this;
    }

    // ── Terminal helpers ────────────────────────────────────────────────────
    single() { this._spec.single = true; return this._run(); }
    maybeSingle() { this._spec.maybeSingle = true; return this._run(); }

    // Thenable: makes `await builder` and `builder.then(...)` work.
    then(onFulfilled, onRejected) {
        return this._run().then(onFulfilled, onRejected);
    }
    catch(onRejected) { return this._run().catch(onRejected); }

    async _run() {
        try {
            const res = await gatedFetch(`${this._baseUrl}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this._spec),
            });

            let payload = null;
            try { payload = await res.json(); } catch { payload = null; }

            if (!res.ok) {
                const err = (payload && payload.error) || makeError(`HTTP ${res.status}`, `HTTP${res.status}`);
                return { data: null, error: err, count: null };
            }

            let data = payload ? payload.data : null;
            const count = payload ? (payload.count ?? null) : null;

            if (this._spec.single || this._spec.maybeSingle) {
                if (Array.isArray(data)) {
                    if (data.length === 0) {
                        // maybeSingle → null/no error; single → error (PGRST116)
                        if (this._spec.maybeSingle) return { data: null, error: null, count };
                        return { data: null, error: makeError('No rows found', 'PGRST116'), count };
                    }
                    data = data[0];
                }
            }

            return { data, error: null, count };
        } catch (e) {
            return { data: null, error: makeError(e.message, 'NETWORK'), count: null };
        }
    }
}

/**
 * No-op realtime channel. Preserves the chainable Supabase surface so existing
 * subscription code runs without throwing, but performs no work.
 */
class NoopChannel {
    constructor(name) { this.name = name; }
    on() { return this; }
    subscribe(cb) { if (typeof cb === 'function') { try { cb('SUBSCRIBED'); } catch { /* ignore */ } } return this; }
    send() { return Promise.resolve({ status: 'ok' }); }
    unsubscribe() { return Promise.resolve({ status: 'ok' }); }
}

export function createPgRestClient(baseUrl = DEFAULT_BASE) {
    return {
        // The single seam every consumer uses.
        from(table) {
            // op is decided by which terminal method is called; default select.
            return new QueryBuilder(baseUrl, table, 'select');
        },

        async rpc(fn, args = {}) {
            try {
                const res = await gatedFetch(`${baseUrl}/rpc/${encodeURIComponent(fn)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(args || {}),
                });
                let payload = null;
                try { payload = await res.json(); } catch { payload = null; }
                if (!res.ok) {
                    const err = (payload && payload.error) || makeError(`HTTP ${res.status}`, `HTTP${res.status}`);
                    return { data: null, error: err };
                }
                return { data: payload ? payload.data : null, error: null };
            } catch (e) {
                return { data: null, error: makeError(e.message, 'NETWORK') };
            }
        },

        channel(name) { return new NoopChannel(name); },
        removeChannel() { return Promise.resolve({ status: 'ok' }); },
        removeAllChannels() { return Promise.resolve({ status: 'ok' }); },
    };
}

export default createPgRestClient;
