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

const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://USER:PASSWORD@127.0.0.1:5432/blockdust';

const pool = new pg.Pool({ connectionString, max: 10 });

pool.on('error', (err) => {
    console.error('❌ Postgres pool error:', err.message);
});

async function query(text, params) {
    return pool.query(text, params);
}

async function healthCheck() {
    try {
        const { rows } = await pool.query('SELECT 1 AS ok');
        return rows[0] && rows[0].ok === 1;
    } catch {
        return false;
    }
}

module.exports = { pool, query, healthCheck };
