require('@nomicfoundation/hardhat-toolbox');
require('@openzeppelin/hardhat-upgrades');

// Compiler settings match the deployed predecessor so bytecode stays
// comparable and explorer verification behaves predictably.
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 1000 },
      // SaleBreakdown carries 21 fields; without the IR pipeline the emit
      // exhausts the EVM stack.
      viaIR: true,
    },
  },
  networks: {
    hyve: {
      url: process.env.HYVE_RPC_URL || 'https://rpc.hyvechain.com',
      chainId: 7847,
      accounts: process.env.DEPLOY_PRIVATE_KEY ? [process.env.DEPLOY_PRIVATE_KEY] : [],
    },
    vitruveo: {
      url: process.env.VITRUVEO_RPC_URL || 'https://rpc.vitruveo.ai',
      chainId: 1490,
      accounts: process.env.DEPLOY_PRIVATE_KEY ? [process.env.DEPLOY_PRIVATE_KEY] : [],
    },
  },
};
