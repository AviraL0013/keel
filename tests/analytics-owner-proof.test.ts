import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  historicalAccountOwner,
  type HistoricalOwnerClient,
} from '../server/src/infrastructure/analytics/owner-proof.js'

const recorded = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-wallet.json', 'utf8'))
const account = { ...recorded.account, accountId: BigInt(recorded.account.accountId) }
const blockNumber = BigInt(recorded.blockNumber)
// The recording has no snapshot hash. These headers are explicitly synthetic.
const hash = `0x${'a'.repeat(64)}`,
  other = `0x${'b'.repeat(64)}`
function fake(
  options: {
    chain?: number
    finalized?: bigint
    id?: bigint
    address?: string
    zero?: boolean
    reorg?: boolean
    finalityReorg?: boolean
    unavailable?: boolean
  } = {},
) {
  const calls: Array<{ functionName: string; blockNumber: bigint }> = []
  let headers = 0
  const client: HistoricalOwnerClient = {
    getChainId: async () => options.chain ?? 143,
    getBlock: async (input) =>
      input.blockTag === 'finalized'
        ? { number: options.finalized ?? blockNumber + 12n, hash: other, timestamp: 1791390000n }
        : input.blockNumber === (options.finalized ?? blockNumber + 12n)
          ? { number: input.blockNumber, hash: options.finalityReorg ? hash : other, timestamp: 1791390000n }
          : { number: blockNumber, hash: options.reorg && ++headers > 1 ? other : hash, timestamp: 1791388000n },
    readContract: async (input) => {
      calls.push(input)
      if (options.unavailable) throw Error('ARCHIVE_STATE_UNAVAILABLE')
      return {
        ...account,
        accountId: options.zero ? 0n : (options.id ?? account.accountId),
        accountAddr: options.address ?? account.accountAddr,
      }
    },
  }
  return { client, calls }
}

it('resolves recorded account payload only at a matching finalized historical block with address roundtrip', async () => {
  const { client, calls } = fake()
  const proof = await historicalAccountOwner(client, account.accountId, blockNumber, hash)
  expect(proof.accountId).toBe(String(account.accountId))
  expect(proof.address.toLowerCase()).toBe(account.accountAddr.toLowerCase())
  expect(proof.blockHash).toBe(hash)
  expect(proof.block).toBe(String(blockNumber))
  expect(proof.asOf).toBe('2026-10-07T15:46:40.000Z')
  expect(calls.map((c) => c.functionName)).toEqual(['getAccountById', 'getAccountByAddr'])
  expect(calls.every((c) => c.blockNumber === blockNumber)).toBe(true)
})

it('refuses wrong chain, unfinalized block, unknown/foreign owner and changing historical hash without fallback', async () => {
  for (const options of [
    { chain: 10143 },
    { finalized: blockNumber - 1n },
    { id: account.accountId + 1n },
    { zero: true },
    { address: '0x0000000000000000000000000000000000000000' },
    { reorg: true },
    { finalityReorg: true },
    { unavailable: true },
  ]) {
    const { client, calls } = fake(options)
    await expect(historicalAccountOwner(client, account.accountId, blockNumber, hash)).rejects.toThrow()
    expect(calls.every((c) => c.blockNumber === blockNumber)).toBe(true)
    expect(calls.length).toBeLessThanOrEqual(2)
  }
})

it('rejects mismatched roundtrip identity and hash before publishing or caching ownership', async () => {
  const { client } = fake()
  const reader = client.readContract
  client.readContract = async (input) =>
    input.functionName === 'getAccountByAddr' ? { ...account, accountId: account.accountId + 1n } : reader(input)
  await expect(historicalAccountOwner(client, account.accountId, blockNumber, hash)).rejects.toThrow(
    'ANALYTICS_OWNER_ROUNDTRIP_MISMATCH',
  )
  await expect(historicalAccountOwner(fake().client, account.accountId, blockNumber, other)).rejects.toThrow(
    'ANALYTICS_OWNER_BLOCK_MISMATCH',
  )
  await expect(historicalAccountOwner(fake().client, 0n, blockNumber, hash)).rejects.toThrow(
    'ANALYTICS_OWNER_INPUT_INVALID',
  )
})
