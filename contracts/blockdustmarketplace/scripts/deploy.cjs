/**
 * Deploy BlockDustMarketplace behind a UUPS proxy.
 *
 *   FEE_RECIPIENT=0x… DEPLOY_PRIVATE_KEY=0x… \
 *     npx hardhat run scripts/deploy.cjs --network hyve
 *
 * The proxy address is what goes into src/config/chains.js — it is stable
 * across future upgrades. Nothing is auto-published; print, verify, then
 * update the frontend by hand.
 */
const { ethers, upgrades, network } = require('hardhat');

async function main() {
  const feeRecipient = process.env.FEE_RECIPIENT;
  if (!feeRecipient || !ethers.isAddress(feeRecipient)) {
    throw new Error('FEE_RECIPIENT (valid address) is required');
  }
  // The Vibe processor only exists on Vitruveo. Elsewhere the address is
  // unused because vibeShareBps is 0, but the initializer rejects 0x0.
  const feeProcessor = process.env.FEE_PROCESSOR || feeRecipient;

  const [deployer] = await ethers.getSigners();
  console.log(`\n── BlockDustMarketplace → ${network.name} (${network.config.chainId}) ──`);
  console.log('  deployer:    ', deployer.address);
  console.log('  feeRecipient:', feeRecipient);
  console.log('  feeProcessor:', feeProcessor);

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log('  gas balance: ', ethers.formatEther(bal));
  if (bal === 0n) throw new Error(`Deployer has no gas on ${network.name}`);

  const F = await ethers.getContractFactory('BlockDustMarketplace');
  const mkt = await upgrades.deployProxy(F, [feeRecipient, feeProcessor], {
    kind: 'uups',
  });
  await mkt.waitForDeployment();

  const proxy = await mkt.getAddress();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);

  console.log('\n  ✅ proxy:          ', proxy, '  <-- put this in chains.js');
  console.log('     implementation: ', impl);
  console.log('     owner:          ', await mkt.owner());
  console.log('     platformFeeBps: ', (await mkt.platformFeeBps()).toString());
  console.log('     vibeShareBps:   ', (await mkt.vibeShareBps()).toString());
  console.log('     version:        ', await mkt.version());

  console.log('\n  Next:');
  console.log(`    npx hardhat verify --network ${network.name} ${impl}`);
  console.log('    then set marketplaceAddress in src/config/chains.js to the PROXY');
}

main().catch((e) => { console.error(e); process.exit(1); });
