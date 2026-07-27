# BlockDust — Self-Hosted Backend Setup

This replaces the old **Supabase + Vercel** setup with a single Node/Express
service backed by **local PostgreSQL**. It:

- serves the built SPA (`../dist`),
- exposes the former Vercel `api/*` routes at `/api/*` (fixes the 405s that
  happened when those routes didn't exist under plain nginx),
- exposes a PostgREST-lite data API at `/api/db` that the frontend uses instead
  of talking to Supabase directly (browsers can't reach Postgres),
- runs the former Vercel crons as internal `setInterval` loops (no external
  cron pinger needed).

## Architecture

```
Browser (SPA)
  │  fetch('/api/db/query')  ← src/lib/pgRestClient.js (Supabase-compatible shim)
  │  fetch('/api/sync-listings'), '/api/metadata-cache', '/api/image-proxy', …
  ▼
backend/server.js  (Express, :8787)
  ├─ /api/db/*         → routes/db.js        → PostgreSQL (parameterized SQL)
  ├─ /api/sync-*       → api/*.js (ported)   → chain RPC + PostgreSQL
  ├─ /api/metadata-cache, /api/image-proxy, /api/prewarm-cache, /api/cache-metrics
  ├─ internal crons: sync-listings (5m), prewarm queue (2m)
  └─ static ../dist  (SPA fallback → index.html)
        │
        ▼
   PostgreSQL  ·  database: blockdust  ·  schema: db/schema.sql
```

The frontend seam is `src/context/SupabaseContext.jsx`, which now instantiates
`createPgRestClient()` (in `src/lib/pgRestClient.js`) instead of the Supabase
client. That shim reproduces the Supabase fluent API
(`.from().select().eq()…`, `.rpc()`, `.channel()`), so **no page component or
context needed to change** — they keep calling the same `supabase.*` methods.
Realtime channels are safe no-ops (the app already polls/refreshes).

## 1. Create the database

The local Postgres already runs on `127.0.0.1:5432`. Create a **separate**
`blockdust` database (do NOT reuse `hyvedash` / `pixelninjakitties`).

Creating a database requires a role with `CREATEDB` (e.g. the `postgres`
superuser). Run as an admin:

```bash
# As a Postgres superuser (peer auth or with the postgres password):
sudo -u postgres psql -c "CREATE DATABASE blockdust OWNER hyvedash;"
# (owner can be any role your backend will connect as)
```

> The `hyvedash` app role used for the default DSN cannot create databases, so
> this one step needs an admin. Everything after this works as `hyvedash`.

## 2. Apply the schema

```bash
cd backend
export DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/blockdust"
npm run schema          # runs: psql "$DATABASE_URL" -f db/schema.sql
# or directly:
psql "$DATABASE_URL" -f db/schema.sql
```

The schema is idempotent (safe to re-run). It creates the marketplace/auction
cache tables, metadata/image/prewarm/metrics cache tables, a
`marketplace_sync_meta` bookmark table, the compliance subset actually used by
the frontend, and the `rpc_*` SQL functions.

## 3. Configure environment

Set these for the backend (see `blockdust-backend.service` for a systemd
example, or export them in your shell):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | recommended | local `blockdust` DSN | Postgres connection |
| `PORT` | no | `8787` | HTTP port |
| `VITE_RPC_URL` | no | `https://rpc.vitruveo.xyz` | chain RPC |
| `VITE_MARKETPLACE_ADDRESS` | for sync | — | marketplace contract; required by `sync-listings` / `instant-sync` and their cron |
| `ENABLE_CRONS` | no | on | set `false` to disable internal cron loops |
| `INTERNAL_API_BASE` | no | `http://127.0.0.1:$PORT` | base the prewarm job uses to call metadata/image routes |

Frontend: if the backend is on a **different origin** than the SPA, set
`VITE_API_BASE_URL` at build time (e.g. `https://api.example.com`); otherwise
leave it unset and same-origin `/api/*` is used.

## 4. Build the frontend and run the backend

```bash
# from repo root — build the SPA the backend will serve:
npm install
npm run build

# start the backend:
cd backend
npm install
DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/blockdust" \
VITE_MARKETPLACE_ADDRESS=0xYOUR_MARKETPLACE \
npm start
# → http://127.0.0.1:8787   (health: /api/health)
```

Verify:

```bash
curl -s localhost:8787/api/health          # {"ok":true,"db":true,...}
curl -s localhost:8787/api/cache-metrics    # {"success":true,...}
```

## 5. (Optional) Install as a systemd service

`blockdust-backend.service` is provided but **not installed** (installing needs
root). Edit the `Environment=` lines, then:

```bash
sudo cp backend/blockdust-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blockdust-backend
sudo journalctl -u blockdust-backend -f
```

Put nginx in front and proxy `/api/*` (and, if you don't let the backend serve
static files, everything else) to `127.0.0.1:8787`. The internal crons replace
the old `vercel.json` cron entries, so no external cron pinger is needed.

## What was fully ported vs. stubbed

**Fully ported to Postgres:**
- Marketplace core: listings sync (`sync-listings`), instant sync
  (`instant-sync`), user collection sync (`sync-user-collections`).
- Metadata/image caching: `metadata-cache`, `image-proxy`, `prewarm-cache`,
  `cache-metrics`.
- Frontend data access (listings, profiles, sales, auctions, auction bids) via
  the pgRestClient shim → `/api/db`.
- Compliance reads/writes actually invoked by the app: `rpc_check_sanctions`,
  `rpc_check_nft_contract`, `rpc_dmca_create`, plus the sanctions/nft/dmca
  tables and logs.

**Intentionally stubbed / degraded (non-critical):**
- **Realtime** (`supabase.channel(...).on/subscribe/send`) — no-op. Live
  push updates are gone; the UI still refreshes via its existing polling.
- **`refresh_ma_gmv()`** — a no-op SQL function. The GMV materialized view /
  analytics on `ComplianceAdminPage` were not wired to real local data; the
  admin page tolerates empty results.
- Probed-but-nonexistent table names the pages try
  (`marketplace_auctions`, `auction_listings`, `legal_docs`,
  `ma_gmv_trailing_365`) return empty result sets instead of errors.

## Note on the old `api/` and `vercel.json`

The repo-root `api/*.js` (Supabase/Vercel versions) and `vercel.json` are left
in place but are **superseded** by `backend/api/*.js` + `backend/server.js`.
They are no longer used when serving via this backend and can be removed once
you're confident the self-hosted path is stable.
