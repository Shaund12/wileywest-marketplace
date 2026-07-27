/**
 * PostgREST-lite: translates the frontend pgRestClient's query specs into
 * parameterized SQL against local Postgres. This is the server side of
 * src/lib/pgRestClient.js.
 *
 * Security model: the frontend used the Supabase anon key with permissive
 * "allow all" RLS policies, i.e. the browser could already read/write these
 * cache tables freely. We preserve that trust level but constrain WHICH tables
 * and columns are reachable via an allow-list, and always use parameterized
 * queries (no string interpolation of user values). Identifiers (table/column
 * names) are validated against the allow-list before being placed in SQL.
 */

const express = require('express');
const { query } = require('../db/pgClient');

const router = express.Router();

// Tables the browser client is permitted to touch, with their real columns.
// Anything not listed is rejected. This is the injection guard for identifiers.
const TABLES = {
    marketplace_listings: ['id', 'listing_id', 'seller', 'nft_contract', 'token_id', 'quantity', 'price_per_unit', 'payment_token', 'is_erc1155', 'active', 'sale_status', 'sale_transaction_hash', 'metadata', 'image_url', 'name', 'description', 'created_at', 'updated_at'],
    user_profiles: ['id', 'wallet_address', 'chain_id', 'nfts', 'listings', 'balance', 'last_full_scan_block', 'sync_status', 'last_sync', 'created_at', 'updated_at'],
    sales_history: ['id', 'listing_id', 'buyer', 'seller', 'quantity', 'total_price', 'payment_token', 'transaction_hash', 'block_number', 'timestamp', 'sale_type', 'created_at'],
    auctions: ['id', 'auction_id', 'marketplace_address', 'seller', 'nft_contract', 'token_id', 'quantity', 'reserve_price', 'start_price', 'end_time', 'payment_token', 'min_bid_increment_bps', 'anti_snipe_seconds', 'highest_bidder', 'highest_bid', 'settled', 'metadata', 'transaction_hash', 'block_number', 'log_index', 'timestamp', 'created_at'],
    auction_bids: ['id', 'auction_id', 'bidder', 'amount', 'new_end_time', 'is_native', 'transaction_hash', 'block_number', 'log_index', 'timestamp', 'created_at'],
    metadata_cache: ['id', 'contract_address', 'token_id', 'metadata', 'image_url', 'placeholder_data', 'token_uri', 'cache_key', 'hits', 'last_hit', 'ttl_expires_at', 'created_at', 'updated_at'],
    image_cache: ['id', 'original_url', 'proxy_url', 'content_type', 'content_length', 'placeholder_data', 'gateway_used', 'cache_status', 'hits', 'last_hit', 'ttl_expires_at', 'created_at', 'updated_at'],
    prewarm_queue: ['id', 'job_type', 'contract_address', 'token_id', 'listing_id', 'metadata_url', 'image_urls', 'priority', 'status', 'attempts', 'max_attempts', 'error_message', 'processed_at', 'updated_at', 'created_at'],
    cache_metrics: ['id', 'metric_type', 'cache_type', 'value', 'dimensions', 'timestamp'],
    sanctions_blocklist: ['id', 'ref', 'address', 'provider', 'added_at', 'notes'],
    sanctions_logs: ['id', 'occurred_at', 'action', 'address', 'decision', 'provider', 'context'],
    nft_contract_blocklist: ['id', 'contract_address', 'reason', 'description', 'added_by', 'added_at', 'active', 'notes'],
    nft_contract_logs: ['id', 'occurred_at', 'action', 'contract_address', 'user_address', 'decision', 'reason', 'context'],
    dmca_takedowns: ['id', 'created_at', 'updated_at', 'status', 'complainant_name', 'complainant_email', 'rights_holder', 'infringing_urls', 'original_work_urls', 'evidence_urls', 'sworn_statement', 'signature', 'ip', 'user_agent', 'admin_notes', 'actioned_by', 'actioned_at'],
    compliance_settings: ['id', 'key', 'value', 'updated_at'],
    marketplace_sync_meta: ['key', 'last_block', 'updated_at'],
};

// Operational, moderation, and personal-data tables are never exposed through
// the generic browser query surface. Purpose-built RPCs return only the
// minimum decision/result the public app needs.
const PRIVATE_TABLES = new Set([
    'metadata_cache',
    'image_cache',
    'prewarm_queue',
    'cache_metrics',
    'sanctions_blocklist',
    'sanctions_logs',
    'nft_contract_blocklist',
    'nft_contract_logs',
    'dmca_takedowns',
    'compliance_settings',
    'marketplace_sync_meta',
]);

const PUBLIC_WRITE_KEYS = {
    marketplace_listings: new Set(['id', 'listing_id']),
    user_profiles: new Set(['wallet_address']),
    sales_history: new Set(['id', 'transaction_hash']),
    auctions: new Set(['id', 'auction_id']),
    auction_bids: new Set(['id', 'transaction_hash']),
};

