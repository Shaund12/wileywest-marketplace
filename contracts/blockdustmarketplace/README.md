# BlockDust marketplace contracts

Hardhat project for `BlockDustMarketplace` — the fixed-price, UUPS-upgradeable
successor to `VTRUNFTMarketplace`.

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Why a new contract

The deployed `VTRUNFTMarketplace` (Hyve `0x8961…`, Vitruveo `0x67cf…`) is a
plain, non-upgradeable contract — verified on-chain: all three EIP-1967 slots
are empty and the runtime exposes no `upgradeTo`/`proxiableUUID`. It could not
be changed in place, only replaced.

Two things changed in the replacement:

**Auctions are gone.** The predecessor escrowed the NFT in `createAuction` and
bid funds in `bid`, refunding the previous bidder on each raise. That is
custody of user assets. `buy` never did this — it settles atomically — so
removing auctions removes the only custodial path. Nothing was stranded: at
the time of the rewrite, zero auctions had ever been created on either chain
and both contracts held a zero balance.

**`withdraw` is gone**, along with `receive`/`fallback`. With no escrow there
is nothing legitimate to sweep, and a payable fallback would only let stray
transfers accumulate where nobody could retrieve them. Native currency sent
outside `buy` now reverts. `test/marketplace.test.cjs` asserts a zero contract
balance after native, royalty-bearing, and ERC-20 sales.

## Deploying

```bash
FEE_RECIPIENT=0x… DEPLOY_PRIVATE_KEY=0x… \
  npx hardhat run scripts/deploy.cjs --network hyve
```

The script prints the **proxy** address — that is what belongs in
`src/config/chains.js`, and it stays stable across upgrades. On Vitruveo also
pass `FEE_PROCESSOR` (the Vibe processor); elsewhere it defaults to the fee
recipient, since `vibeShareBps` is 0 and the initializer rejects `0x0`.

Read [docs/upgrade-ownership.md](docs/upgrade-ownership.md) before deploying —
the owner key can replace the implementation, and it should not stay a single
EOA for long.

## Notes

- `solc 0.8.24`, optimizer at 1000 runs, **`viaIR` required** — the 21-field
  `SaleBreakdown` event exhausts the stack under the legacy pipeline.
- OpenZeppelin is pinned to `5.0.2`: `ReentrancyGuardUpgradeable` was removed
  in 5.6.
- `src/VTRUNFTMarketplace.sol` is the recovered predecessor source, kept for
  reference. It is not part of this build.
