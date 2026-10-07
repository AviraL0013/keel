/** Independent, read-only Perpl mainnet event indexer. No trading worker lock or signing. */
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { toEventSelector, type AbiEvent } from 'viem'
import { deriveEvent, type MarketPrecision } from '../../../packages/analytics/src/aggregate.js'
import { decodeExchangeLog, EXCHANGE, type ChainLog } from '../../../packages/analytics/src/decoder.js'
import { exchangeEvents } from '../../../packages/analytics/src/exchange-events.js'
import { AnalyticsRepository, type IndexedBlock } from '../infrastructure/analytics/repository.js'

const exchangeTopics = exchangeEvents.map((event) => toEventSelector(event as AbiEvent))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type RpcBlock = { number: string; hash: string; timestamp: string }

export interface AnalyticsIndexerConfig {
  databaseUrl: string
  rpcUrl: string
  perplApiUrl: string
  startBlock: bigint | null
  historyVerified: boolean
  confirmationDepth: bigint
  chunkSize: bigint
  pollMs: number
}
export function indexerConfig(env: NodeJS.ProcessEnv): AnalyticsIndexerConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED')
  if (!env.EYELER_ANALYTICS_RPC_URL) throw new Error('EYELER_ANALYTICS_RPC_URL_REQUIRED')
  if (env.EYELER_ANALYTICS_START_BLOCK !== undefined && !/^\d+$/.test(env.EYELER_ANALYTICS_START_BLOCK))
    throw new Error('EYELER_ANALYTICS_START_BLOCK_INVALID')
  const confirmationDepth = BigInt(env.ANALYTICS_CONFIRMATIONS ?? '12')
  const chunkSize = BigInt(env.ANALYTICS_CHUNK_SIZE ?? '20')
  const pollMs = Number(env.ANALYTICS_POLL_MS ?? '3000')
  if (
    confirmationDepth < 1n ||
    confirmationDepth > 256n ||
    chunkSize < 1n ||
    chunkSize > 100n ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1000 ||
    pollMs > 60000
  )
    throw new Error('ANALYTICS_CONFIG_INVALID')
  return {
    databaseUrl: env.DATABASE_URL,
    rpcUrl: env.EYELER_ANALYTICS_RPC_URL,
    perplApiUrl: env.ANALYTICS_PERPL_API_URL ?? 'https://app.perpl.xyz/api',
    startBlock: env.EYELER_ANALYTICS_START_BLOCK ? BigInt(env.EYELER_ANALYTICS_START_BLOCK) : null,
    historyVerified: env.EYELER_ANALYTICS_START_BLOCK !== undefined,
    confirmationDepth,
    chunkSize,
    pollMs,
  }
}

export class AnalyticsIndexer {
  private requestId = 0
  private markets = new Map<number, MarketPrecision>()
  private marketsAt = 0
  private resolvedStart: bigint | null = null
  constructor(
    readonly repo: AnalyticsRepository,
    readonly config: AnalyticsIndexerConfig,
  ) {}

