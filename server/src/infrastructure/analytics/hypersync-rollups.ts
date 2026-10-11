import { decodeEventLog, getAddress, toEventSelector, type AbiEvent, type Hex } from 'viem'
import { deriveEvent, type MarketPrecision } from '../../../../packages/analytics/src/aggregate.js'
import { decodeExchangeLog, EXCHANGE, type ChainLog } from '../../../../packages/analytics/src/decoder.js'
import { exchangeEvents } from '../../../../packages/analytics/src/exchange-events.js'
import { RollupAccumulator } from '../../../../packages/analytics/src/rollups.js'
import { PerplPublicAnalytics } from './perpl-public.js'
import { HyperSyncRequestPacer, sharedHyperSyncPacer } from './hypersync-pacer.js'
import type { RollupCoverage } from './rollup-repository.js'

const endpoint = 'https://monad.hypersync.xyz'
const selectedNames = new Set([
  'AccountCreated',
  'CollateralDeposit',
  'CollateralWithdrawal',
  'MakerOrderFilled',
  'MakerOrderFilledV2',
  'TakerOrderFilled',
  'TakerOrderFilledV2',
  'PositionLiquidated',
  'PositionOpened',
  'PositionOpenedV2',
  'PositionIncreased',
  'PositionIncreasedV2',
  'PositionDecreased',
  'PositionClosed',
  'PositionInverted',
])
const topics = exchangeEvents
  .filter((event) => selectedNames.has(event.name))
  .map((event) => toEventSelector(event as AbiEvent))
const accountEvent = exchangeEvents.find((event) => event.name === 'AccountCreated') as AbiEvent
const accountTopic = toEventSelector(accountEvent)

type SyncBlock = { number: number; hash: string; timestamp: string }
type SyncLog = {
  block_number: number
  block_hash: string
  transaction_hash: string
  transaction_index: number
  log_index: number
  data: string
  topic0?: string | null
  topic1?: string | null
  topic2?: string | null
  topic3?: string | null
}
type SyncResponse = {
  next_block: number
  data: Array<{ blocks?: SyncBlock[]; logs?: SyncLog[] }>
}

const blockTime = (block: SyncBlock): Date => {
  const seconds = Number(block.timestamp)
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('ROLLUP_BLOCK_TIME_INVALID')
  return new Date(seconds * 1000)
}
const checkBlock = (value: unknown): number => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('ROLLUP_BLOCK_INVALID')
  return number
}

