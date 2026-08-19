# Deployment runbook

Deploying replaces the live marketplace on a chain. Read this through before
running anything — the frontend keeps pointing at the old contract until you
change `src/config/chains.js`, so a half-finished deploy leaves the site on
the old address rather than broken.

## Current live state (read from chain 2026-08-19)

|              | Hyve (7847) | Vitruveo (1490) |
|--------------|-------------|-----------------|
| marketplace  | `0x89610b27E8f5685681666edf901Ad5c69d89DfB6` | `0x67cfCf4bE8447a083E6A2A1135Bd998FE91d3854` |
| owner        | `0x85444381DEb6d78f13DC029135C99b6C7c691FFC` | same |
| feeRecipient | `0x85444381DEb6d78f13DC029135C99b6C7c691FFC` | same |
| feeProcessor | `0x85444381DEb6d78f13DC029135C99b6C7c691FFC` | same |
| platformFee  | 250 bps | 250 bps |
| vibeShare    | 0 bps | 0 bps |
| auctions ever created | 0 | 0 |
| contract balance | 0 | 0 |
| active listings | **1** | 0 |

The single Hyve listing is the only thing to migrate. Nothing is escrowed.

## 0. Before you start

- The deployer key must be the address you want as **owner** — it can
  replace the implementation. Read [upgrade-ownership.md](upgrade-ownership.md).
- Fund the deployer with gas on the target chain.
- Confirm tests pass: `npx hardhat test` (22 passing).

## 1. Deploy

Vitruveo has the Vibe processor; Hyve does not, and `initialize` rejects the
zero address, so `FEE_PROCESSOR` falls back to `FEE_RECIPIENT` there. That
matches how the current contracts are configured.

```bash
cd contracts/blockdustmarketplace

export DEPLOY_PRIVATE_KEY=0x...          # deployer = initial owner
export FEE_RECIPIENT=0x85444381DEb6d78f13DC029135C99b6C7c691FFC

# Hyve
npx hardhat run scripts/deploy.cjs --network hyve

# Vitruveo — pass the real Vibe processor if you have one deployed
FEE_PROCESSOR=0x85444381DEb6d78f13DC029135C99b6C7c691FFC \
  npx hardhat run scripts/deploy.cjs --network vitruveo
```

The script prints **proxy** and **implementation**. Record both. The proxy is
the stable address; it does not change across upgrades.

## 2. Verify on the explorers

Verify the *implementation*, not the proxy:

```bash
npx hardhat verify --network hyve     <implementation address>
npx hardhat verify --network vitruveo <implementation address>
```

Vitruveo's Blockscout accepted verification for the predecessor, which is how
its source was recovered. Hyve's was never verified — worth doing this time so
the source is recoverable from chain.

## 3. Sanity-check the deployment before switching traffic

```bash
npx hardhat console --network hyve
> const m = await ethers.getContractAt('BlockDustMarketplace', '<proxy>')
> await m.version()            // "2.0.0"
> await m.owner()              // your deployer
> await m.platformFeeBps()     // 250n
> await m.vibeShareBps()       // 0n
> await m.maxRoyaltyBps()      // 1000n
> await upgrades.erc1967.getImplementationAddress('<proxy>')
```

Then do one **real end-to-end sale with a low-value NFT** before pointing the
site at it. Contract-level tests do not exercise your actual NFT contracts,
wallet flow, or the listing sync cron.

## 4. Point the frontend at the new proxies

Either edit the defaults in `src/config/chains.js`:

```js
marketplaceAddress: pick('HYVE', 'MARKETPLACE_ADDRESS', null, '<hyve proxy>'),
marketplaceAddress: pick('VITRUVEO', 'MARKETPLACE_ADDRESS', env.VITE_MARKETPLACE_ADDRESS, '<vitruveo proxy>'),
```

…or set `VITE_HYVE_MARKETPLACE_ADDRESS` / `VITE_VITRUVEO_MARKETPLACE_ADDRESS`,
which override without a code change.

The backend also reads `VITE_MARKETPLACE_ADDRESS` in its systemd unit for the
sync-listings cron — update `/etc/blockdust/backend.env` (or the unit) and
restart, or the cron keeps syncing the old contract.

Then:

```bash
npm run build && npm run deploy      # nginx webroot, NOT just a build
sudo systemctl restart blockdust-backend
```

## 5. Migrate the one Hyve listing

It cannot be moved programmatically — listings live in the old contract's
storage. Cancel it there and re-list on the new one, from the seller's wallet.

## 6. After it is stable

Move ownership to a multisig:

```bash
> await m.transferOwnership('<safe address>')
```

Do this while the deployer key is still fresh. See
[upgrade-ownership.md](upgrade-ownership.md).

## Rollback

The old contracts are untouched and still work. To revert, point
`chains.js` back at the old addresses, rebuild, redeploy the frontend. There
is no on-chain state to unwind, since the new contract escrows nothing.
