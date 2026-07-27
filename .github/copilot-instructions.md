# BlockDust NFT Marketplace — agent instructions

Cyberpunk multichain NFT marketplace. React 18 + Vite SPA, plus a self-hosted
Express + PostgreSQL backend that serves both the built SPA and the API.

> The canonical guidance lives in [CLAUDE.md](../CLAUDE.md) — architecture,
> the data-access seam, and the gotchas. This file is a summary; prefer
> CLAUDE.md when the two disagree.

## Commands

```bash
npm install          # ~3-5 min cold
npm run dev          # Vite dev server on :5173 (SPA only — no /api/*)
npm run build        # → dist/
npm test             # Vitest: unit + API, no database needed
npm run test:smoke   # end-to-end against a RUNNING backend
```

Backend (separate package in `backend/`):

```bash
cd backend && npm install
npm run schema       # apply db/schema.sql
npm start            # Express on :8787, serves ../dist and /api/*
```

Anything touching data needs the backend running; `npm run dev` alone will
404 every `/api/*` call.

`npx eslint .` currently fails — ESLint v9 is installed with no
`eslint.config.js`. Don't report lint as passing.

## Architecture essentials

- **`SupabaseContext` does not use Supabase.** Supabase was replaced by
  self-hosted PostgreSQL, but `src/lib/pgRestClient.js` reimplements the
  Supabase fluent API (`.from().select().eq()`, `.rpc()`, `.channel()`) over
  `/api/db`. Existing `supabase.*` calls are current, working code — don't
  "clean them up". Realtime is an intentional no-op.
- **`/api/db` is an allowlist.** `backend/routes/db.js` gates every table,
  column, write key, and RPC. A new table is invisible to the frontend until
  registered there. Deletes are never permitted.
- **Multichain.** `src/config/chains.js` is the source of truth (Hyve 7847
  default, Vitruveo 1490). The active chain is a runtime user choice in
  `localStorage`, not an env var, and switching triggers a full page reload
  because many modules read the chain at module scope.
- **Chain-gate Vitruveo-only features.** Vibe, RevShare, WVTRU, and Uniswap
  pricing don't exist on Hyve. Use `chainHasFeature(...)` and
  `chainAddress(...)` rather than assuming an address exists.
- **Vercel and Supabase are retired.** No `vercel.json`, no serverless `api/`
  directory, neither SDK is installed. Crons run as `setInterval` loops in
  `backend/server.js`. Archived docs are in `docs/legacy/` — reference only.

## Testing expectations

- `npm test` must keep working with no database. API tests stub the pg pool;
  smoke tests skip themselves unless `SMOKE_BASE_URL` is set.
- Changes to `backend/routes/db.js` should come with a case in
  `tests/api/db-allowlist.test.js`.
- See [tests/README.md](../tests/README.md) for layout and the
  CommonJS-from-ESM loading details.

## Validation before declaring done

1. `npm test` passes.
2. `npm run build` succeeds.
3. For data or chain changes, run the backend and exercise the affected pages
   (`/`, `/marketplace`, `/sell`, `/profile`), or run `npm run test:smoke`.
