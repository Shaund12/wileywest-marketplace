# BlockDust Compliance Bundle Documentation

## Overview

The Day-1 Compliance Bundle adds comprehensive regulatory compliance features to BlockDust marketplace while maintaining **zero-downtime** and **backwards compatibility**. All features are controlled by environment variables and default to OFF.

## Feature Flags

All compliance features are controlled by feature flags in `.env` file:

```env
# Day-1 Compliance Flags (all default OFF for zero-downtime rollout)
VITE_FLAG_DMCA=0              # DMCA takedown system
VITE_FLAG_WISP=0              # Written Information Security Program
VITE_FLAG_SANCTIONS=0         # Sanctions screening
VITE_FLAG_TAX_SWITCH=0        # MA sales tax collection

# Compliance Configuration
VITE_OFAC_PROVIDER=local      # Sanctions provider: local | trm | chainalysis
VITE_TAX_GEO_MODE=none        # Tax geo: none | ip | self_declare
VITE_DMCA_AGENT_EMAIL=legal@blockdust.xyz
```

## Quick Start

### 1. Deploy with Flags OFF (Zero Risk)
```bash
# All flags default to 0 - no behavior changes
git pull origin main
npm run build
# Deploy to production
```

### 2. Apply Database Schema
```sql
-- In Supabase SQL editor:
-- Copy and paste contents of supabase-compliance-schema.sql
```

### 3. Enable Features Gradually
```env
# Enable one feature at a time, test, then move to next
VITE_FLAG_WISP=1      # Week 1
VITE_FLAG_DMCA=1      # Week 2  
VITE_FLAG_SANCTIONS=1 # Week 3
VITE_FLAG_TAX_SWITCH=1 # Week 4
```

## Features Summary

| Feature | Route | Flag | Description |
|---------|-------|------|-------------|
| DMCA Form | `/legal/dmca` | `VITE_FLAG_DMCA` | Public copyright takedown form |
| DMCA Admin | `/admin/dmca` | `VITE_FLAG_DMCA` | Review takedown requests |
| WISP | `/legal/wisp` | `VITE_FLAG_WISP` | Security program documentation |
| Sanctions Info | `/legal/sanctions` | `VITE_FLAG_SANCTIONS` | Screening policy page |
| Pricing | `/legal/pricing` | `VITE_FLAG_TAX_SWITCH` | Tax transparency page |
| Compliance Admin | `/admin/compliance` | Multiple | Manage all compliance settings |

## Rollback

**Instant rollback** (< 2 minutes):
```env
# Set all flags to 0
VITE_FLAG_DMCA=0
VITE_FLAG_WISP=0
VITE_FLAG_SANCTIONS=0
VITE_FLAG_TAX_SWITCH=0
```

Redeploy and all compliance features disappear. Existing flows unchanged.

## Testing Checklist

**With all flags OFF:**
- [ ] Connect wallet works
- [ ] Browse marketplace works
- [ ] List NFT works
- [ ] Buy NFT works
- [ ] No new modals or UI
- [ ] Compliance routes return 404

**With flags ON:**
- [ ] `/legal/dmca` renders and submits
- [ ] `/admin/dmca` shows submissions
- [ ] `/legal/wisp` displays content
- [ ] Sanctions modal appears for blocked addresses
- [ ] Tax calculations correct (when conditions met)

## Support

- **Technical:** GitHub Issues
- **Compliance:** compliance@blockdust.xyz  
- **Security:** security@blockdust.xyz

For detailed documentation, see sections below.

---

# Detailed Documentation

## 1. DMCA Takedown System

### Purpose
Comply with DMCA safe harbor requirements for user-generated content.

### Routes
- **`/legal/dmca`** - Public submission form
- **`/admin/dmca`** - Admin review interface

### Database Tables
```sql
dmca_takedowns (
  id uuid PRIMARY KEY,
  status dmca_status (open|actioned|closed),
  complainant_name text,
  complainant_email text,
  infringing_urls text[],
  original_work_urls text[],
  sworn_statement text,
  signature text,
  ...
)
```

### Workflow
1. Copyright holder visits `/legal/dmca`
2. Fills form with required information
3. Submits via `rpc_dmca_create()` RPC function
4. Admin reviews at `/admin/dmca`
5. Admin updates status
6. (Optional) Email sent to DMCA agent

