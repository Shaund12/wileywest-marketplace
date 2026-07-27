# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Frontend (repo root):

```bash
npm install          # ~3-5 min on a cold cache
npm run dev          # Vite dev server on :5173
npm run build        # → dist/ (~20s)
npm run preview      # serve the built dist/ on :4173
```

Backend (`backend/`, separate `package.json` and `node_modules`):

```bash
cd backend
npm install
npm run schema       # psql "$DATABASE_URL" -f db/schema.sql
npm start            # Express on :8787 — serves ../dist AND /api/*
```

Health checks once the backend is up:

```bash
curl -s 'localhost:8787/api/health?format=json'   # {"ok":true,"db":true,...}
curl -s localhost:8787/api/cache-metrics
```

`/api/health` content-negotiates — without `?format=json` a browser-ish
`Accept` header gets the HTML status page.

Tests (Vitest):

```bash
npm test                  # unit + api; needs no database (smoke auto-skips)
npm run test:unit         # pure logic
npm run test:api          # Express routes with pg stubbed
npm run test:smoke        # requires a RUNNING backend, see tests/README.md
npx vitest run -t "name"  # a single case
```

`npm test` must stay runnable on a bare clone with no database — that's why
the API tests stub the pg pool and the smoke suite skips itself unless
`SMOKE_BASE_URL` is set. See [tests/README.md](tests/README.md) for the
CommonJS-from-ESM loading details, which are fiddly.

**There is no lint setup.** ESLint v9 is installed with no `eslint.config.js`,
so `npx eslint .` fails. Don't claim lint passes.

Note that `npm run dev` alone serves the SPA but **not** `/api/*` — anything
touching data needs the backend running too.

## Architecture

A React 18 + Vite SPA plus a self-hosted Express/PostgreSQL backend. The
backend serves the built SPA *and* the API from one origin, so relative
`fetch('/api/...')` calls resolve without CORS or a proxy.

```
Browser SPA
  ├─ fetch('/api/db/*')   ← src/lib/pgRestClient.js (Supabase-compatible shim)
  ├─ fetch('/api/rpc/:chain'), '/api/ipfs/*', '/api/metadata-cache', …
  ▼
backend/server.js (Express :8787)
  ├─ /api/db/*      → routes/db.js  → PostgreSQL (parameterized SQL)
  ├─ /api/sync-*, /api/metadata-cache, /api/image-proxy, /api/prewarm-cache
  ├─ /api/rpc/:chain, /api/ipfs/*   → allowlisted upstream proxies
  ├─ internal crons: sync-listings (5m), prewarm queue (2m)
  └─ static ../dist (SPA fallback → index.html)
```

### `SupabaseContext` does not use Supabase

The most important thing to know before touching data code. Supabase was
replaced by self-hosted Postgres, but the migration deliberately kept the
Supabase client *API surface* so ~20 call sites didn't need rewriting:

- [src/lib/pgRestClient.js](src/lib/pgRestClient.js) reimplements the fluent
  API (`.from().select().eq().order()`, `.upsert()`, `.rpc()`, `.channel()`)
  as a thenable query builder that POSTs to `/api/db`.
- [src/context/SupabaseContext.jsx](src/context/SupabaseContext.jsx)
  instantiates it via `createPgRestClient()`.

So `supabase.from('marketplace_listings').select('*')` in a page component is
**current, working code** — not leftover Supabase usage. Keep new data access
on the same shim rather than adding a parallel fetch layer. Realtime
(`.channel()/.subscribe()`) is an intentional no-op; the app polls instead.

### `/api/db` is an allowlist, not a passthrough

[backend/routes/db.js](backend/routes/db.js) is the injection guard. A new
table or column is invisible to the frontend until registered there:

- `TABLES` — permitted tables mapped to their real columns; unlisted
  identifiers are rejected.
- `PRIVATE_TABLES` — never reachable from the browser (caches, sync meta, and
  all moderation/compliance tables). Reads of these go through purpose-built
  RPCs that return only a decision.
- `PUBLIC_WRITE_KEYS` — which conflict keys an anonymous upsert may target.
- `ALLOWED_RPCS` — the only callable SQL functions (`rpc_check_sanctions`,
  `rpc_check_nft_contract`, `rpc_dmca_create`).
- `SOFT_MISSING` — table names some pages probe that don't exist
  (`legal_docs`, `marketplace_auctions`, …). These return an empty result
  instead of an error so those pages degrade gracefully. If a query
  mysteriously returns nothing, check this set before assuming a bug.

