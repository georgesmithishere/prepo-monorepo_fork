import { expect } from 'chai'
import { ethers } from 'hardhat'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { BigNumber } from 'ethers'
import { ZERO_ADDRESS } from 'prepo-constants'
import { utils } from 'prepo-hardhat'
import { mockERC20Fixture } from './fixtures/MockERC20Fixture'
import { mockStrategyFixture } from './fixtures/MockStrategyFixture'
import { getMockStrategyVaultChangedEvent } from './events'
import { returnFromMockAPY } from './utils'
import { mockBaseTokenFixture } from './fixtures/MockBaseTokenFixture'
import { MockBaseToken } from '../typechain/MockBaseToken'
import { MockStrategy } from '../typechain/MockStrategy'
import { MockERC20 } from '../typechain/MockERC20'

const { setNextTimestamp, revertReason } = utils

describe('=> MockStrategy', () => {
  let mockStrategy: MockStrategy
  let collateralToken: MockERC20
  let baseToken: MockBaseToken
  let deployer: SignerWithAddress
  let user: SignerWithAddress
  let controller: SignerWithAddress
  let governance: SignerWithAddress
  let setupApyAndBeginning: (apy: number) => Promise<number>
  let mintAndApprove: (
    mintable: MockBaseToken,
    owner: SignerWithAddress,
    approver: SignerWithAddress,
    spender: string,
    amount: BigNumber
  ) => Promise<void>
  const TEST_APY = 7
  const TEST_TIMESTAMP_DELAY = 10
  const MOCK_COLLATERAL_SUPPLY = ethers.utils.parseEther('1000000000')
  const MOCK_BASE_TOKEN_SUPPLY = ethers.utils.parseEther('1000000000')
  const TEST_DEPOSIT_AMOUNT = ethers.utils.parseEther('1000')
  const TEST_WITHDRAWAL_AMOUNT = ethers.utils.parseEther('1000')
  beforeEach(async () => {
    ;[deployer, user, controller, governance] = await ethers.getSigners()
    collateralToken = await mockERC20Fixture('prePO Collateral Token', 'preCT')
    await collateralToken.mint(deployer.address, MOCK_COLLATERAL_SUPPLY)
    baseToken = await mockBaseTokenFixture('Fake USD', 'FAKEUSD')
    await baseToken.connect(deployer).ownerMint(MOCK_BASE_TOKEN_SUPPLY)
    mockStrategy = await mockStrategyFixture(controller.address, baseToken.address)
    await baseToken.setMockStrategy(mockStrategy.address)
    expect(await mockStrategy.owner()).to.eq(deployer.address)
    await mockStrategy.transferOwnership(governance.address)
    setupApyAndBeginning = async (apy: number): Promise<number> => {
      await mockStrategy.connect(governance).setApy(apy)
      const blockNumBefore = await ethers.provider.getBlockNumber()
      const blockBefore = await ethers.provider.getBlock(blockNumBefore)
      await mockStrategy.connect(governance).setBeginning(blockBefore.timestamp)
      return blockBefore.timestamp
    }

    mintAndApprove = async (
      mintable: MockBaseToken,
      owner: SignerWithAddress,
      approver: SignerWithAddress,
      spender: string,
      amount: BigNumber
    ): Promise<void> => {
      await mintable.connect(owner).ownerMint(amount)
      await mintable.connect(owner).transfer(approver.address, amount)
      await mintable.connect(approver).approve(spender, amount)
    }
  })

  describe('# initialize', () => {
    it('should be initialized with correct values', async () => {
      expect(await mockStrategy.owner()).to.eq(governance.address)
      expect(await mockStrategy.vault()).to.eq(ZERO_ADDRESS)
      expect(await mockStrategy.getController()).to.eq(controller.address)
      expect(await mockStrategy.getBaseToken()).to.eq(baseToken.address)
    })
  })

  describe('# setApy', () => {
    it('should only be usable by the owner', async () => {
      await expect(mockStrategy.connect(user).setApy(TEST_APY)).to.revertedWith(
        revertReason('Ownable: caller is not the owner')
      )
    })

    it('should be settable to zero', async () => {
      await mockStrategy.connect(governance).setApy(0)

      expect(await mockStrategy.apy()).to.eq(0)
    })

    it('should be settable to a non-zero value', async () => {
      await mockStrategy.connect(governance).setApy(TEST_APY)

      expect(await mockStrategy.apy()).to.eq(TEST_APY)
    })

    it('should be settable to the same value twice', async () => {
      await mockStrategy.connect(governance).setApy(TEST_APY)

      expect(await mockStrategy.apy()).to.eq(TEST_APY)

      await mockStrategy.connect(governance).setApy(TEST_APY)

      expect(await mockStrategy.apy()).to.eq(TEST_APY)
    })
  })

  describe('# setVault', () => {
    it('should only be usable by the owner', async () => {
      await expect(mockStrategy.connect(user).setVault(collateralToken.address)).revertedWith(
        revertReason('Ownable: caller is not the owner')
      )
    })

    it('should be settable to an address', async () => {
      expect(await mockStrategy.vault()).to.eq(ZERO_ADDRESS)

      await mockStrategy.connect(governance).setVault(collateralToken.address)

      expect(await mockStrategy.vault()).to.eq(collateralToken.address)
    })

    it('should be settable to the zero address', async () => {
      await mockStrategy.connect(governance).setVault(collateralToken.address)
      expect(await mockStrategy.vault()).to.eq(collateralToken.address)

      await mockStrategy.connect(governance).setVault(ZERO_ADDRESS)

      expect(await mockStrategy.vault()).to.eq(ZERO_ADDRESS)
    })

    it('should be settable to the same value twice', async () => {
      expect(await mockStrategy.vault()).to.eq(ZERO_ADDRESS)

      await mockStrategy.connect(governance).setVault(collateralToken.address)

      expect(await mockStrategy.vault()).to.eq(collateralToken.address)

      await mockStrategy.connect(governance).setVault(collateralToken.address)

      expect(await mockStrategy.vault()).to.eq(collateralToken.address)
    })

    it('should emit a VaultChanged event', async () => {
      await mockStrategy.connect(governance).setVault(collateralToken.address)

      const event = await getMockStrategyVaultChangedEvent(mockStrategy)
      expect(event.vault).to.eq(collateralToken.address)
    })
  })

  describe('# totalValue', () => {
    beforeEach(async () => {
      await mockStrategy.connect(governance).setVault(collateralToken.address)
    })

    it('should correctly return the virtual balance when it exceeds actual token balance', async () => {
      await setupApyAndBeginning(TEST_APY)
      // setBeginning will increment timestamp to push totalValue to read 1 second of APY
      const virtualAfterOne = returnFromMockAPY(TEST_APY, 1, MOCK_COLLATERAL_SUPPLY)

      expect(await mockStrategy.totalValue()).to.eq(virtualAfterOne)
    })

    it('should correctly return the actual token balance when it exceeds the virtual balance', async () => {
      const virtualAfterDelay = returnFromMockAPY(
        TEST_APY,
        TEST_TIMESTAMP_DELAY,
        MOCK_COLLATERAL_SUPPLY
      )
      await baseToken.connect(deployer).ownerMint(virtualAfterDelay)
      const beginning = await setupApyAndBeginning(TEST_APY)
      // setBeginning will increment timestamp to push totalValue to read 1 second of APY
      const virtualBeforeDelay = returnFromMockAPY(TEST_APY, 1, MOCK_COLLATERAL_SUPPLY)
      expect(await mockStrategy.totalValue()).to.eq(virtualBeforeDelay)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setNextTimestamp(ethers.provider as any, beginning + TEST_TIMESTAMP_DELAY)
      await baseToken.transfer(mockStrategy.address, virtualAfterDelay)

      expect(await mockStrategy.totalValue()).to.eq(virtualAfterDelay)
    })
  })

  describe('# deposit', () => {
    beforeEach(async () => {
      await mockStrategy.connect(governance).setVault(collateralToken.address)
    })

    it('should only be callable by the controller', async () => {
      await expect(mockStrategy.connect(user).deposit(TEST_DEPOSIT_AMOUNT)).revertedWith(
        revertReason('Caller is not the controller')
      )
    })

    it('should only transfer assets from the controller', async () => {
      await mintAndApprove(
        baseToken,
        deployer,
        controller,
        mockStrategy.address,
        TEST_DEPOSIT_AMOUNT
      )
      await setupApyAndBeginning(TEST_APY)
      expect(await baseToken.balanceOf(controller.address)).to.eq(TEST_DEPOSIT_AMOUNT)
      expect(await baseToken.balanceOf(mockStrategy.address)).to.eq(0)

      await mockStrategy.connect(controller).deposit(TEST_DEPOSIT_AMOUNT)

      expect(await baseToken.balanceOf(controller.address)).to.eq(0)
      expect(await baseToken.balanceOf(mockStrategy.address)).to.eq(TEST_DEPOSIT_AMOUNT)
    })

    it('should set actual balance to (virtual balance + deposit) when actual<virtual and initial balance >0', async () => {
      const virtualAfterDelay = returnFromMockAPY(
        TEST_APY,
        TEST_TIMESTAMP_DELAY,
        MOCK_COLLATERAL_SUPPLY
      )
      await mintAndApprove(
        baseToken,
        deployer,
        controller,
        mockStrategy.address,
        TEST_DEPOSIT_AMOUNT
      )
      await baseToken.connect(deployer).ownerMint(1)
      await baseToken.connect(deployer).transfer(mockStrategy.address, 1)
      const beginning = await setupApyAndBeginning(TEST_APY)
      // setBeginning will increment timestamp to push totalValue to read 1 second of APY
      const virtualBeforeDelay = returnFromMockAPY(TEST_APY, 1, MOCK_COLLATERAL_SUPPLY)
      expect(await baseToken.balanceOf(mockStrategy.address)).to.eq(1)
      expect(await mockStrategy.totalValue()).to.eq(virtualBeforeDelay)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setNextTimestamp(ethers.provider as any, beginning + TEST_TIMESTAMP_DELAY)

      await mockStrategy.connect(controller).deposit(TEST_DEPOSIT_AMOUNT)

      expect(await baseToken.balanceOf(mockStrategy.address)).to.eq(
        virtualAfterDelay.add(TEST_DEPOSIT_AMOUNT)
      )
      expect(await mockStrategy.totalValue()).to.eq(virtualAfterDelay.add(TEST_DEPOSIT_AMOUNT))
    })

    it('should deposit without minting if actual balance exceeds virtual balance and initial balance >0', async () => {
      const virtualAfterDelay = returnFromMockAPY(
        TEST_APY,
        TEST_TIMESTAMP_DELAY,
        MOCK_COLLATERAL_SUPPLY
      )
      // mint token balance into the strategy that will exceed the expected virtual balance at time of deposit
      await baseToken.connect(deployer).ownerMint(virtualAfterDelay)
      await baseToken.connect(deployer).transfer(mockStrategy.address, virtualAfterDelay)
      // gives funds to the controller to deposit as normal.
      await mintAndApprove(
        baseToken,
        deployer,
        controller,
        mockStrategy.address,
        TEST_DEPOSIT_AMOUNT
      )
      const beginning = await setupApyAndBeginning(TEST_APY)
      expect(await baseToken.balanceOf(mockStrategy.address)).to.eq(virtualAfterDelay)
      expect(await mockStrategy.totalValue()).to.eq(virtualAfterDelay)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setNextTimestamp(ethers.provider as any, beginning + TEST_TIMESTAMP_DELAY)

      await mockStrategy.connect(controller).deposit(TEST_DEPOSIT_AMOUNT)

      expect(await baseToken.balanceOf(mockStrategy.address)).to.eq(
        virtualAfterDelay.add(TEST_DEPOSIT_AMOUNT)
      )
      expect(await mockStrategy.totalValue()).to.eq(virtualAfterDelay.add(TEST_DEPOSIT_AMOUNT))
    })
  })

  describe('# withdraw', () => {
    beforeEach(async () => {
      await mockStrategy.connect(governance).setVault(collateralToken.address)
    })

    it('should only be callable by the controller', async () => {
      await expect(
        mockStrategy.connect(user).withdraw(user.address, TEST_WITHDRAWAL_AMOUNT)
      ).revertedWith(revertReason('Caller is not the controller'))
    })

    it('should correctly withdraw funds into the specified account', async () => {
      await baseToken.transfer(mockStrategy.address, TEST_WITHDRAWAL_AMOUNT)
      await mockStrategy.connect(controller).withdraw(user.address, TEST_WITHDRAWAL_AMOUNT)

      expect(await baseToken.balanceOf(user.address)).to.eq(TEST_WITHDRAWAL_AMOUNT)
    })

    it('should mint the shortfall if strategy does not have enough', async () => {
      await baseToken.transfer(mockStrategy.address, TEST_WITHDRAWAL_AMOUNT.sub(1))
      await mockStrategy.connect(controller).withdraw(user.address, TEST_WITHDRAWAL_AMOUNT)

      expect(await baseToken.balanceOf(user.address)).to.eq(TEST_WITHDRAWAL_AMOUNT)
    })
  })
})