### Implementation Files
- `src/pages/legal/DMCAPage.jsx`
- `src/pages/admin/DMCAAdminPage.jsx`
- `supabase-compliance-schema.sql` (lines 16-145)

---

## 2. WISP (Written Information Security Program)

### Purpose
Document security practices for regulatory compliance.

### Routes
- **`/legal/wisp`** - Public WISP page with download

### Database Tables
```sql
legal_docs (
  id uuid PRIMARY KEY,
  slug text UNIQUE,
  content_md text,
  version int,
  published_at timestamptz
)
```

### Features
- Markdown document storage
- Version tracking
- On-demand download
- Pre-populated default WISP

### Implementation Files
- `src/pages/legal/WISPPage.jsx`
- `supabase-compliance-schema.sql` (lines 147-219)

---

## 3. Sanctions Screening

### Purpose
Screen wallet addresses against OFAC and other sanctions lists.

### Routes
- **`/legal/sanctions`** - Policy information page

### Database Tables
```sql
sanctions_blocklist (
  address text UNIQUE,
  ref text,
  provider text
)

sanctions_logs (
  action text (connect|list|buy),
  address text,
  decision text (allow|block),
  provider text
)
```

### Screening Points
When `VITE_FLAG_SANCTIONS=1`:
1. **Connect** - Warns if address sanctioned
2. **List** - Blocks listing creation
3. **Buy** - Blocks purchase

### Providers
- **LocalList** (default): Supabase table
- **TRM Labs**: Stub (requires API key)
- **Chainalysis**: Stub (requires API key)

### Usage Example
```javascript
import { useSanctionsGate } from '../hooks/useSanctionsGate';

function MyComponent() {
  const { checkConnect, modalState, closeModal } = useSanctionsGate();
  
  const handleConnect = async (address) => {
    const allowed = await checkConnect(address);
    if (!allowed) return; // Blocked
    // Proceed...
  };
  
  return (
    <SanctionsModal {...modalState} onClose={closeModal} />
  );
}
```

### Implementation Files
- `src/pages/legal/SanctionsPage.jsx`
- `src/components/compliance/SanctionsModal.jsx`
- `src/hooks/useSanctionsGate.js`
- `src/utils/compliance/sanctionsAdapter.js`
- `supabase-compliance-schema.sql` (lines 221-307)

---

## 4. MA Tax Collection

### Purpose
Comply with Massachusetts marketplace facilitator tax laws.

### Routes
- **`/legal/pricing`** - Fee and tax transparency
- **`/admin/compliance`** - Admin tax settings

### Database Tables
```sql
compliance_settings (
  id int PRIMARY KEY DEFAULT 1,
  tax_switch_enabled boolean,
  tax_geo_mode text (none|ip|self_declare),
  facilitator_threshold_cents bigint,
  tax_rate_ma_percent decimal
)

nft_tax_profile (
  collection_address text PRIMARY KEY,
  is_taxable_ma boolean
)

ma_gmv_trailing_365 MATERIALIZED VIEW (
  gmv_vtru numeric,
  trades_count bigint
)
```

### Tax Logic
Tax applies when **ALL** conditions met:
1. `tax_switch_enabled = true`
2. Collection `is_taxable_ma = true`
3. GMV > threshold ($100k)
4. `tax_geo_mode != 'none'`
5. Buyer in Massachusetts

### Tax Rate
6.25% (MA sales tax)

### Admin Controls
- Toggle tax on/off
- Set geo mode
- View GMV metrics
- Refresh GMV view

### Usage Example
```javascript
import { shouldApplyTax, calculateTotalWithTax } from '../utils/compliance/taxCalculator';

const applyTax = shouldApplyTax({
  taxSwitchEnabled: true,
  isTaxableCollection: true,
  facilitatorGMV: 12000000, // $120k cents
  threshold: 10000000,
  geoMode: 'ip',
  isMaBuyer: true
});

if (applyTax) {
  const total = calculateTotalWithTax(priceWei, 6.25);
  // Show "Total (incl. tax): {total}"
}
```

