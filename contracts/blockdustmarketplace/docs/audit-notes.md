# Self-audit notes

Not a substitute for a third-party audit. This records what was checked, what
was found, and why the remaining static-analysis output is not acted on.

Tooling: Slither 0.11.6, plus 22 Hardhat tests
(`npx hardhat test`).

## Fixed: unbounded ERC-2981 royalty could drain the seller

**Severity: high.** Inherited from `VTRUNFTMarketplace`.

`royaltyInfo()` is answered by the *NFT contract*, which the seller does not
necessarily control. The only bound was
`platformFee + royaltyAmount <= totalPrice`, so a collection could name a
royalty just under the sale price.

Demonstrated in `test/royalty-abuse.test.cjs`: a collection claiming 9750 bps
on a 100-unit sale left the seller with **0** and sent 97.5 to the royalty
address. The sale succeeded, so the seller had no signal until the funds were
gone.

Fixed with `maxRoyaltyBps` (default 1000 = 10%, owner-adjustable). The royalty
is **clamped, not rejected** — a seller should still be able to sell an NFT
whose collection reports a silly royalty, and the buyer pays the listed price
regardless. Same test now asserts the seller receives 87.5.

## Reviewed and dismissed

### `reentrancy-eth` in `buy()` — false positive

Slither flags that `l.active = false` and `l.quantity -= buyQuantity` are
written after external calls, and warns about cross-function reentrancy via
`listings`.

`ReentrancyGuardUpgradeable` uses **one shared guard**, not a per-function
one — OpenZeppelin documents this ("because there is a single `nonReentrant`
guard, functions marked as `nonReentrant` may not call one another"). Every
state-mutating listing function (`buy`, `createListing`, `updateListingPrice`,
`cancelListing`) carries the modifier, so re-entry into *any* of them during
`buy` reverts.

Verified rather than assumed: `test/reentrancy.test.cjs` deploys a malicious
seller that re-enters `updateListingPrice` from its `receive()` during payout.
Re-entry fails.

### `arbitrary-send-eth` — inherent to the design

`buy` sends to the fee recipient, the royalty receiver, and the seller — all
addresses the contract does not control, which is what a marketplace does.
Every amount is derived from `msg.value` within the same call, and the
contract holds no balance to over-send from.

### `uninitialized-local` (`f`, `terms`) — not a defect

Both are memory structs whose fields are assigned before use. Solidity
zero-initializes memory, and `FeeCtx`/`SaleTerms` have every field written
prior to being read.

## Properties covered by tests

| Property | Test |
|---|---|
| No balance retained after native, royalty, or ERC-20 sales | `marketplace.test.cjs` |
| Stray native transfers revert (no `receive`/`fallback`) | `marketplace.test.cjs` |
| No auction/bid/withdraw in the ABI | `marketplace.test.cjs` |
| Cross-function reentrancy blocked | `reentrancy.test.cjs` |
| Malicious royalty clamped | `royalty-abuse.test.cjs` |
| Failed payout reverts; nothing stranded | `griefing.test.cjs` |
| Overpayment rejected, not kept | `griefing.test.cjs` |
| Stale listing (seller moved the NFT) reverts | `griefing.test.cjs` |
| ERC-1155 partial fills; cannot overbuy | `erc1155.test.cjs` |
| Implementation cannot be initialized directly | `upgrade-safety.test.cjs` |
| `initialize` cannot run twice | `upgrade-safety.test.cjs` |
| Only the owner can upgrade; authority follows ownership | `upgrade-safety.test.cjs` |
| Storage layout validated by the OZ plugin | `upgrade-safety.test.cjs` |
| State survives an upgrade | `upgrade-safety.test.cjs` |

## Known accepted behaviours

- **A royalty receiver that rejects ETH blocks native sales of that NFT.**
  `_sendNative` reverts on failure. The alternative — skipping a failed
  royalty — would let a collection be griefed out of royalties, and a
  gas-limited send would silently change who gets paid. Reverting is the
  safer failure. ERC-20 listings are unaffected.
- **The owner key can replace the implementation.** Unbounded, unlike
  `setPlatformFeeBps` (capped at 1000 bps). See
  [upgrade-ownership.md](upgrade-ownership.md); move ownership to a multisig
  before meaningful volume.
- **`maxRoyaltyBps` defaults to 10%.** Collections above that receive less
  than they ask for. Raise it with `setMaxRoyaltyBps` if a legitimate
  collection needs more.

## Not covered

No fuzzing/invariant testing (Echidna, Foundry), no formal verification, no
third-party review. This contract moves user funds; a real audit is warranted
before significant volume.
