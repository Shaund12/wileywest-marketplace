/**
 * Deploy BlockDust's VTRUNFTMarketplace to a chain, Vibe-safe.
 *
 *   node scripts/deploy-marketplace.mjs <hyve|vitruveo>
 *
 * Uses the PROVEN Vibe-safe recipe (see vibe-safety-test):
 *   1. deploy VTRUNFTMarketplace(feeRecipient, feeRecipient)   [feeProcessor != 0x0 required]
 *   2. setVibeShareBps(0)                                       [neutralize Vibe]
 *   3. ensure platformFeeBps == 250 (2.5%)
 *
 * Deploy key: DEPLOY_PRIVATE_KEY (or PRIVATE_KEY). Fee recipient: FEE_RECIPIENT.
 * Reads the compiled artifact bytecode+abi (no Solidity source needed).
 */
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(__dirname, '../contracts/blockdustmarketplace/artifacts/VTRUNFTMarketplace.sol/VTRUNFTMarketplace.json');

const CHAINS = {
  hyve:     { id: 7847, rpc: process.env.HYVE_RPC_URL     || 'https://rpc.hyvechain.com', explorer: 'https://explorer.hyvechain.com' },
  vitruveo: { id: 1490, rpc: process.env.VITRUVEO_RPC_URL || 'https://rpc.vitruveo.ai',   explorer: 'https://explorer.vitruveo.ai' },
};

const TARGET_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || 250); // 2.5%

async function main() {
  const which = (process.argv[2] || '').toLowerCase();
  const chain = CHAINS[which];
  if (!chain) { console.error('Usage: node scripts/deploy-marketplace.mjs <hyve|vitruveo>'); process.exit(1); }

  const rawKey = process.env.DEPLOY_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!rawKey) throw new Error('DEPLOY_PRIVATE_KEY (or PRIVATE_KEY) is required');
  const key = rawKey.startsWith('0x') ? rawKey : '0x' + rawKey;

  const feeRecipient = process.env.FEE_RECIPIENT;
  if (!feeRecipient || !ethers.isAddress(feeRecipient)) throw new Error('FEE_RECIPIENT (valid address) is required');

  const provider = new ethers.JsonRpcProvider(chain.rpc, { chainId: chain.id, name: which }, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);
  const mk = JSON.parse(fs.readFileSync(ART, 'utf8'));

  console.log(`\n── Deploying VTRUNFTMarketplace to ${which} (chain ${chain.id}) ──`);
  console.log('  deployer:    ', wallet.address);
  console.log('  feeRecipient:', feeRecipient);
  const bal = await provider.getBalance(wallet.address);
  console.log('  deployer gas:', ethers.formatEther(bal));
  if (bal === 0n) throw new Error(`Deployer has 0 gas on ${which}. Fund ${wallet.address} first.`);

  // 1) deploy with feeProcessor = feeRecipient (nonzero; ctor rejects 0x0)
  const Factory = new ethers.ContractFactory(mk.abi, mk.bytecode, wallet);
  console.log('\n  deploying…');
  const market = await Factory.deploy(feeRecipient, feeRecipient);
  await market.waitForDeployment();
  const addr = await market.getAddress();
  console.log('  ✅ deployed at:', addr);
  console.log('     tx:', market.deploymentTransaction()?.hash);

  // 2) neutralize Vibe
  const vibeBefore = await market.vibeShareBps();
  if (vibeBefore !== 0n) {
    console.log(`\n  setVibeShareBps(0)  (was ${vibeBefore})…`);
    await (await market.setVibeShareBps(0)).wait();
  }
  console.log('  vibeShareBps():', (await market.vibeShareBps()).toString(), '(Vibe neutralized)');

  // 3) ensure platform fee
  const feeBps = await market.platformFeeBps();
  if (Number(feeBps) !== TARGET_FEE_BPS) {
    console.log(`\n  setPlatformFeeBps(${TARGET_FEE_BPS})  (was ${feeBps})…`);
    await (await market.setPlatformFeeBps(TARGET_FEE_BPS)).wait();
  }
  console.log('  platformFeeBps():', (await market.platformFeeBps()).toString());
  console.log('  feeRecipient():', await market.feeRecipient());
  console.log('  feeProcessor():', await market.feeProcessor(), '(= feeRecipient, not a Vibe contract)');
  console.log('  owner():', await market.owner());

  console.log(`\n🎉 ${which} marketplace live: ${addr}`);
  console.log(`   ${chain.explorer}/address/${addr}`);
  console.log(`\n   → set in src/config/chains.js: CHAINS[${chain.id}].marketplaceAddress = '${addr}'`);
  console.log(`   → or in .env: VITE_${which.toUpperCase()}_MARKETPLACE_ADDRESS=${addr}`);
}

main().catch((e) => { console.error('❌ deploy failed:', e.shortMessage || e.message || e); process.exit(1); });
