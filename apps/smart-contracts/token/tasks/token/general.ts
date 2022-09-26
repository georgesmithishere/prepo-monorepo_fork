/* eslint-disable import/named */
/* eslint-disable no-console */
import { task, types } from 'hardhat/config'
import { ChainId, DEPLOYMENT_NAMES, getPrePOAddressForNetwork } from 'prepo-constants'
import { getNetworkByChainId } from 'prepo-utils'
import { getAddress, parseEther } from 'ethers/lib/utils'
import { BigNumber } from 'ethers'
import { AdminClient } from 'defender-admin-client'
import { AccountList, Vesting } from '../../types'
import path from 'path'
import { readFileSync } from 'fs'

function readAddressesFromFile(filePath: string): Set<string> {
  const addressSet = new Set<string>()
  const listInputPath = readFileSync(path.resolve(__dirname, filePath), 'utf8')
  const listEntries = listInputPath.split('\n')
  listEntries.forEach((entry) => {
    const splitEntry = entry.split(' ')
    if (splitEntry[0]) {
      const account = getAddress(splitEntry[0])
      addressSet.add(account)
    }
  })
  console.log(1)
  return addressSet
}

function readAddressesAndAmountsFromFile(filePath: string): Map<string, BigNumber> {
  const allocations = new Map<string, BigNumber>()
  const listInputPath = readFileSync(path.resolve(__dirname, filePath), 'utf8')
  const listEntries = listInputPath.split('\n')
  listEntries.forEach((entry) => {
    const splitEntry = entry.split(' ')
    if (splitEntry[0]) {
      const account = getAddress(splitEntry[0])
      if (splitEntry[1]) {
        const amount = parseEther(splitEntry[1])
        allocations.set(account, amount)
      }
    }
  })
  return allocations
}

function removeStringsFromSet(toRemove: string[], set: Set<string>): Set<string> {
  toRemove.forEach((account) => {
    if (account) {
      set.delete(account)
    }
  })
  return set
}

task('modify-account-list', 'modify AccountList')
  .addParam('name', 'deployment name of AccountList', '', types.string)
  .addOptionalParam('add', 'filepath to list of addresses to include', '', types.string)
  .addOptionalParam('remove', 'filepath to list of addresses to remove', '', types.string)
  .setAction(async (args, { ethers, getChainId }) => {
    const currentChain = Number(await getChainId()) as ChainId
    const currentNetwork = getNetworkByChainId(currentChain)
    const governanceAddress = getPrePOAddressForNetwork(
      'GOVERNANCE',
      currentNetwork.name,
      process.env.GOVERNANCE
    )
    console.log('Governance for the current network is at:', governanceAddress)
    const fetchedAccountList = (await ethers.getContract(args.name)) as AccountList
    console.log('Fetched', args.name, 'at', fetchedAccountList.address)
    const defenderClient = new AdminClient({
      apiKey: process.env.DEFENDER_API_KEY,
      apiSecret: process.env.DEFENDER_API_SECRET,
    })
    /**
     * For safety, add addresses after we remove them, in case we have an
     * unintentional duplicate in both.
     */
    if (args.remove !== '') {
      console.log('Removing addresses from', args.remove)
      const setOfAccountsToRemove = readAddressesFromFile(args.remove)
      let accountsToRemove = Array.from(setOfAccountsToRemove.keys())
      const addressesAlreadyRemoved = await Promise.all(
        accountsToRemove.map(async (account) => {
          if (!(await fetchedAccountList.isIncluded(account))) {
            return account
          }
          return ''
        })
      )
      accountsToRemove = Array.from(
        removeStringsFromSet(addressesAlreadyRemoved, setOfAccountsToRemove).keys()
      )
      if (accountsToRemove.length >= 1) {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        defenderClient.createProposal({
          contract: {
            address: fetchedAccountList.address,
            network: currentNetwork.infuraEndpointName as any,
          },
          title: `Remove addresses from ${args.name}`,
          description: `Removing ${accountsToRemove.length} addresses from AccountList at ${fetchedAccountList.address}`,
          type: 'custom',
          functionInterface: {
            name: 'set',
            inputs: [
              { type: 'address[]', name: '_accounts' },
              { type: 'bool[]', name: '_included' },
            ],
          },
          functionInputs: [accountsToRemove, new Array(accountsToRemove.length).fill(false)],
          via: governanceAddress,
          viaType: 'Gnosis Safe',
        })
      }
      console.log('Removed', accountsToRemove.length, 'Accounts')
    }
    if (args.add !== '') {
      console.log('Including addresses from', args.add)
      const setOfAccountsToInclude = readAddressesFromFile(args.add)
      let accountsToInclude = Array.from(setOfAccountsToInclude.keys())
      // Filter out already included addresses to cut down on tx cost
      const addressesAlreadyIncluded = await Promise.all(
        accountsToInclude.map(async (account) => {
          if (await fetchedAccountList.isIncluded(account)) {
            return account
          }
          return ''
        })
      )
      accountsToInclude = Array.from(
        removeStringsFromSet(addressesAlreadyIncluded, setOfAccountsToInclude).keys()
      )
      if (accountsToInclude.length >= 1) {
        defenderClient.createProposal({
          contract: {
            address: fetchedAccountList.address,
            network: currentNetwork.infuraEndpointName as any,
          },
          title: `Include addresses for ${args.name}`,
          description: `Including ${accountsToInclude.length} addresses for AccountList at ${fetchedAccountList.address}`,
          type: 'custom',
          functionInterface: {
            name: 'set',
            inputs: [
              { type: 'address[]', name: '_accounts' },
              { type: 'bool[]', name: '_included' },
            ],
          },
          functionInputs: [accountsToInclude, new Array(accountsToInclude.length).fill(true)],
          via: governanceAddress,
          viaType: 'Gnosis Safe',
        })
      }
      console.log('Included', accountsToInclude.length, 'Accounts')
    }
  })

