/**
 * Builds an Express app wired to the real /api/db router, but with the
 * PostgreSQL pool replaced by a recording stub.
 *
 * The point of these tests is the *allowlist and SQL-construction* layer in
 * backend/routes/db.js — that's the injection boundary between the browser and
 * the database. Running it against a live Postgres would test the driver too
 * and make the suite depend on a provisioned server. Instead we capture the
 * SQL text and bound parameters and assert on those directly, which is a
 * stronger check: we can prove user input never reaches the SQL string.
 *
 * This file is ESM (Vitest requires it) but the backend is CommonJS, so we
 * drive the CJS loader through createRequire.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_ROUTE = path.resolve(here, '../../backend/routes/db.js');
const PG_CLIENT = path.resolve(here, '../../backend/db/pgClient.js');

// express/pg are installed in backend/node_modules, not the root project, so
// anchor the CJS resolver inside backend/ rather than at this file.
const require = createRequire(path.resolve(here, '../../backend/package.json'));
const Module = require('node:module');

/**
 * Loads backend/routes/db.js with '../db/pgClient' swapped for our stub.
 * Patching Module._load (rather than vi.mock) is what works here: the router
 * is CommonJS and resolves its dependency eagerly at require-time.
 */
export function loadDbRouter(queryImpl) {
    const calls = [];
    const stub = {
        pool: {},
        healthCheck: async () => true,
        async query(text, params) {
            calls.push({ text, params });
            return queryImpl ? queryImpl(text, params) : { rows: [], rowCount: 0 };
        },
    };

    const originalLoad = Module._load;
    Module._load = function patched(request_, parent, isMain) {
        if (parent && parent.filename === DB_ROUTE && request_ === '../db/pgClient') {
            return stub;
        }
        return originalLoad.call(this, request_, parent, isMain);
    };

    try {
        delete require.cache[DB_ROUTE];
        delete require.cache[PG_CLIENT];
        return { router: require(DB_ROUTE), calls };
    } finally {
        Module._load = originalLoad;
        // Drop it again so the next test gets a router bound to its own stub.
        delete require.cache[DB_ROUTE];
    }
}

/** An Express app mounting the db router at /api/db, exactly as server.js does. */
export function makeDbApp(queryImpl) {
    const express = require('express');
    const { router, calls } = loadDbRouter(queryImpl);
    const app = express();
    app.use(express.json({ limit: '256kb', strict: true }));
    app.use('/api/db', router);
    return { app, calls };
}
