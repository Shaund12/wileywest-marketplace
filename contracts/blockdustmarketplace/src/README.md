# VTRUNFTMarketplace source

`VTRUNFTMarketplace.sol` was recovered from the verified contract on the
Vitruveo Blockscout explorer, not from a local build. The repo previously
held only compiled artifacts; the original source and its Hardhat
`build-info` were both gone.

Source of truth:
https://explorer.vitruveo.ai/address/0x67cfCf4bE8447a083E6A2A1135Bd998FE91d3854

Compiler settings recorded by the explorer (needed to reproduce the
deployed bytecode):

    solc      v0.8.24+commit.e11b9ed9
    optimizer enabled, runs = 1000

Deployed at:

    Vitruveo (1490)  0x67cfCf4bE8447a083E6A2A1135Bd998FE91d3854   (verified)
    Hyve     (7847)  0x89610b27E8f5685681666edf901Ad5c69d89DfB6   (not verified)

Both are plain non-upgradeable contracts — there is no proxy. The ABI has no
`upgradeTo`/`proxiableUUID`, and `scripts/deploy-marketplace.mjs` deploys the
implementation directly with a constructor. Any contract change requires a
fresh deployment and a migration, not an upgrade.

There is no Hardhat/Foundry setup in this repo, so this source cannot be
compiled here as-is. It depends on OpenZeppelin v5 (`ReentrancyGuard` moved
to `utils/`).