const DEFAULT_SELECT_LIMIT = 100;
const MAX_SELECT_LIMIT = 500;
const MAX_WRITE_ROWS = 25;

// Some page code probes non-existent table names (marketplace_auctions,
// auction_listings). Return an empty result rather than an error for those.
const SOFT_MISSING = new Set(['marketplace_auctions', 'auction_listings', 'ma_gmv_trailing_365', 'legal_docs']);

function err(res, status, message, code) {
    return res.status(status).json({ error: { message, code: code || 'PGRST000' } });
}

const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };

function buildWhere(filters, cols, params) {
    const clauses = [];
    for (const f of filters || []) {
        if (!cols.includes(f.col)) throw new Error(`Unknown column: ${f.col}`);
        const q = `"${f.col}"`;
        if (f.type === 'in') {
            const arr = Array.isArray(f.value) ? f.value : [f.value];
            if (arr.length > 100) throw new Error('Too many values in filter');
            if (arr.length === 0) { clauses.push('false'); continue; }
            const placeholders = arr.map((v) => { params.push(v); return `$${params.length}`; });
            clauses.push(`${q} IN (${placeholders.join(', ')})`);
        } else if (f.type === 'is') {
            if (f.value === null) clauses.push(`${q} IS NULL`);
            else { params.push(f.value); clauses.push(`${q} IS $${params.length}`); }
        } else if (OPS[f.type]) {
            params.push(f.value);
            clauses.push(`${q} ${OPS[f.type]} $${params.length}`);
        } else {
            throw new Error(`Unsupported filter: ${f.type}`);
        }
    }
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function selectList(columns, cols) {
    if (!columns || columns === '*') return '*';
    // Supabase select strings can list columns; keep only valid ones.
    const requested = columns.split(',').map((c) => c.trim()).filter(Boolean);
    const safe = requested.filter((c) => cols.includes(c));
    return safe.length ? safe.map((c) => `"${c}"`).join(', ') : '*';
}

router.post('/query', async (req, res) => {
    const spec = req.body || {};
    const table = spec.table;

    if (SOFT_MISSING.has(table)) {
        return res.json({ data: [], count: 0 });
    }
    const cols = TABLES[table];
    if (!cols) return err(res, 400, `Table not allowed: ${table}`, 'PGRST205');
    if (PRIVATE_TABLES.has(table)) return err(res, 403, 'Table is not available through the public API', 'PGRST301');

    try {
        const params = [];
        const op = spec.op || 'select';

        if (op === 'select') {
            if (spec.head && spec.count) {
                const where = buildWhere(spec.filters, cols, params);
                const r = await query(`SELECT COUNT(*)::int AS count FROM "${table}" ${where}`, params);
                return res.json({ data: null, count: r.rows[0].count });
            }
            const sel = selectList(spec.columns, cols);
            const where = buildWhere(spec.filters, cols, params);
            let sql = `SELECT ${sel} FROM "${table}" ${where}`;
            if (spec.order && cols.includes(spec.order.col)) {
                sql += ` ORDER BY "${spec.order.col}" ${spec.order.ascending ? 'ASC' : 'DESC'}`;
            }
            const requestedLimit = Number(spec.limitN ?? DEFAULT_SELECT_LIMIT);
            const safeLimit = Math.max(1, Math.min(MAX_SELECT_LIMIT, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_SELECT_LIMIT));
            params.push(safeLimit);
            sql += ` LIMIT $${params.length}`;
            if (spec.offset != null) {
                const offset = Math.max(0, Math.min(100_000, Number(spec.offset) || 0));
                params.push(offset);
                sql += ` OFFSET $${params.length}`;
            }
            const r = await query(sql, params);
            return res.json({ data: r.rows, count: r.rowCount });
        }

        if (op === 'insert' || op === 'upsert') {
            if (!PUBLIC_WRITE_KEYS[table]) return err(res, 403, 'Writes are not allowed for this table', 'PGRST302');
            const rows = spec.rows || [];
            if (rows.length === 0) return res.json({ data: [], count: 0 });
            if (!Array.isArray(rows) || rows.length > MAX_WRITE_ROWS) {
                return err(res, 400, `A maximum of ${MAX_WRITE_ROWS} rows may be written at once`, 'PGRST103');
            }
            const insertCols = Array.from(rows.reduce((s, row) => { Object.keys(row).forEach((k) => s.add(k)); return s; }, new Set()))
                .filter((c) => cols.includes(c));
            if (insertCols.length === 0) return err(res, 400, 'No valid columns to insert', 'PGRST204');

            const valuesSql = [];
            for (const row of rows) {
                const ph = insertCols.map((c) => {
                    params.push(normalize(row[c]));
                    return `$${params.length}`;
                });
                valuesSql.push(`(${ph.join(', ')})`);
            }
            let sql = `INSERT INTO "${table}" (${insertCols.map((c) => `"${c}"`).join(', ')}) VALUES ${valuesSql.join(', ')}`;

            if (op === 'upsert') {
                const conflict = spec.onConflict || inferConflict(table);
                if (conflict) {
                    const conflictCols = conflict.split(',').map((c) => c.trim());
                    if (conflictCols.some((c) => !cols.includes(c))) {
                        return err(res, 400, 'Invalid conflict target', 'PGRST104');
                    }
                    if (spec.ignoreDuplicates) {
                        sql += ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(', ')}) DO NOTHING`;
                    } else {
                        const updates = insertCols
                            .filter((c) => !conflictCols.includes(c))
                            .map((c) => `"${c}" = EXCLUDED."${c}"`);
                        sql += ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(', ')}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`;
                    }
                }
            } else if (spec.ignoreDuplicates) {
                sql += ' ON CONFLICT DO NOTHING';
            }

            if (spec.returning) sql += ' RETURNING *';
            const r = await query(sql, params);
            return res.json({ data: spec.returning ? r.rows : null, count: r.rowCount });
        }

        if (op === 'update') {
            const requiredKeys = PUBLIC_WRITE_KEYS[table];
            if (!requiredKeys) return err(res, 403, 'Updates are not allowed for this table', 'PGRST302');
            const filters = Array.isArray(spec.filters) ? spec.filters : [];
            const filteredKeys = new Set(filters.map((filter) => filter.col));
            if (filters.length === 0 || ![...requiredKeys].some((key) => filteredKeys.has(key))) {
                return err(res, 400, 'Update requires a record-identity filter', 'PGRST099');
            }
            if (table === 'user_profiles' && !filteredKeys.has('chain_id')) {
                return err(res, 400, 'Profile update requires wallet and chain filters', 'PGRST099');
            }
            const values = spec.values || {};
            const setCols = Object.keys(values).filter((c) => cols.includes(c));
            if (setCols.length === 0) return err(res, 400, 'No valid columns to update', 'PGRST204');
            const setSql = setCols.map((c) => { params.push(normalize(values[c])); return `"${c}" = $${params.length}`; });
            const where = buildWhere(spec.filters, cols, params);
            let sql = `UPDATE "${table}" SET ${setSql.join(', ')} ${where}`;
            if (spec.returning) sql += ' RETURNING *';
            const r = await query(sql, params);
            return res.json({ data: spec.returning ? r.rows : null, count: r.rowCount });
        }

        if (op === 'delete') {
            return err(res, 403, 'Deletes are not available through the public API', 'PGRST302');
        }

        return err(res, 400, `Unsupported op: ${op}`, 'PGRST100');
    } catch (e) {
        return err(res, 400, e.message, 'PGRST100');
    }
});

