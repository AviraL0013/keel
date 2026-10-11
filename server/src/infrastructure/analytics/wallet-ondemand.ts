import { createPublicClient, getAddress, http, toEventSelector, type AbiEvent, type Hex } from 'viem'
import { monad } from 'viem/chains'
import {
  deriveEvent,
  notionalMicros,
  signedMoney,
  type DerivedEvent,
  type MarketPrecision,
} from '../../../../packages/analytics/src/aggregate.js'
import type { Trade, WalletPerformance } from '../../../../packages/analytics/src/contract.js'
import {
  decodeExchangeLog,
  EXCHANGE,
  EXCHANGE_DEPLOYMENT_BLOCK,
  type ChainLog,
  type DecodedExchangeEvent,
} from '../../../../packages/analytics/src/decoder.js'
import { exchangeEvents } from '../../../../packages/analytics/src/exchange-events.js'
import {
  calculateWalletPerformance,
  type PositionEpisodeEvent,
} from '../../../../packages/analytics/src/performance.js'
import { historicalAccountOwner, type HistoricalOwnerClient } from './owner-proof.js'
import { scaledText, type PublicContext } from './perpl-public.js'

const DAY = 86_400_000
const WINDOW = 30 * DAY
const MAX_LOGS = 100_000
const MAX_PAGES = 500
const hashPattern = /^0x[0-9a-f]{64}$/i
const trackedNames = new Set([
  'AccountCreated',
  'MakerOrderFilled',
  'MakerOrderFilledV2',
  'TakerOrderFilled',
  'TakerOrderFilledV2',
  'PositionOpened',
  'PositionOpenedV2',
  'PositionIncreased',
  'PositionIncreasedV2',
  'PositionDecreased',
  'PositionClosed',
  'PositionInverted',
  'PositionLiquidated',
  'PositionDeleveraged',
  'PositionDeleveragedV2',
  'PositionUnwound',
  'PositionUnwoundV2',
])
const unsupportedNames = new Set([
  'PositionDeleveraged',
  'PositionDeleveragedV2',
  'PositionUnwound',
  'PositionUnwoundV2',
])
const topics = exchangeEvents
  .filter((event) => trackedNames.has(event.name))
  .map((event) => toEventSelector(event as AbiEvent))

type RawLog = Record<string, unknown>
export interface HyperSyncPage {
  next_block: number
  archive_height?: number | null
  data: Array<{ blocks?: Array<Record<string, unknown>>; logs?: RawLog[] }>
}
export interface HyperSyncTransport {
  height(): Promise<number>
  query(fromBlock: number, toBlock: number): Promise<HyperSyncPage>
}

