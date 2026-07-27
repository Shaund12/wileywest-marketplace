# Legacy Documentation (Archived)

These documents describe the **retired Supabase + Vercel architecture**. They
are kept for historical reference only — none of them reflect how the app runs
today. Do not follow their setup instructions.

## What replaced them

| Retired | Current |
|---------|---------|
| Supabase hosted Postgres | Self-hosted PostgreSQL (`backend/db/schema.sql`) |
| `@supabase/supabase-js` in the browser | `src/lib/pgRestClient.js` shim → `/api/db` |
| Vercel serverless `api/*` | `backend/api/*` mounted by `backend/server.js` |
| `vercel.json` crons | Internal `setInterval` loops in `backend/server.js` |
| Single-chain (Vitruveo) config | `src/config/chains.js` (Hyve + Vitruveo) |

Current setup lives in [backend/SETUP.md](../../backend/SETUP.md).

## Contents

**Schemas** — the old Supabase SQL. `backend/db/schema.sql` is the live schema
and is *not* a strict superset of these: tables for analytics/breakdown
features that were never wired up (`vibe_flows`, `vibe_hourly_stats`,
`collection_stats`, `royalty_payments`, `sale_breakdowns`, `fee_conversions`,
`token_fee_stats`, `auction_breakdowns`, `auction_settlements`, `admin_events`,
`admin_users`, `legal_docs`, `nft_tax_profile`) were deliberately left out. No
live code queries them. Keep these files if you ever want to port one over.

- `supabase-schema.sql` — core marketplace schema
- `supabase-compliance-schema.sql` — compliance tables
- `migration-add-sale-status.sql` — one-off migration

**Guides** — superseded operational docs:

- `SUPABASE_INTEGRATION.md`, `AUCTION_SUPABASE_SETUP.md`, `ENV_SETUP.md`
- `CRON_ARCHITECTURE.md`, `USER_COLLECTION_CRON.md`, `SYNC_TIMEOUT_FIX.md`
- `TROUBLESHOOTING_CACHE.md`, `MASS_DATA_PREVENTION.md`
- `Integrate_Supabase_Caching.md`