task('modify-vesting-allocation', 'modify Vesting allocations')
  .addParam('allocation', 'filepath to list of addresses and allocation amounts', '', types.string)
  .setAction(async (args, { ethers, getChainId }) => {
    const currentChain = Number(await getChainId()) as ChainId
    const currentNetwork = getNetworkByChainId(currentChain)
    const governanceAddress = getPrePOAddressForNetwork(
      'GOVERNANCE',
      currentNetwork.name,
      process.env.GOVERNANCE
    )
    console.log('Governance for the current network is at:', governanceAddress)
    const vesting = (await ethers.getContract(DEPLOYMENT_NAMES.vesting.name)) as Vesting
    console.log('Using Vesting at', vesting.address)
    console.log('Setting allocations from', args.allocation)
    const allocations = readAddressesAndAmountsFromFile(args.allocation)
    console.log('Allocations:', allocations)
    const accountsArray: string[] = []
    const amountsArray: BigNumber[] = []
    allocations.forEach((amount, account) => {
      accountsArray.push(account)
      amountsArray.push(amount)
    })
    const defenderClient = new AdminClient({
      apiKey: process.env.DEFENDER_API_KEY,
      apiSecret: process.env.DEFENDER_API_SECRET,
    })
    if (accountsArray.length !== amountsArray.length)
      throw new Error("Accounts and Amounts arrays don't match")
    /**
     * OZ's `createProposal` function only allows string/boolean
     * representations of values, can't directly pass in BN values.
     */
    const amountsArrayAsString = amountsArray.map((amount) => amount.toString())
    defenderClient.createProposal({
      contract: {
        address: vesting.address,
        network: currentNetwork.infuraEndpointName as any,
      },
      title: `Modifying vesting allocations`,
      description: `Modifying vesting allocations for ${accountsArray.length} addresses for Vesting at ${vesting.address}`,
      type: 'custom',
      functionInterface: {
        name: 'setAllocations',
        inputs: [
          { type: 'address[]', name: '_recipients' },
          { type: 'uint256[]', name: '_amounts' },
        ],
      },
      functionInputs: [accountsArray, amountsArrayAsString],
      via: governanceAddress,
      viaType: 'Gnosis Safe',
    })
    console.log('Set vesting allocations for', accountsArray.length, 'accounts')
  })