### Implementation Files
- `src/pages/legal/PricingTransparencyPage.jsx`
- `src/pages/admin/ComplianceAdminPage.jsx`
- `src/utils/compliance/taxCalculator.js`
- `supabase-compliance-schema.sql` (lines 309-400)

---

## Database Schema

### Safe Deployment
All SQL uses safe patterns:
- `CREATE TABLE IF NOT EXISTS`
- `DO $ BEGIN ... IF NOT EXISTS`
- No `ALTER` on existing tables
- No `DROP` statements

### Apply Schema
```bash
# Via Supabase dashboard:
# 1. Go to SQL Editor
# 2. Copy contents of supabase-compliance-schema.sql
# 3. Execute

# Or via CLI:
supabase db push
```

### Verify Schema
```sql
-- Check tables
SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename LIKE '%compliance%' OR tablename LIKE '%dmca%' OR tablename LIKE '%sanctions%';

-- Check RPC functions
SELECT proname FROM pg_proc 
WHERE proname IN ('rpc_dmca_create', 'rpc_check_sanctions', 'refresh_ma_gmv');
```

---

## Deployment Strategy

### Phase 1: Deploy Code (Flags OFF)
```bash
# Merge PR
git checkout main
git pull origin main

# Build and deploy
npm run build
# Deploy dist/ to Vercel

# Result: Zero behavior change, new code dormant
```

### Phase 2: Apply Schema
```sql
-- In Supabase dashboard, run supabase-compliance-schema.sql
-- Creates tables, RPC functions, policies
-- Does not affect existing tables
```

### Phase 3: Test on Staging
```env
# staging .env
VITE_FLAG_DMCA=1
VITE_FLAG_WISP=1
VITE_FLAG_SANCTIONS=1
VITE_FLAG_TAX_SWITCH=1
```

Test each feature thoroughly.

### Phase 4: Gradual Production Enable
```env
# Week 1: WISP (lowest risk)
VITE_FLAG_WISP=1

# Week 2: DMCA (admin only)
VITE_FLAG_DMCA=1

# Week 3: Sanctions (user-facing)
VITE_FLAG_SANCTIONS=1

# Week 4: Tax (monitor calculations)
VITE_FLAG_TAX_SWITCH=1
```

Monitor metrics after each enable.

---

## Monitoring & Maintenance

### Key Metrics
1. DMCA takedowns/week
2. Sanctions block rate
3. Tax collected
4. Error rates
5. Page load times

### Regular Tasks
**Weekly:**
- Review DMCA submissions
- Check sanctions logs
- Refresh GMV view

**Monthly:**
- Update sanctions blocklist
- Review WISP content
- Audit tax calculations

**Quarterly:**
- Security audit
- Documentation update
- Threshold review

### Alerts
Set up for:
- High sanctions block rate (>5%)
- DMCA submission failures
- Tax calculation errors
- Database RPC failures

---

## Troubleshooting

### Routes return 404
**Cause:** Flag not enabled  
**Fix:** Set flag to `1` in `.env`, redeploy

### RPC function not found
**Cause:** Schema not applied  
**Fix:** Run `supabase-compliance-schema.sql`

### Sanctions always allow
**Cause:** Flag off or provider misconfigured  
**Fix:**
1. Check `VITE_FLAG_SANCTIONS=1`
2. Verify `VITE_OFAC_PROVIDER=local`
3. Test Supabase connection

### Tax not calculating
**Cause:** Conditions not met  
**Fix:** Verify all 5 conditions met (see Tax Logic section)

---

## Security

1. **Admin Access:** Grant only to trusted users
2. **DMCA PII:** Protect personal information
3. **Sanctions Data:** Keep updated, audit logs
4. **Tax Accuracy:** Regular calculation audits
5. **RLS:** Never disable Row Level Security

---

## Legal Disclaimer

This bundle provides technical infrastructure but is not legal advice. Consult qualified legal counsel regarding DMCA, sanctions, tax, and data protection compliance.

---

## Version History

**v1.0.0** (January 2025)
- Initial Day-1 Compliance Bundle
- DMCA takedown system
- WISP documentation
- Sanctions screening (LocalList)
- MA tax collection
- Feature-flagged deployment
- Zero-downtime rollout support
