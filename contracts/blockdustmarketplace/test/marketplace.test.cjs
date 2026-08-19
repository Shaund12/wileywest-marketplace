const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('BlockDustMarketplace', function () {
  let mkt, nft, erc20, proc, owner, seller, buyer, feeRecipient, royaltyRx;

  beforeEach(async () => {
    [owner, seller, buyer, feeRecipient, royaltyRx] = await ethers.getSigners();
    proc = await (await ethers.getContractFactory('MockFeeProcessor')).deploy();
    nft  = await (await ethers.getContractFactory('MockNFT')).deploy();
    erc20= await (await ethers.getContractFactory('MockERC20')).deploy();

    const F = await ethers.getContractFactory('BlockDustMarketplace');
    mkt = await upgrades.deployProxy(F, [feeRecipient.address, await proc.getAddress()], {
      kind: 'uups',
    });
  });

  it('deploys behind a UUPS proxy with safe defaults', async () => {
    expect(await mkt.platformFeeBps()).to.equal(250n);
    expect(await mkt.vibeShareBps()).to.equal(0n);   // not 10_000
    expect(await mkt.owner()).to.equal(owner.address);
    expect(await mkt.version()).to.equal('2.0.0');
  });

  it('has no auction, bid, or withdraw surface', async () => {
    for (const fn of ['createAuction','bid','settleAuction','cancelAuction','withdraw']) {
      expect(mkt.interface.fragments.some(f => f.name === fn), fn).to.equal(false);
    }
  });

  it('settles a native sale atomically and holds no balance', async () => {
    const id = await nft.mint.staticCall(seller.address);
    await nft.connect(seller).mint(seller.address);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);

    const price = ethers.parseEther('100');
    await mkt.connect(seller).createListing(await nft.getAddress(), id, 1, price, ethers.ZeroAddress);

    const before = await ethers.provider.getBalance(seller.address);
    await mkt.connect(buyer).buy(1, 1, { value: price });
    const after = await ethers.provider.getBalance(seller.address);

    // 2.5% fee, no royalty configured -> seller nets 97.5
    expect(after - before).to.equal(ethers.parseEther('97.5'));
    expect(await nft.ownerOf(id)).to.equal(buyer.address);
    // the whole point: nothing retained
    expect(await ethers.provider.getBalance(await mkt.getAddress())).to.equal(0n);
  });

  it('pays ERC-2981 royalties and still retains nothing', async () => {
    const id = await nft.mint.staticCall(seller.address);
    await nft.connect(seller).mint(seller.address);
    await nft.setRoyalty(royaltyRx.address, 500); // 5%
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);

    const price = ethers.parseEther('100');
    await mkt.connect(seller).createListing(await nft.getAddress(), id, 1, price, ethers.ZeroAddress);

    const rxBefore = await ethers.provider.getBalance(royaltyRx.address);
    await mkt.connect(buyer).buy(1, 1, { value: price });

    expect(await ethers.provider.getBalance(royaltyRx.address) - rxBefore)
      .to.equal(ethers.parseEther('5'));
    expect(await ethers.provider.getBalance(await mkt.getAddress())).to.equal(0n);
  });

  it('routes ERC-20 payment without parking tokens in the contract', async () => {
    const id = await nft.mint.staticCall(seller.address);
    await nft.connect(seller).mint(seller.address);
    await nft.connect(seller).setApprovalForAll(await mkt.getAddress(), true);

    const price = ethers.parseEther('100');
    await erc20.mint(buyer.address, price);
    await erc20.connect(buyer).approve(await mkt.getAddress(), price);
    await mkt.connect(seller).createListing(await nft.getAddress(), id, 1, price, await erc20.getAddress());

    await mkt.connect(buyer).buy(1, 1);

    expect(await erc20.balanceOf(seller.address)).to.equal(ethers.parseEther('97.5'));
    expect(await erc20.balanceOf(feeRecipient.address)).to.equal(ethers.parseEther('2.5'));
    expect(await erc20.balanceOf(await mkt.getAddress())).to.equal(0n);
  });

  it('rejects plain native transfers instead of accumulating them', async () => {
    await expect(
      buyer.sendTransaction({ to: await mkt.getAddress(), value: ethers.parseEther('1') })
    ).to.be.reverted;
  });

  it('only the owner can upgrade', async () => {
    const F2 = await ethers.getContractFactory('BlockDustMarketplace', buyer);
    await expect(upgrades.upgradeProxy(await mkt.getAddress(), F2))
      .to.be.revertedWithCustomError(mkt, 'OwnableUnauthorizedAccount');
  });

  it('upgrades in place, preserving listings and address', async () => {
    const id = await nft.mint.staticCall(seller.address);
    await nft.connect(seller).mint(seller.address);
    await mkt.connect(seller).createListing(
      await nft.getAddress(), id, 1, ethers.parseEther('7'), ethers.ZeroAddress);

    const addr = await mkt.getAddress();
    const F2 = await ethers.getContractFactory('BlockDustMarketplace');
    const up = await upgrades.upgradeProxy(addr, F2);

    expect(await up.getAddress()).to.equal(addr);
    expect((await up.listings(1)).pricePerUnit).to.equal(ethers.parseEther('7'));
  });
});
