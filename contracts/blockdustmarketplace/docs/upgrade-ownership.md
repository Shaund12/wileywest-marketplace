# Upgrade authority and the multisig plan

`BlockDustMarketplace` is UUPS-upgradeable. `_authorizeUpgrade` is gated on
`onlyOwner`, so **whoever holds the owner key can replace the entire contract
implementation** — including the logic that moves buyers' and sellers' funds.

That is a larger power than the other owner functions. `setPlatformFeeBps` is
capped at 1000 bps; an upgrade has no cap, because it can rewrite the cap.

## What the owner key can do today

| Action | Bounded? |
|---|---|
| `setPlatformFeeBps` | yes — `require(bps <= 1000)` |
| `setVibeShareBps` | yes — `require(bps <= 10_000)` |
| `setFeeRecipient` / `setFeeProcessor` | non-zero address only |
| `upgradeToAndCall` | **no** — arbitrary new logic |

There is no `withdraw`, no `receive`, and no `fallback`, so the owner cannot
sweep a balance. The contract never holds one. An upgrade could *introduce*
that ability, which is exactly why the key matters.

## Recommended before meaningful volume

1. **Move ownership to a Safe multisig.** No redeploy needed:

   ```
   mkt.transferOwnership(<safe address>)
   ```

   A 2-of-3 or 3-of-5 removes the single point of failure. Do this from the
   deployer key while it is still fresh.

2. **Consider a timelock owning the Safe** for upgrades specifically. A 48h
   delay means users can see a pending implementation change and exit first.
   This is the difference between "trust the operator" and "verify the
   operator", and it is what a security reviewer will ask about.

3. **Never `renounceOwnership()`.** It is inherited from OwnableUpgradeable
   and would permanently freeze fees, the recipient, and upgrades.

## Verifying the deployed implementation

After any upgrade, confirm what is actually live:

```
# implementation behind the proxy
npx hardhat console --network <chain>
> await upgrades.erc1967.getImplementationAddress('<proxy>')

# and that it matches verified source on the explorer
npx hardhat verify --network <chain> <implementation address>
```

`version()` is bumped per implementation; check it changed as expected.