export class HyperSyncRollupSource {
  private readonly publicData = new PerplPublicAnalytics()
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly pacer: HyperSyncRequestPacer = sharedHyperSyncPacer,
  ) {
    if (!token) throw new Error('EYELER_HYPERSYNC_TOKEN_REQUIRED')
  }

  private async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.pacer.wait()
      const response = await this.fetcher(`${endpoint}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json', authorization: `Bearer ${this.token}` } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      })
      if (response.status !== 429 && response.status < 500) {
        if (!response.ok) throw new Error(`ROLLUP_HYPERSYNC_HTTP_${response.status}`)
        return response.json() as Promise<T>
      }
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'))
        this.pacer.cooldown(Number.isFinite(seconds) && seconds > 0 ? Math.max(60_000, seconds * 1_000) : 60_000)
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 1000 * 2 ** attempt)))
    }
    throw new Error('ROLLUP_HYPERSYNC_RETRY_EXHAUSTED')
  }

  async height(signal?: AbortSignal): Promise<number> {
    const value = await this.request<{ height: number }>('/height', undefined, signal)
    return checkBlock(value.height)
  }

  async block(number: number, signal?: AbortSignal): Promise<SyncBlock> {
    checkBlock(number)
    const result = await this.request<SyncResponse>(
      '/query',
      {
        from_block: number,
        to_block: number + 1,
        blocks: [{}],
        field_selection: { block: ['number', 'hash', 'timestamp'] },
      },
      signal,
    )
    const block = result.data.flatMap((batch) => batch.blocks ?? [])[0]
    if (!block || block.number !== number || !/^0x[0-9a-f]{64}$/i.test(block.hash))
      throw new Error('ROLLUP_BLOCK_MISSING')
    blockTime(block)
    return block
  }

  async blockAtOrAfter(time: Date, upperBound: number, signal?: AbortSignal): Promise<number> {
    let low = 54_773_010
    let high = upperBound
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (blockTime(await this.block(middle, signal)) < time) low = middle + 1
      else high = middle
    }
    return low
  }

  async readRange(
    fromBlock: number,
    toBlock: number,
    signal?: AbortSignal,
  ): Promise<{
    coverage: RollupCoverage
    buckets: ReturnType<RollupAccumulator['result']>['buckets']
    actors: ReturnType<RollupAccumulator['result']>['actors']
  }> {
    if (checkBlock(fromBlock) >= checkBlock(toBlock)) throw new Error('ROLLUP_RANGE_INVALID')
    const [first, last] = await Promise.all([this.block(fromBlock, signal), this.block(toBlock - 1, signal)])
    const context = await this.publicData.context()
    const markets: Map<number, MarketPrecision> = this.publicData.precision(context.value)
    const accumulator = new RollupAccumulator()
    const seen = new Set<string>()
    let cursor = fromBlock
    let logCount = 0
    while (cursor < toBlock) {
      const result = await this.request<SyncResponse>(
        '/query',
        {
          from_block: cursor,
          to_block: toBlock,
          logs: [{ address: [EXCHANGE], topics: [topics] }],
          field_selection: {
            block: ['number', 'hash', 'timestamp'],
            log: [
              'block_number',
              'block_hash',
              'transaction_hash',
              'transaction_index',
              'log_index',
              'data',
              'topic0',
              'topic1',
              'topic2',
              'topic3',
            ],
          },
          join_mode: 'JoinAll',
        },
        signal,
      )
      for (const batch of result.data) {
        const blocks = new Map((batch.blocks ?? []).map((block) => [block.number, block]))
        for (const log of batch.logs ?? []) {
          if (log.block_number < fromBlock || log.block_number >= toBlock) throw new Error('ROLLUP_LOG_OUT_OF_RANGE')
          const block = blocks.get(log.block_number)
          if (!block || block.hash.toLowerCase() !== log.block_hash.toLowerCase())
            throw new Error('ROLLUP_LOG_BLOCK_MISMATCH')
          const id = `${log.block_number}:${log.transaction_hash}:${log.log_index}`
          if (seen.has(id)) continue
          seen.add(id)
          const chainLog: ChainLog = {
            address: EXCHANGE,
            blockNumber: `0x${log.block_number.toString(16)}`,
            blockHash: log.block_hash as Hex,
            transactionHash: log.transaction_hash as Hex,
            transactionIndex: `0x${log.transaction_index.toString(16)}`,
            logIndex: `0x${log.log_index.toString(16)}`,
            data: log.data as Hex,
            topics: [log.topic0, log.topic1, log.topic2, log.topic3].filter(
              (topic): topic is string => !!topic,
            ) as Hex[],
          }
          const decoded = decodeExchangeLog(chainLog)
          accumulator.add(decoded ? deriveEvent(decoded, markets) : null, blockTime(block))
          logCount++
        }
      }
      if (!Number.isSafeInteger(result.next_block) || result.next_block <= cursor || result.next_block > toBlock)
        throw new Error('ROLLUP_HYPERSYNC_CURSOR_INVALID')
      cursor = result.next_block
    }
    const checkedLast = await this.block(toBlock - 1, signal)
    if (checkedLast.hash.toLowerCase() !== last.hash.toLowerCase()) throw new Error('ROLLUP_REORG_DURING_READ')
    return {
      coverage: {
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
        fromTime: blockTime(first),
        throughTime: blockTime(last),
        endHash: last.hash,
        logCount,
      },
      ...accumulator.result(),
    }
  }

  /** Resolve owner dimensions without persisting AccountCreated events or other raw data. */
  async readOwners(fromBlock: number, toBlock: number, signal?: AbortSignal): Promise<Map<string, string>> {
    const owners = new Map<string, string>()
    let cursor = checkBlock(fromBlock)
    while (cursor < checkBlock(toBlock)) {
      const result = await this.request<SyncResponse>(
        '/query',
        {
          from_block: cursor,
          to_block: toBlock,
          logs: [{ address: [EXCHANGE], topics: [[accountTopic]] }],
          field_selection: { log: ['block_number', 'data', 'topic0'] },
          join_mode: 'JoinNothing',
        },
        signal,
      )
      for (const batch of result.data)
        for (const log of batch.logs ?? []) {
          if (
            log.topic0?.toLowerCase() !== accountTopic.toLowerCase() ||
            log.block_number < fromBlock ||
            log.block_number >= toBlock
          )
            throw new Error('ROLLUP_ACCOUNT_LOG_INVALID')
          const decoded = decodeEventLog({
            abi: [accountEvent],
            data: log.data as Hex,
            topics: [log.topic0 as Hex],
          }) as unknown as { args: { account: string; id: bigint } }
          const id = decoded.args.id.toString()
          const address = getAddress(decoded.args.account).toLowerCase()
          if (owners.has(id) && owners.get(id) !== address) throw new Error('ROLLUP_OWNER_CONFLICT')
          owners.set(id, address)
        }
      if (!Number.isSafeInteger(result.next_block) || result.next_block <= cursor || result.next_block > toBlock)
        throw new Error('ROLLUP_OWNER_CURSOR_INVALID')
      cursor = result.next_block
    }
    return owners
  }
}