  private async rpc<T>(
    method: 'eth_blockNumber' | 'eth_getBlockByNumber' | 'eth_getLogs',
    params: unknown[],
  ): Promise<T> {
    const response = await fetch(this.config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`ANALYTICS_RPC_HTTP_${response.status}`)
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string } }
    if (body.error || body.result === undefined) throw new Error(`ANALYTICS_RPC_${body.error?.code ?? 'EMPTY'}`)
    return body.result
  }
  private async context(): Promise<Map<number, MarketPrecision>> {
    if (Date.now() - this.marketsAt < 300_000 && this.markets.size) return this.markets
    const response = await fetch(`${this.config.perplApiUrl}/v1/pub/context`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`ANALYTICS_PERPL_HTTP_${response.status}`)
    const body = (await response.json()) as {
      chain?: { chain_id?: number }
      instances?: Array<{ address: string }>
      markets?: Array<{
        id: number
        perpetual_id: number
        config: { price_decimals: number; size_decimals: number }
      }>
    }
    if (
      body.chain?.chain_id !== 143 ||
      !body.instances?.some((instance) => instance.address.toLowerCase() === EXCHANGE.toLowerCase())
    )
      throw new Error('ANALYTICS_PERPL_CONTEXT_MISMATCH')
    const markets = new Map<number, MarketPrecision>()
    for (const market of body.markets ?? [])
      markets.set(market.perpetual_id, {
        marketId: market.id,
        priceDecimals: market.config.price_decimals,
        sizeDecimals: market.config.size_decimals,
      })
    if (!markets.size) throw new Error('ANALYTICS_NO_MARKETS')
    this.markets = markets
    this.marketsAt = Date.now()
    return markets
  }
  private async block(number: bigint): Promise<IndexedBlock> {
    const value = await this.rpc<RpcBlock | null>('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])
    if (!value?.hash || BigInt(value.number) !== number) throw new Error('ANALYTICS_BLOCK_MISSING')
    return { number, hash: value.hash, timestamp: new Date(Number(BigInt(value.timestamp)) * 1000) }
  }
  private async startBlock(head: bigint): Promise<bigint> {
    if (this.config.startBlock !== null) return this.config.startBlock
    if (this.resolvedStart !== null) return this.resolvedStart
    const target = (await this.block(head)).timestamp.getTime() - 7 * 86_400_000
    let low = 0n
    let high = head
    while (low < high) {
      const middle = (low + high) / 2n
      if ((await this.block(middle)).timestamp.getTime() < target) low = middle + 1n
      else high = middle
    }
    this.resolvedStart = low
    return low
  }
  async step(): Promise<'indexed' | 'caught-up' | 'rewound'> {
    const head = BigInt(await this.rpc<string>('eth_blockNumber', []))
    const checkpoint = await this.repo.initialize(await this.startBlock(head), this.config.historyVerified)
    const finalized = head - this.config.confirmationDepth
    if (checkpoint.nextBlock > checkpoint.startBlock && checkpoint.lastBlockHash) {
      const previous = await this.block(checkpoint.nextBlock - 1n)
      if (previous.hash.toLowerCase() !== checkpoint.lastBlockHash.toLowerCase()) {
        const rewind =
          checkpoint.nextBlock - 64n > checkpoint.startBlock ? checkpoint.nextBlock - 64n : checkpoint.startBlock
        await this.repo.rewind(rewind)
        return 'rewound'
      }
    }
    if (checkpoint.nextBlock > finalized) return 'caught-up'
    const end =
      checkpoint.nextBlock + this.config.chunkSize - 1n < finalized
        ? checkpoint.nextBlock + this.config.chunkSize - 1n
        : finalized
    const markets = await this.context()
    const rawLogs = await this.rpc<ChainLog[]>('eth_getLogs', [
      {
        address: EXCHANGE,
        fromBlock: `0x${checkpoint.nextBlock.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
        topics: [exchangeTopics],
      },
    ])
    const blockNumbers = new Set<bigint>([checkpoint.nextBlock, end])
    for (const log of rawLogs) blockNumbers.add(BigInt(log.blockNumber))
    const blocks: IndexedBlock[] = []
    for (const number of [...blockNumbers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
      blocks.push(await this.block(number))
    const hashes = new Map(blocks.map((block) => [block.number.toString(), block.hash.toLowerCase()]))
    const logs = rawLogs.map((raw) => {
      if (
        raw.address.toLowerCase() !== EXCHANGE.toLowerCase() ||
        hashes.get(BigInt(raw.blockNumber).toString()) !== raw.blockHash.toLowerCase()
      )
        throw new Error('ANALYTICS_LOG_REORG_OR_ADDRESS_MISMATCH')
      const decoded = decodeExchangeLog(raw)
      const derived = decoded ? deriveEvent(decoded, markets) : null
      return { raw, decoded, derived }
    })
    await this.repo.saveChunk(blocks, logs, checkpoint.nextBlock, checkpoint.startBlock)
    return 'indexed'
  }
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      try {
        const result = await this.step()
        failures = 0
        if (result === 'caught-up') await wait(this.config.pollMs)
        else await wait(100) // public RPC request pacing
      } catch (error) {
        const message = error instanceof Error ? error.message : 'UNKNOWN'
        if (/HTTP_(401|403)/.test(message)) throw error
        console.error(`Analytics indexer: ${message}`)
        failures++
        await wait(Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)))
      }
    }
  }
}

export async function startAnalyticsIndexer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.EYELER_ANALYTICS_ENABLED !== 'true') return
  const config = indexerConfig(env)
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 4,
    ssl: config.databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
  })
  const lock = await pool.connect()
  const stop = new AbortController()
  const onStop = () => stop.abort()
  process.once('SIGINT', onStop)
  process.once('SIGTERM', onStop)
  try {
    const acquired = await lock.query('SELECT pg_try_advisory_lock(143, 20261007) AS acquired')
    if (!acquired.rows[0].acquired) throw new Error('ANALYTICS_INDEXER_ALREADY_RUNNING')
    await new AnalyticsIndexer(new AnalyticsRepository(pool), config).run(stop.signal)
  } finally {
    await lock.query('SELECT pg_advisory_unlock(143, 20261007)')
    lock.release()
    await pool.end()
    process.off('SIGINT', onStop)
    process.off('SIGTERM', onStop)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void startAnalyticsIndexer()