`backend/db/schema.sql` is the live schema. It is intentionally **not** a
superset of the archived Supabase schemas in `docs/legacy/` — analytics tables
that were never wired up (`vibe_flows`, `collection_stats`,
`royalty_payments`, …) were dropped. No live code queries them.

Registering a table here should come with a case in
`tests/api/db-allowlist.test.js` pinning whether it is public, private, or
writable. Those tests assert on the generated SQL text and bound parameters,
so they fail loudly if a value ever reaches the query string un-parameterized.

### Multichain

[src/config/chains.js](src/config/chains.js) is the single source of truth:
Hyve (7847, the default) and Vitruveo (1490).

- The active chain is a **runtime user choice** persisted to `localStorage`,
  not an env var. `ChainSwitcher` calls `setActiveChainId()` then does a full
  `window.location.reload()` — chain state is read at module scope in several
  places, so don't assume a switch propagates reactively.
- Vitruveo has DeFi primitives Hyve lacks (Vibe fee processor, RevShare, WVTRU
  wrapping, Uniswap pricing). These are declared per-chain in the `features`
  map and must be gated with `chainHasFeature('vibe')` etc. — never assume a
  contract address exists. Use `chainAddress(name)`, which returns `''` when
  absent.
- Per-chain env overrides are `VITE_<CHAINKEY>_<FIELD>` (e.g.
  `VITE_HYVE_MARKETPLACE_ADDRESS`). Legacy single-chain `VITE_RPC_URL` /
  `VITE_MARKETPLACE_ADDRESS` still resolve as the *Vitruveo* fallback only.
- Hyve's upstream RPC blocks browser CORS, so its `rpcUrl` points at the
  same-origin `/api/rpc/hyve` proxy, which allowlists JSON-RPC methods.
  Browser code must not call the Hyve RPC directly.

### Compliance

Feature-flagged and OFF by default (`VITE_FLAG_DMCA`, `VITE_FLAG_WISP`,
`VITE_FLAG_SANCTIONS`, `VITE_FLAG_TAX_SWITCH`). Auctions are gated per-chain
via the registry, plus an optional wallet allowlist
(`VITE_AUCTIONS_WALLET_ALLOWLIST`) in
[src/utils/featureFlags.js](src/utils/featureFlags.js). See
[docs/compliance.md](docs/compliance.md).

### Data-collection guardrails

Chain scanning is deliberately bounded to prevent mass data collection (a past
incident produced 15,000+ records). In
[src/utils/nftScanner.js](src/utils/nftScanner.js) the scans are capped to a
trailing block window rather than full history — ~200k blocks for discovery,
5k for pattern analysis — with a `scanFromGenesis` escape hatch that should
stay off by default. Concurrency and timeouts are tunable via
`VITE_MAX_CONCURRENT_*` / `VITE_*_TIMEOUT`, and `VITE_MAX_LISTING_SCAN` caps
listings scanned. Treat these ceilings as intentional; widening them is a
deliberate decision, not a cleanup.

(The note in `.env.example` about re-enabling caching by searching for
`DISABLED:` is stale — no such markers remain in the code.)

## Deployment

Self-hosted via the systemd unit at `backend/blockdust-backend.service`. Crons
run as internal `setInterval` loops in `server.js`; `ENABLE_CRONS=false`
disables them. There is no external cron pinger.

### `npm run build` alone does not deploy the frontend

In production, **nginx serves the SPA from `/var/www/blockdust`, not from this
repo's `dist/`.** Express (`:8787`) only handles `/api/*`; nginx never proxies
static files to it. So a build updates `dist/`, nginx keeps serving its own
copy, and restarting the backend changes nothing about what the browser gets.

Deploying the frontend is a file copy:

```bash
npm run deploy      # vite build, then cp -a dist/. /var/www/blockdust/
```

Override the destination with `BLOCKDUST_WEBROOT` if needed. Restart the
systemd unit only for **backend** changes (`backend/**`).

The symptom of forgetting this is a new route 404ing or redirecting to `/`
while `curl localhost:8787` serves the new bundle correctly — two different
servers, one stale. Compare the hashed bundle name from
`curl -s https://<host>/ | grep -o 'assets/index-[a-z0-9]*\.js'` against
`dist/index.html` to confirm what is actually live.

**Vercel and Supabase are fully retired** — `vercel.json`, the root `api/`
serverless functions, and both SDK packages have been removed. Their docs are
archived in [docs/legacy/](docs/legacy/) for reference only; do not follow
their setup instructions. `.github/copilot-instructions.md` also predates this
migration — its Supabase env vars, Vercel deployment section, and
Vitruveo-only assumptions are stale.
