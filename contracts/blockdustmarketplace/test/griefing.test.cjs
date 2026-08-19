const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('payout failure handling', function () {
  let mkt, nft, proc, owner, seller, buyer, feeRecipient;

  beforeEach(async () => {
    [owner, seller, buyer, feeRecipient] = await ethers.getSigners();
    proc = await (await ethers.getContractFactory('MockFeeProcessor')).deploy();
    nft  = await (await ethers.getContractFactory('MockNFT')).deploy();
    const F = await ethers.getContractFactory('BlockDustMarketplace');
    mkt = await upgrades.deployProxy(F, [feeRecipient.address, await proc.getAddress()], { kind: 'uups' });
  });

  it('a royalty receiver that rejects ETH blocks every native sale of that NFT', async () => {
    // Rejector: no receive/fallback, so any ETH send to it reverts.
    const rejector = await (await ethers.getContractFactory('MockFeeProcessor')).deploy();
    // MockFeeProcessor has a payable fn but no receive -> plain send reverts.
    await nft.mint(seller.address);
    await nft.setRoyalty(await rejector.getAddress(), 500);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);
    await mkt.connect(seller).createListing(
      await nft.getAddress(), 1, 1, ethers.parseEther('10'), ethers.ZeroAddress);

    await expect(
      mkt.connect(buyer).buy(1, 1, { value: ethers.parseEther('10') })
    ).to.be.revertedWith('native send fail');
  });

  it('rounding: a 1 wei sale does not underflow or strand value', async () => {
    await nft.mint(seller.address);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);
    await mkt.connect(seller).createListing(
      await nft.getAddress(), 1, 1, 1n, ethers.ZeroAddress);

    const before = await ethers.provider.getBalance(await mkt.getAddress());
    await mkt.connect(buyer).buy(1, 1, { value: 1n });
    const after = await ethers.provider.getBalance(await mkt.getAddress());
    expect(after - before).to.equal(0n);   // nothing stranded
  });

  it('overpaying native is rejected rather than kept', async () => {
    await nft.mint(seller.address);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);
    await mkt.connect(seller).createListing(
      await nft.getAddress(), 1, 1, ethers.parseEther('1'), ethers.ZeroAddress);

    await expect(
      mkt.connect(buyer).buy(1, 1, { value: ethers.parseEther('2') })
    ).to.be.revertedWith('wrong msg.value');
    expect(await ethers.provider.getBalance(await mkt.getAddress())).to.equal(0n);
  });

  it('a listing survives the seller no longer owning the NFT (stale listing reverts)', async () => {
    await nft.mint(seller.address);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);
    await mkt.connect(seller).createListing(
      await nft.getAddress(), 1, 1, ethers.parseEther('1'), ethers.ZeroAddress);
    // seller moves the NFT away after listing
    await nft.connect(seller).transferFrom(seller.address, owner.address, 1);

    await expect(
      mkt.connect(buyer).buy(1, 1, { value: ethers.parseEther('1') })
    ).to.be.reverted;
    expect(await ethers.provider.getBalance(await mkt.getAddress())).to.equal(0n);
  });
});