// JSON/array columns: pg accepts JS objects/arrays for jsonb only when passed
// as JSON strings via node-postgres for jsonb; plain objects work for jsonb but
// arrays intended as text[] must be arrays. node-postgres handles JS objects →
// jsonb automatically; we stringify nothing and let the driver map types.
function normalize(v) {
    if (v === undefined) return null;
    return v;
}

function inferConflict(table) {
    switch (table) {
        case 'marketplace_listings': return 'listing_id';
        case 'user_profiles': return 'wallet_address,chain_id';
        case 'sales_history': return 'transaction_hash';
        case 'auctions': return 'auction_id';
        case 'metadata_cache': return 'cache_key';
        case 'image_cache': return 'original_url';
        case 'marketplace_sync_meta': return 'key';
        case 'compliance_settings': return 'key';
        default: return null;
    }
}

// ── RPC endpoint (SECURITY DEFINER-style SQL functions) ────────────────────
const ALLOWED_RPCS = {
    rpc_check_sanctions: (args) => ({ sql: 'SELECT rpc_check_sanctions($1) AS data', params: [args.wallet_address] }),
    rpc_check_nft_contract: (args) => ({ sql: 'SELECT rpc_check_nft_contract($1) AS data', params: [args.contract_addr] }),
    rpc_dmca_create: (args) => ({ sql: 'SELECT rpc_dmca_create($1::jsonb) AS data', params: [JSON.stringify(args.payload ?? args)] }),
};

router.post('/rpc/:fn', async (req, res) => {
    const fn = req.params.fn;
    const builder = ALLOWED_RPCS[fn];
    if (!builder) return err(res, 400, `RPC not allowed: ${fn}`, 'PGRST202');
    try {
        const { sql, params } = builder(req.body || {});
        const r = await query(sql, params);
        return res.json({ data: r.rows[0] ? r.rows[0].data : null });
    } catch (e) {
        return err(res, 400, e.message, 'PGRST100');
    }
});

module.exports = router;