/** HTTP API avoids another dependency. Token is used only in the Authorization header. */
export class HyperSyncHttp implements HyperSyncTransport {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://monad.hypersync.xyz',
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!token) throw Error('EYELER_HYPERSYNC_TOKEN_REQUIRED')
    if (!/^https:\/\//.test(baseUrl)) throw Error('HYPERSYNC_URL_INVALID')
  }
  async height(): Promise<number> {
    const response = await this.fetcher(`${this.baseUrl}/height`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw Error(`HYPERSYNC_HEIGHT_HTTP_${response.status}`)
    const body = (await response.json()) as { height?: unknown }
    return safeNumber(body.height)
  }
  async query(fromBlock: number, toBlock: number): Promise<HyperSyncPage> {
    const response = await this.fetcher(`${this.baseUrl}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({
        from_block: fromBlock,
        to_block: toBlock,
        logs: [{ address: [EXCHANGE], topics: [topics] }],
        field_selection: {
          block: ['number', 'hash', 'timestamp'],
          log: [
            'address',
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
        max_num_logs: 5000,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw Error(`HYPERSYNC_QUERY_HTTP_${response.status}`)
    return response.json() as Promise<HyperSyncPage>
  }
}

function safeNumber(value: unknown): number {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(number) || number < 0) throw Error('HYPERSYNC_NUMBER_INVALID')
  return number
}
function hex(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value)) throw Error('HYPERSYNC_HEX_INVALID')
  return value as Hex
}
function accountId(value: string): string {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n || BigInt(value) >= 1n << 256n)
    throw Error('ANALYTICS_ACCOUNT_ID_INVALID')
  return BigInt(value).toString()
}
function eventAccount(event: DecodedExchangeEvent): string | null {
  const raw = event.args.accountId ?? event.args.posAccountId
  return typeof raw === 'string' && /^\d+$/.test(raw) ? accountId(raw) : null
}
function normalizeLog(raw: RawLog): ChainLog {
  const rawTopics = [raw.topic0, raw.topic1, raw.topic2, raw.topic3].filter(
    (topic): topic is string => typeof topic === 'string',
  )
  return {
    address: getAddress(String(raw.address)),
    blockNumber: `0x${safeNumber(raw.block_number).toString(16)}`,
    blockHash: hex(raw.block_hash),
    transactionHash: hex(raw.transaction_hash),
    transactionIndex: `0x${safeNumber(raw.transaction_index).toString(16)}`,
    logIndex: `0x${safeNumber(raw.log_index).toString(16)}`,
    data: hex(raw.data),
    topics: rawTopics.map(hex),
    removed: raw.removed === true,
  }
}
function contextPrecision(context: PublicContext): Map<number, MarketPrecision> {
  if (
    context.chain?.chain_id !== 143 ||
    !context.instances?.some((item) => item.address.toLowerCase() === EXCHANGE.toLowerCase())
  )
    throw Error('ANALYTICS_RPC_CONTEXT_MISMATCH')
  const result = new Map<number, MarketPrecision>()
  const ids = new Set<number>()
  for (const market of context.markets ?? []) {
    if (
      !Number.isSafeInteger(market.id) ||
      market.id <= 0 ||
      !Number.isSafeInteger(market.perpetual_id) ||
      market.perpetual_id <= 0 ||
      ids.has(market.id) ||
      result.has(market.perpetual_id) ||
      ![market.config.price_decimals, market.config.size_decimals].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value <= 18,
      )
    )
      throw Error('ANALYTICS_MARKET_CONTEXT_INVALID')
    ids.add(market.id)
    result.set(market.perpetual_id, {
      marketId: market.id,
      priceDecimals: market.config.price_decimals,
      sizeDecimals: market.config.size_decimals,
    })
  }
  if (!result.size) throw Error('ANALYTICS_MARKET_CONTEXT_INVALID')
  return result
}

type Observed = { event: DecodedExchangeEvent; derived: DerivedEvent | null; at: number }
export interface WalletOnDemandResult {
  window: '30d'
  label: 'last 30 days'
  from: string
  through: string
  block: number
  source: 'monad_exchange'
  trades: Trade[]
  performance: WalletPerformance | null
  unavailableReason: string | null
  maxDrawdownUnavailableReason: 'STARTING_EQUITY_UNAVAILABLE' | null
}
export interface WalletOnDemandInput {
  address: string
  accountIds: string[]
  /** True only when the caller has enumerated every account that could belong to this wallet in the window. */
  accountsComplete: boolean
  context: PublicContext
  /** Proven equity at the window start. Without it percentage drawdown stays null. */
  startingEquityMicros?: bigint
}

export class WalletOnDemandAnalytics {
  private readonly cache = new Map<string, { expires: number; value: Promise<WalletOnDemandResult> }>()
  constructor(
    private readonly ownerClient: HistoricalOwnerClient,
    private readonly hypersync: HyperSyncTransport,
  ) {}
  async load(input: WalletOnDemandInput): Promise<WalletOnDemandResult> {
    const address = getAddress(input.address)
    const accountIds = [...new Set(input.accountIds.map(accountId))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
    const markets = contextPrecision(input.context)
    const key = JSON.stringify([
      address,
      accountIds,
      input.accountsComplete,
      [...markets],
      input.startingEquityMicros?.toString(),
    ])
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
    const value = this.fetchWindow(address, accountIds, input.accountsComplete, markets, input.startingEquityMicros)
    this.cache.set(key, { expires: Date.now() + 60_000, value })
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
    try {
      return await value
    } catch (error) {
      this.cache.delete(key)
      throw error
    }
  }
  private async fetchWindow(
    address: `0x${string}`,
    accountIds: string[],
    accountsComplete: boolean,
    markets: Map<number, MarketPrecision>,
    startingEquityMicros?: bigint,
  ): Promise<WalletOnDemandResult> {
    if ((await this.ownerClient.getChainId()) !== 143) throw Error('ANALYTICS_OWNER_CHAIN_MISMATCH')
    const finalized = await this.ownerClient.getBlock({ blockTag: 'finalized' })
    if (
      finalized.number === null ||
      finalized.number < EXCHANGE_DEPLOYMENT_BLOCK ||
      !finalized.hash ||
      !hashPattern.test(finalized.hash)
    )
      throw Error('ANALYTICS_RPC_FINALITY_UNAVAILABLE')
    const through = Number(finalized.timestamp) * 1000
    const end = safeNumber(finalized.number.toString())
    if (!Number.isSafeInteger(through) || through > Date.now() + 30_000 || through < 0)
      throw Error('ANALYTICS_RPC_FINALITY_UNAVAILABLE')
    const startTime = through - WINDOW
    let low = EXCHANGE_DEPLOYMENT_BLOCK,
      high = finalized.number
    while (low < high) {
      const middle = (low + high) / 2n
      const header = await this.ownerClient.getBlock({ blockNumber: middle })
      if (header.number !== middle || !header.hash || !hashPattern.test(header.hash))
        throw Error('ANALYTICS_WINDOW_BLOCK_UNAVAILABLE')
      if (Number(header.timestamp) * 1000 < startTime) low = middle + 1n
      else high = middle
    }
    if ((await this.hypersync.height()) < end) throw Error('HYPERSYNC_BEHIND_FINALITY')
    const blocks = new Map<number, { hash: string; at: number }>()
    const events: Observed[] = []
    const candidates = new Set(accountIds)
    let scanReason: string | null = null
    let cursor = safeNumber(low.toString())
    for (let pageCount = 0; cursor <= end; pageCount++) {
      if (pageCount >= MAX_PAGES) throw Error('HYPERSYNC_WINDOW_TOO_LARGE')
      const page = await this.hypersync.query(cursor, end + 1)
      const next = safeNumber(page.next_block)
      if (
        next <= cursor ||
        next > end + 1 ||
        !Array.isArray(page.data) ||
        (page.archive_height != null && safeNumber(page.archive_height) < end)
      )
        throw Error('HYPERSYNC_PAGE_INCOMPLETE')
      for (const block of page.data.flatMap((batch) => batch.blocks ?? [])) {
        const number = safeNumber(block.number)
        const hash = hex(block.hash)
        const at = safeNumber(block.timestamp) * 1000
        if (!hashPattern.test(hash) || !Number.isSafeInteger(at) || number < cursor || number >= next)
          throw Error('HYPERSYNC_BLOCK_INVALID')
        const prior = blocks.get(number)
        if (prior && (prior.hash !== hash || prior.at !== at)) throw Error('HYPERSYNC_BLOCK_CHANGED')
        blocks.set(number, { hash, at })
      }
      const pageEvents: Observed[] = []
      for (const raw of page.data.flatMap((batch) => batch.logs ?? [])) {
        const log = normalizeLog(raw)
        const number = safeNumber(BigInt(log.blockNumber).toString())
        const block = blocks.get(number)
        if (
          !block ||
          block.hash.toLowerCase() !== log.blockHash.toLowerCase() ||
          number < cursor ||
          number >= next ||
          getAddress(log.address) !== EXCHANGE
        )
          throw Error('HYPERSYNC_LOG_BLOCK_MISMATCH')
        if (block.at < startTime || block.at > through) continue
        const event = decodeExchangeLog(log)
        if (event) pageEvents.push({ event, derived: null, at: block.at })
      }
      for (const { event } of pageEvents) {
        if (
          event.eventName === 'AccountCreated' &&
          typeof event.args.account === 'string' &&
          getAddress(event.args.account) === address &&
          typeof event.args.id === 'string'
        )
          candidates.add(accountId(event.args.id))
      }
      const matchingTransactions = new Set(
        pageEvents
          .filter(({ event }) => {
            const id = eventAccount(event)
            return id !== null && candidates.has(id)
          })
          .map(({ event }) => `${event.block}:${event.txHash.toLowerCase()}`),
      )
      for (const item of pageEvents) {
        if (!matchingTransactions.has(`${item.event.block}:${item.event.txHash.toLowerCase()}`)) continue
        try {
          item.derived = deriveEvent(item.event, markets)
        } catch {
          scanReason = 'MARKET_OR_EVENT_CONTEXT_UNAVAILABLE'
        }
        events.push(item)
        if (events.length > MAX_LOGS) throw Error('HYPERSYNC_WINDOW_TOO_LARGE')
      }
      cursor = next
    }
    const after = await this.ownerClient.getBlock({ blockNumber: finalized.number })
    if (
      after.number !== finalized.number ||
      after.hash?.toLowerCase() !== finalized.hash.toLowerCase() ||
      after.timestamp !== finalized.timestamp
    )
      throw Error('ANALYTICS_RPC_BLOCK_CHANGED')
    events.sort(
      (a, b) =>
        Number(a.event.block - b.event.block) ||
        a.event.txIndex - b.event.txIndex ||
        a.event.logIndex - b.event.logIndex,
    )
    return this.reconcile(
      address,
      accountIds,
      accountsComplete,
      events,
      blocks,
      markets,
      startTime,
      through,
      end,
      startingEquityMicros,
      scanReason,
    )
  }
  private async reconcile(
    address: `0x${string}`,
    accountIds: string[],
    accountsComplete: boolean,
    events: Observed[],
    blocks: Map<number, { hash: string; at: number }>,
    markets: Map<number, MarketPrecision>,
    startTime: number,
    through: number,
    end: number,
    startingEquityMicros?: bigint,
    scanReason: string | null = null,
  ): Promise<WalletOnDemandResult> {
    const candidates = new Set(accountIds)
    for (const { event } of events) {
      if (
        event.eventName === 'AccountCreated' &&
        typeof event.args.account === 'string' &&
        getAddress(event.args.account) === address &&
        typeof event.args.id === 'string'
      )
        candidates.add(accountId(event.args.id))
    }
    const proofs = new Map<string, Promise<boolean>>()
    let reason: string | null = scanReason ?? (accountsComplete ? null : 'ACCOUNT_ENUMERATION_UNVERIFIED')
    const belongs = async (observed: Observed): Promise<boolean> => {
      const id = eventAccount(observed.event)
      if (!id || !candidates.has(id)) return false
      const block = blocks.get(Number(observed.event.block))!
      const key = `${id}:${observed.event.block}`
      if (!proofs.has(key))
        proofs.set(
          key,
          historicalAccountOwner(this.ownerClient, BigInt(id), observed.event.block, block.hash).then(
            (proof) => proof.address === address,
          ),
        )
      try {
        return await proofs.get(key)!
      } catch {
        reason = 'OWNERSHIP_UNAVAILABLE'
        return false
      }
    }
    const groups = new Map<string, Observed[]>()
    for (const observed of events) {
      const key = `${observed.event.block}:${observed.event.txHash.toLowerCase()}`
      const group = groups.get(key) ?? []
      group.push(observed)
      groups.set(key, group)
    }
    const trades: Trade[] = []
    const episodes: PositionEpisodeEvent[] = []
    const precisionByMarket = new Map([...markets.values()].map((item) => [item.marketId, item]))
    for (const group of groups.values()) {
      const owned = new Set<Observed>()
      for (const observed of group) if (await belongs(observed)) owned.add(observed)
      if (group.some((item) => owned.has(item) && unsupportedNames.has(item.event.eventName)))
        reason = 'SETTLEMENT_FORMULA_UNVERIFIED'
      const positions = group.filter((item) => owned.has(item) && item.derived?.kind === 'position')
      const liquidations = group.filter((item) => owned.has(item) && item.derived?.kind === 'liquidation')
      if (
        liquidations.some((liquidation) =>
          positions.some(
            (position) =>
              position.derived?.kind === 'position' &&
              liquidation.derived?.kind === 'liquidation' &&
              position.derived.accountId === liquidation.derived.accountId &&
              position.derived.marketId === liquidation.derived.marketId,
          ),
        )
      )
        reason = 'LIQUIDATION_SETTLEMENT_UNRECONCILED'
      const makerFills = group.filter((item) => owned.has(item) && item.derived?.kind === 'fill')
      const allMakerFills = group.filter((item) => item.derived?.kind === 'fill')
      const allPositions = group.filter((item) => item.derived?.kind === 'position')
      const takerFills = group.filter((item) => item.derived?.kind === 'taker_fee')
      const makerPairsVerified = allMakerFills.every((fill) => {
        const detail = fill.derived as Extract<DerivedEvent, { kind: 'fill' }>
        return (
          allMakerFills.filter(
            (item) =>
              item.derived?.kind === 'fill' &&
              item.derived.accountId === detail.accountId &&
              item.derived.marketId === detail.marketId,
          ).length === 1 &&
          allPositions.filter(
            (item) =>
              item.derived?.kind === 'position' &&
              item.derived.accountId === detail.accountId &&
              item.derived.marketId === detail.marketId,
          ).length === 1
        )
      })
      const used = new Set<Observed>()
      for (const fill of makerFills) {
        const derived = fill.derived as Extract<DerivedEvent, { kind: 'fill' }>
        const matching = positions.filter(
          (item) =>
            item.derived?.kind === 'position' &&
            item.derived.accountId === derived.accountId &&
            item.derived.marketId === derived.marketId,
        )
        const count = makerFills.filter(
          (item) =>
            item.derived?.kind === 'fill' &&
            item.derived.accountId === derived.accountId &&
            item.derived.marketId === derived.marketId,
        ).length
        if (matching.length !== 1 || count !== 1) {
          reason = 'FILL_ATTRIBUTION_UNRECONCILED'
          continue
        }
        const position = matching[0]
        used.add(position)
        const detail = position.derived as Extract<DerivedEvent, { kind: 'position' }>
        if (detail.action === 'invert') {
          reason = 'FILL_ATTRIBUTION_UNRECONCILED'
          continue
        }
        const precision = precisionByMarket.get(derived.marketId)!
        trades.push({
          id: `${fill.event.block}:${fill.event.txHash}:${fill.event.logIndex}`,
          time: new Date(fill.at).toISOString(),
          marketId: derived.marketId,
          side: detail.side,
          action: detail.action,
          size: scaledText(derived.sizeRaw, precision.sizeDecimals),
          price: scaledText(derived.priceRaw, precision.priceDecimals),
          notional: signedMoney(derived.notionalMicros),
          fee: signedMoney(derived.feeMicros),
          realizedPnl: detail.realizedPnlMicros === null ? null : signedMoney(detail.realizedPnlMicros),
          transactionHash: fill.event.txHash,
        })
      }
      const unmatched = allPositions.filter((item) => {
        const position = item.derived as Extract<DerivedEvent, { kind: 'position' }>
        const matches = allMakerFills.filter(
          (fill) =>
            fill.derived?.kind === 'fill' &&
            fill.derived.accountId === position.accountId &&
            fill.derived.marketId === position.marketId,
        )
        return matches.length === 0
      })
      const takerPosition = unmatched.length === 1 ? unmatched[0] : null
      if (positions.some((item) => !used.has(item))) {
        if (
          !makerPairsVerified ||
          takerFills.length !== 1 ||
          !takerPosition ||
          !owned.has(takerPosition) ||
          positions.filter((item) => !used.has(item)).length !== 1
        ) {
          reason = 'TAKER_ATTRIBUTION_UNRECONCILED'
        } else {
          const fill = takerFills[0]
          const position = takerPosition
          const detail = position.derived as Extract<DerivedEvent, { kind: 'position' }>
          const rawPrice = fill.event.args.entryPricePNS
          const rawSize = fill.event.args.lotLNS
          const precision = precisionByMarket.get(detail.marketId)
          if (detail.action === 'invert' || !precision || typeof rawPrice !== 'string' || typeof rawSize !== 'string')
            reason = 'TAKER_ATTRIBUTION_UNRECONCILED'
          else {
            const price = BigInt(rawPrice),
              size = BigInt(rawSize)
            trades.push({
              id: `${fill.event.block}:${fill.event.txHash}:${fill.event.logIndex}`,
              time: new Date(fill.at).toISOString(),
              marketId: detail.marketId,
              side: detail.side,
              action: detail.action,
              size: scaledText(size, precision.sizeDecimals),
              price: scaledText(price, precision.priceDecimals),
              notional: signedMoney(notionalMicros(price, size, precision.priceDecimals, precision.sizeDecimals)),
              fee: typeof fill.event.args.feeCNS === 'string' ? signedMoney(BigInt(fill.event.args.feeCNS)) : null,
              realizedPnl: detail.realizedPnlMicros === null ? null : signedMoney(detail.realizedPnlMicros),
              transactionHash: fill.event.txHash,
            })
            used.add(position)
          }
        }
      }
      for (const liquidation of liquidations) {
        const detail = liquidation.derived as Extract<DerivedEvent, { kind: 'liquidation' }>
        const precision = precisionByMarket.get(detail.marketId)!
        trades.push({
          id: `${liquidation.event.block}:${liquidation.event.txHash}:${liquidation.event.logIndex}`,
          time: new Date(liquidation.at).toISOString(),
          marketId: detail.marketId,
          side: detail.side,
          action: 'liquidation',
          size: scaledText(detail.lotRaw, precision.sizeDecimals),
          price: scaledText(detail.priceRaw, precision.priceDecimals),
          notional: signedMoney(detail.notionalMicros),
          fee: null,
          realizedPnl: signedMoney(detail.realizedPnlMicros),
          transactionHash: liquidation.event.txHash,
        })
      }
      for (const item of [...positions, ...liquidations]) {
        const detail = item.derived!
        if (detail.kind !== 'position' && detail.kind !== 'liquidation') continue
        if (detail.kind === 'position' && !used.has(item)) reason = 'FILL_ATTRIBUTION_UNRECONCILED'
        episodes.push({
          accountId: detail.accountId,
          marketId: detail.marketId,
          action:
            detail.kind === 'liquidation' ? (detail.remainingLotRaw > 0n ? 'reduce' : 'liquidation') : detail.action,
          realizedPnlMicros: detail.realizedPnlMicros,
          at: item.at,
        })
      }
    }
    trades.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
    let performance: WalletPerformance | null = null
    if (!reason) {
      try {
        performance = calculateWalletPerformance(address, episodes, startingEquityMicros, startTime)
      } catch {
        reason = 'EPISODE_OPENING_UNAVAILABLE'
      }
    }
    return {
      window: '30d',
      label: 'last 30 days',
      from: new Date(startTime).toISOString(),
      through: new Date(through).toISOString(),
      block: end,
      source: 'monad_exchange',
      trades,
      performance,
      unavailableReason: reason,
      maxDrawdownUnavailableReason:
        startingEquityMicros === undefined || startingEquityMicros <= 0n ? 'STARTING_EQUITY_UNAVAILABLE' : null,
    }
  }
}

export function walletOnDemandFromEnv(rpcUrl: string, env: NodeJS.ProcessEnv = process.env): WalletOnDemandAnalytics {
  const client = createPublicClient({ chain: monad, transport: http(rpcUrl, { timeout: 8000, retryCount: 0 }) })
  return new WalletOnDemandAnalytics(client, new HyperSyncHttp(env.EYELER_HYPERSYNC_TOKEN ?? ''))
}
