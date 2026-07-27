# Tests

Vitest. 113 tests that run with no database, plus 14 smoke tests that need a
live backend.

```bash
npm test              # everything runnable offline (smoke auto-skips)
npm run test:watch    # re-run on change
npm run test:unit     # tests/unit  — pure logic
npm run test:api      # tests/api   — Express routes, pg stubbed
npm run test:coverage # v8 coverage over the covered modules
npm run test:smoke    # needs a running backend, see below
```

Run a single file or a single case:

```bash
npx vitest run tests/api/db-allowlist.test.js
npx vitest run -t "refuses private tables"
```

## Layout

| Directory | Needs a DB? | What it covers |
|-----------|-------------|----------------|
| `tests/unit/` | no | `pgRestClient` shim, `chains.js` registry |
| `tests/api/` | no | `/api/db` allowlist, RPC/IPFS proxy, CORS + rate limiting |
| `tests/smoke/` | **yes** | the real server against real Postgres and real chain RPCs |

### Why the API tests stub PostgreSQL

`tests/helpers/testApp.js` swaps `db/pgClient` for a stub that records the SQL
text and bound parameters. That is deliberate, and stronger than asserting on
query results: it lets the suite prove that user input is *never* concatenated
into a SQL string. `tests/api/db-allowlist.test.js` asserts injection payloads
appear in `params` and never in `text`.

It also keeps `npm test` runnable on a fresh clone with no database.

### Why smoke tests are separate

Mocks cannot catch an unapplied migration, a missing SQL function, a dead RPC
upstream, or a bad systemd environment. The smoke suite catches exactly those,
so it is the one to run after deploying.

It skips itself unless `SMOKE_BASE_URL` is set, which is why `npm test` stays
green without a backend. Smoke tests are strictly read-only — they never
mutate marketplace data.

```bash
# against a local backend on the default port
npm run test:smoke

# against a deployed environment
SMOKE_BASE_URL=https://blockdust.pyvendr.com npm run test:smoke
```

Prerequisites for a local smoke run:

```bash
npm run build                              # smoke asserts the SPA is served
cd backend && npm run schema && npm start  # DB schema + server on :8787
```

One smoke test bursts 140 requests at `/api/db` to confirm the rate limiter
trips. It is **opt-in**, because the burst spends the shared `/api` budget
(300/min) and briefly makes the target return 429s to everyone:

```bash
SMOKE_RATE_LIMIT=1 npm run test:smoke
```

Don't enable it against production during traffic. If you run it twice in a
row, wait out the 60-second window or later requests will still be limited.

## Loading CommonJS from ESM tests

The backend is CommonJS and its dependencies (`express`, `pg`) live in
`backend/node_modules`, not the root. Test helpers therefore anchor
`createRequire` at `backend/package.json`, and patch `Module._load` to inject
the pg stub — `vi.mock` does not work here because the router resolves its
dependency eagerly at require-time.

`tests/helpers/testServer.js` loads the real `server.js` with `PORT=0` and
`ENABLE_CRONS=false` so it neither binds :8787 nor starts background chain
syncs, and it wraps `express.application.listen` to capture the server handle
for cleanup (`server.js` discards it). Always `await close()` in `afterAll` or
Vitest will hang on the open handle.

## Notes for adding tests

- Registering a new table in `backend/routes/db.js` should come with a case in
  `db-allowlist.test.js` asserting whether it is public, private, or writable.
- The RPC response cache in `server.js` is module-level and shared across
  tests in a file. Use params no other test uses when asserting MISS-then-HIT.
- `chains.js` reads `localStorage` and `import.meta.env` at module scope, so
  tests re-import it via `vi.resetModules()` after stubbing globals.
