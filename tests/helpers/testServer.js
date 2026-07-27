/**
 * Loads the real backend/server.js for route-level tests.
 *
 * server.js calls app.listen() and starts cron intervals at require-time, so
 * loading it naively would bind :8787 and kick off background chain syncs.
 * We neutralise that by:
 *   - PORT=0            → the OS picks a free ephemeral port
 *   - ENABLE_CRONS=false → skip the sync/prewarm intervals
 *   - stubbing db/pgClient so nothing needs a live PostgreSQL
 *   - stubbing global fetch so no request escapes to a real RPC/IPFS host
 *
 * closeServer() must be called in afterAll or vitest will hang on the handle.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '../../backend');
const require = createRequire(path.resolve(backendDir, 'package.json'));
const Module = require('node:module');

const SERVER = path.resolve(backendDir, 'server.js');
const PG_CLIENT = path.resolve(backendDir, 'db/pgClient.js');

/**
 * @param {object} opts
 * @param {(text:string, params:any[]) => any} [opts.query] pg query stub
 * @returns {{ app: import('express').Express, close: () => Promise<void> }}
 */
export function loadServer({ query } = {}) {
    const prevPort = process.env.PORT;
    const prevCrons = process.env.ENABLE_CRONS;
    process.env.PORT = '0';
    process.env.ENABLE_CRONS = 'false';

    const pgStub = {
        pool: { end: async () => {} },
        healthCheck: async () => true,
        query: query || (async () => ({ rows: [], rowCount: 0 })),
    };

    // server.js discards the value of app.listen(), so wrap express's
    // application prototype to capture the http.Server we need to close.
    const express = require('express');
    const listeners = [];
    const originalListen = express.application.listen;
    express.application.listen = function capturedListen(...args) {
        const server = originalListen.apply(this, args);
        listeners.push(server);
        return server;
    };

    const originalLoad = Module._load;
    Module._load = function patched(request_, parent, isMain) {
        // Both server.js and the ported api/* handlers pull in pgClient.
        if (request_.endsWith('db/pgClient') || request_.endsWith('../db/pgClient')) {
            return pgStub;
        }
        return originalLoad.call(this, request_, parent, isMain);
    };

    let app;
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(backendDir)) delete require.cache[key];
        }
        app = require(SERVER);
    } finally {
        Module._load = originalLoad;
        express.application.listen = originalListen;
        if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
        if (prevCrons === undefined) delete process.env.ENABLE_CRONS; else process.env.ENABLE_CRONS = prevCrons;
    }

    return {
        app,
        async close() {
            await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve))));
            for (const key of Object.keys(require.cache)) {
                if (key.startsWith(backendDir)) delete require.cache[key];
            }
        },
    };
}
