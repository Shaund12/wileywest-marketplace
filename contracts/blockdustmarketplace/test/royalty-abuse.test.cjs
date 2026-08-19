const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('malicious royalty', function () {
  it('is clamped to maxRoyaltyBps instead of draining the seller', async () => {
    const [owner, seller, buyer, feeRecipient, attacker] = await ethers.getSigners();
    const proc = await (await ethers.getContractFactory('MockFeeProcessor')).deploy();
    const nft  = await (await ethers.getContractFactory('MockNFT')).deploy();
    const F = await ethers.getContractFactory('BlockDustMarketplace');
    const mkt = await upgrades.deployProxy(F, [feeRecipient.address, await proc.getAddress()], { kind: 'uups' });

    await nft.mint(seller.address);
    // 97.5% royalty -> passes `platformFee + royalty <= totalPrice`
    await nft.setRoyalty(attacker.address, 9750);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);
    await mkt.connect(seller).createListing(
      await nft.getAddress(), 1, 1, ethers.parseEther('100'), ethers.ZeroAddress);

    const sBefore = await ethers.provider.getBalance(seller.address);
    const aBefore = await ethers.provider.getBalance(attacker.address);
    await mkt.connect(buyer).buy(1, 1, { value: ethers.parseEther('100') });

    const sellerGot = await ethers.provider.getBalance(seller.address) - sBefore;
    const attackerGot = await ethers.provider.getBalance(attacker.address) - aBefore;
    console.log('      seller received  :', ethers.formatEther(sellerGot));
    console.log('      royalty receiver :', ethers.formatEther(attackerGot));
    // Clamped to maxRoyaltyBps (10%), not the 97.5% the collection asked for.
    expect(attackerGot).to.equal(ethers.parseEther('10'));
    expect(sellerGot).to.equal(ethers.parseEther('87.5'));
  });
});
