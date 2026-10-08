import { getAddress } from 'viem'
import { EXCHANGE } from '../../../../packages/analytics/src/decoder.js'
import { exchangeReads } from '../../../../packages/analytics/src/exchange-reads.js'

type Header = { number: bigint | null; hash: string | null; timestamp: bigint }
export interface HistoricalOwnerClient {
  getChainId(): Promise<number>
  getBlock(
    input: { blockNumber: bigint; blockTag?: never } | { blockTag: 'finalized'; blockNumber?: never },
  ): Promise<Header>
  readContract(input: {
    address: `0x${string}`
    abi: typeof exchangeReads
    functionName: 'getAccountById' | 'getAccountByAddr'
    args: readonly [bigint | `0x${string}`]
    blockNumber: bigint
  }): Promise<unknown>
}
export type HistoricalOwnerProof = {
  accountId: string
  address: `0x${string}`
  block: string
  blockHash: string
  asOf: string
  source: 'monad_exchange'
}

const hashPattern = /^0x[0-9a-f]{64}$/i
function owner(value: unknown) {
  if (!value || typeof value !== 'object') throw Error('ANALYTICS_OWNER_ACCOUNT_INVALID')
  const account = value as { accountId?: unknown; accountAddr?: unknown }
  if (typeof account.accountId !== 'bigint' || account.accountId <= 0n || typeof account.accountAddr !== 'string')
    throw Error('ANALYTICS_OWNER_ACCOUNT_INVALID')
  const address = getAddress(account.accountAddr)
  if (/^0x0{40}$/i.test(address)) throw Error('ANALYTICS_OWNER_ACCOUNT_INVALID')
  return { accountId: account.accountId, address }
}

/** Proves ownership at this block only; it does not infer historical immutability. */
export async function historicalAccountOwner(
  client: HistoricalOwnerClient,
  accountId: bigint,
  blockNumber: bigint,
  expectedHash: string,
): Promise<HistoricalOwnerProof> {
  if (accountId <= 0n || accountId >= 1n << 256n || blockNumber < 0n || !hashPattern.test(expectedHash))
    throw Error('ANALYTICS_OWNER_INPUT_INVALID')
  if ((await client.getChainId()) !== 143) throw Error('ANALYTICS_OWNER_CHAIN_MISMATCH')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (
    finalized.number === null ||
    finalized.number < blockNumber ||
    !finalized.hash ||
    !hashPattern.test(finalized.hash)
  )
    throw Error('ANALYTICS_OWNER_NOT_FINALIZED')
  const before = await client.getBlock({ blockNumber })
  if (before.number !== blockNumber || before.hash?.toLowerCase() !== expectedHash.toLowerCase())
    throw Error('ANALYTICS_OWNER_BLOCK_MISMATCH')
  const timestamp = Number(before.timestamp) * 1000
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > Date.now() + 30_000)
    throw Error('ANALYTICS_OWNER_TIMESTAMP_INVALID')
  const byId = owner(
    await client.readContract({
      address: EXCHANGE,
      abi: exchangeReads,
      functionName: 'getAccountById',
      args: [accountId],
      blockNumber,
    }),
  )
  if (byId.accountId !== accountId) throw Error('ANALYTICS_OWNER_ACCOUNT_MISMATCH')
  const byAddress = owner(
    await client.readContract({
      address: EXCHANGE,
      abi: exchangeReads,
      functionName: 'getAccountByAddr',
      args: [byId.address],
      blockNumber,
    }),
  )
  if (byAddress.accountId !== accountId || byAddress.address !== byId.address)
    throw Error('ANALYTICS_OWNER_ROUNDTRIP_MISMATCH')
  const after = await client.getBlock({ blockNumber })
  if (
    after.number !== blockNumber ||
    after.hash?.toLowerCase() !== expectedHash.toLowerCase() ||
    after.timestamp !== before.timestamp
  )
    throw Error('ANALYTICS_OWNER_BLOCK_MISMATCH')
  const finalityAfter = await client.getBlock({ blockNumber: finalized.number })
  if (finalityAfter.number !== finalized.number || finalityAfter.hash?.toLowerCase() !== finalized.hash.toLowerCase())
    throw Error('ANALYTICS_OWNER_FINALITY_CHANGED')
  return {
    accountId: String(accountId),
    address: byId.address,
    block: String(blockNumber),
    blockHash: expectedHash.toLowerCase(),
    asOf: new Date(timestamp).toISOString(),
    source: 'monad_exchange',
  }
}
