const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

// The ERC-1155 path lets one listing be bought in parts. Each partial buy
// recomputes royalties on that slice, so rounding is worth pinning down.
describe('ERC-1155 partial fills', function () {
  it('partial buys decrement quantity and never strand value', async () => {
    const [owner, seller, buyer, feeRecipient] = await ethers.getSigners();
    const proc = await (await ethers.getContractFactory('MockFeeProcessor')).deploy();
    const F = await ethers.getContractFactory('BlockDustMarketplace');
    const mkt = await upgrades.deployProxy(F, [feeRecipient.address, await proc.getAddress()], { kind: 'uups' });

    const M1155 = await ethers.getContractFactory('Mock1155');
    const nft = await M1155.deploy();
    await nft.mint(seller.address, 1, 10);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);

    await mkt.connect(seller).createListing(
      await nft.getAddress(), 1, 10, ethers.parseEther('1'), ethers.ZeroAddress);

    await mkt.connect(buyer).buy(1, 3, { value: ethers.parseEther('3') });
    let l = await mkt.listings(1);
    expect(l.quantity).to.equal(7n);
    expect(l.active).to.equal(true);
    expect(await ethers.provider.getBalance(await mkt.getAddress())).to.equal(0n);

    await mkt.connect(buyer).buy(1, 7, { value: ethers.parseEther('7') });
    l = await mkt.listings(1);
    expect(l.quantity).to.equal(0n);
    expect(l.active).to.equal(false);
    expect(await nft.balanceOf(buyer.address, 1)).to.equal(10n);
    expect(await ethers.provider.getBalance(await mkt.getAddress())).to.equal(0n);
  });

  it('cannot buy more than remains', async () => {
    const [owner, seller, buyer, feeRecipient] = await ethers.getSigners();
    const proc = await (await ethers.getContractFactory('MockFeeProcessor')).deploy();
    const F = await ethers.getContractFactory('BlockDustMarketplace');
    const mkt = await upgrades.deployProxy(F, [feeRecipient.address, await proc.getAddress()], { kind: 'uups' });
    const nft = await (await ethers.getContractFactory('Mock1155')).deploy();
    await nft.mint(seller.address, 1, 5);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);
    await mkt.connect(seller).createListing(
      await nft.getAddress(), 1, 5, ethers.parseEther('1'), ethers.ZeroAddress);

    await expect(mkt.connect(buyer).buy(1, 6, { value: ethers.parseEther('6') }))
      .to.be.revertedWith('not enough');
  });
});
