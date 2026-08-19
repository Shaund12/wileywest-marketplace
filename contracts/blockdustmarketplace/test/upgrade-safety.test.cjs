const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('upgrade safety', function () {
  let mkt, owner, other, feeRecipient, proc;

  beforeEach(async () => {
    [owner, other, feeRecipient] = await ethers.getSigners();
    proc = await (await ethers.getContractFactory('MockFeeProcessor')).deploy();
    const F = await ethers.getContractFactory('BlockDustMarketplace');
    mkt = await upgrades.deployProxy(F, [feeRecipient.address, await proc.getAddress()], { kind: 'uups' });
  });

  it('the implementation cannot be initialized directly', async () => {
    const impl = await upgrades.erc1967.getImplementationAddress(await mkt.getAddress());
    const asImpl = await ethers.getContractAt('BlockDustMarketplace', impl);
    // _disableInitializers() in the constructor must make this impossible;
    // otherwise an attacker owns the implementation and can selfdestruct-
    // style brick the proxy in some patterns.
    await expect(asImpl.initialize(owner.address, await proc.getAddress()))
      .to.be.revertedWithCustomError(asImpl, 'InvalidInitialization');
  });

  it('initialize cannot be called twice on the proxy', async () => {
    await expect(mkt.initialize(owner.address, await proc.getAddress()))
      .to.be.revertedWithCustomError(mkt, 'InvalidInitialization');
  });

  it('a non-owner cannot upgrade even with a valid implementation', async () => {
    const F2 = await ethers.getContractFactory('BlockDustMarketplace');
    const newImpl = await F2.deploy();
    await expect(
      mkt.connect(other).upgradeToAndCall(await newImpl.getAddress(), '0x')
    ).to.be.revertedWithCustomError(mkt, 'OwnableUnauthorizedAccount');
  });

  it('ownership transfer moves upgrade authority', async () => {
    await mkt.transferOwnership(other.address);
    expect(await mkt.owner()).to.equal(other.address);

    const F2 = await ethers.getContractFactory('BlockDustMarketplace');
    const newImpl = await F2.deploy();
    // old owner can no longer upgrade
    await expect(mkt.connect(owner).upgradeToAndCall(await newImpl.getAddress(), '0x'))
      .to.be.revertedWithCustomError(mkt, 'OwnableUnauthorizedAccount');
    // new owner can
    await expect(mkt.connect(other).upgradeToAndCall(await newImpl.getAddress(), '0x'))
      .to.not.be.reverted;
  });

  it('storage layout is upgrade-compatible with itself (plugin validation)', async () => {
    const F2 = await ethers.getContractFactory('BlockDustMarketplace');
    // validateUpgrade throws on layout collisions, missing gaps, etc.
    await upgrades.validateUpgrade(await mkt.getAddress(), F2, { kind: 'uups' });
  });

  it('state survives an upgrade', async () => {
    await mkt.setPlatformFeeBps(400);
    const F2 = await ethers.getContractFactory('BlockDustMarketplace');
    const up = await upgrades.upgradeProxy(await mkt.getAddress(), F2);
    expect(await up.platformFeeBps()).to.equal(400n);
    expect(await up.feeRecipient()).to.equal(feeRecipient.address);
  });
});
