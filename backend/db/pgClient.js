/**
 * Shared PostgreSQL client for the BlockDust backend (replaces Supabase).
 *
 * Mirrors the Pixel Ninja Cats pattern (scripts/pgClient.js): a single
 * pg.Pool created from DATABASE_URL, with a small query() helper. There is
 * no row-level security here (the old Supabase setup used permissive
 * "allow all" policies), so a plain pooled connection is sufficient.
 *
 * Reuses the same local Postgres server as the sibling projects but a
 * SEPARATE database (`blockdust`). Override with DATABASE_URL in prod.
 */

const pg = require('pg');

// No hardcoded fallback: a default connection string is what put a real
// credential into this file once already. Set DATABASE_URL in the systemd
// unit's EnvironmentFile, or in your shell for local work.
const connectionString = process.env.DATABASE_URL;

const MISSING_URL =
    'DATABASE_URL is not set. Configure it in the systemd unit ' +
    '(EnvironmentFile) or your shell before starting the backend.';

// Constructed lazily so importing this module stays side-effect free —
// `npm test` has to run on a bare clone with no database configured.
let _pool = null;
function getPool() {
    if (!connectionString) throw new Error(MISSING_URL);
    if (!_pool) {
        _pool = new pg.Pool({ connectionString, max: 10 });
        _pool.on('error', (err) => {
            console.error('❌ Postgres pool error:', err.message);
        });
    }
    return _pool;
}

// Preserve the `pool.query(...)` shape used by callers and test stubs.
const pool = new Proxy({}, {
    get(_t, prop) {
        const p = getPool();
        const v = p[prop];
        return typeof v === 'function' ? v.bind(p) : v;
    },
});

async function query(text, params) {
    return getPool().query(text, params);
}

async function healthCheck() {
    try {
        const { rows } = await getPool().query('SELECT 1 AS ok');
        return rows[0] && rows[0].ok === 1;
    } catch {
        return false;
    }
}

module.exports = { pool, query, healthCheck };
