const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('cross-function reentrancy during buy()', function () {
  it('a malicious seller can re-enter through updateListingPrice', async () => {
    const [owner, buyer, feeRecipient] = await ethers.getSigners();
    const proc = await (await ethers.getContractFactory('MockFeeProcessor')).deploy();
    const nft  = await (await ethers.getContractFactory('MockNFT')).deploy();
    const F    = await ethers.getContractFactory('BlockDustMarketplace');
    const mkt  = await upgrades.deployProxy(F, [feeRecipient.address, await proc.getAddress()], { kind: 'uups' });

    const atk = await (await ethers.getContractFactory('ReentrantSeller')).deploy();
    const atkAddr = await atk.getAddress();

    // attacker owns and lists the NFT
    await nft.mint(atkAddr);
    const tokenId = 1n;

    // approve + list on the attacker's behalf via impersonation
    await ethers.provider.send('hardhat_impersonateAccount', [atkAddr]);
    await ethers.provider.send('hardhat_setBalance', [atkAddr, '0x56BC75E2D63100000']);
    const atkSigner = await ethers.getSigner(atkAddr);
    await nft.connect(atkSigner).setApprovalForAll(await mkt.getAddress(), true);
    await mkt.connect(atkSigner).createListing(
      await nft.getAddress(), tokenId, 1, ethers.parseEther('10'), ethers.ZeroAddress);
    await ethers.provider.send('hardhat_stopImpersonatingAccount', [atkAddr]);

    await atk.set(await mkt.getAddress(), 1);
    await mkt.connect(buyer).buy(1, 1, { value: ethers.parseEther('10') });

    console.log('      re-entry succeeded:', await atk.reenterSucceeded());
    console.log('      listing after buy :', await mkt.listings(1));

    // If the guard were sufficient this would be false.
    expect(await atk.reenterSucceeded()).to.equal(false);
  });
});
