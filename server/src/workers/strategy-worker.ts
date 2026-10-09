import { randomUUID } from 'node:crypto'
import { PerplAdapter, decodeTimestamp, type PerplEnvironment } from '../../../packages/perpl/src/index.js'
import { createStrategy, type StrategyQuote, type StrategyTick } from '../../../packages/strategies/src/index.js'
import {
  applyPaperFunding,
  type PaperFundingObservation,
  type PaperFundingEvent,
} from '../../../packages/strategies/src/paper-funding.js'
import { StrategyStore, type PaperFill } from '../infrastructure/strategies/store.js'

export type PaperSample = {
  tick: StrategyTick
  makerFeeMicros: number
  depthNotional: number
  funding?: PaperFundingObservation
}
export type StrategyMarketFeed = { sample(marketId: number): Promise<PaperSample>; close?(): void }

/** Public market observations only; no signed Perpl order path exists in paper mode. */
export class PerplPaperFeed implements StrategyMarketFeed {
  private readonly adapter: Pick<
    PerplAdapter,
    'getNormalizedMarket' | 'getProtocolContext' | 'getFundingHistory' | 'close'
  >
  constructor(
    private readonly environment: PerplEnvironment,
    adapter?: PerplPaperFeed['adapter'],
    private readonly now = Date.now,
  ) {
    this.adapter = adapter ?? new PerplAdapter(environment)
  }
  async sample(marketId: number): Promise<PaperSample> {
    const telemetry = await this.adapter.getNormalizedMarket(marketId)
    const context = await this.adapter.getProtocolContext()
    if ((context.chain as { chain_id?: number })?.chain_id !== (this.environment === 'mainnet' ? 143 : 10143))
      throw Error('STRATEGY_MARKET_ENVIRONMENT_MISMATCH')
    const market = context.markets.find((item) => item.id === marketId)
    const makerFeeMicros = Number(market?.config.maker_fee)
    if (!telemetry || !market || !Number.isSafeInteger(makerFeeMicros) || Math.abs(makerFeeMicros) > 1_000_000)
      throw new Error('STRATEGY_MARKET_UNAVAILABLE')
    const now = this.now()
    const intervalSeconds = market.funding_interval_sec
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds! <= 0 || intervalSeconds! > 86400)
      throw Error('STRATEGY_PAPER_FUNDING_UNAVAILABLE')
    // Perpl caps one request at 1024 intervals. Keep paper sampling within the
    // same 500-interval bound used by the recorder; no unbounded history fetch.
    const series = (await this.adapter.getFundingHistory(
      marketId,
      Math.max(0, now - intervalSeconds! * 1000 * 500),
      now,
    )) as { m?: number; d?: PaperFundingEvent[] }
    const head = (context.chain as { gas?: { h?: number; at?: { t?: unknown } } })?.gas
    const headAt = decodeTimestamp(head?.at?.t)
    if (series?.m !== marketId || !Array.isArray(series.d) || !headAt) throw Error('STRATEGY_PAPER_FUNDING_UNAVAILABLE')
    return {
      tick: {
        at: telemetry.timestamp,
        bid: telemetry.bid,
        ask: telemetry.ask,
        mark: telemetry.mark,
        oracle: telemetry.oracle,
        volatility: telemetry.volatility,
        fundingRate: telemetry.fundingRate,
        sourceTimes: {
          market: telemetry.marketTimestamp ?? telemetry.timestamp,
          orderbook: telemetry.orderbookTimestamp ?? 0,
          funding: telemetry.fundingTimestamp ?? 0,
        },
      },
      makerFeeMicros,
      depthNotional: telemetry.depthNotional,
      funding: {
        marketId,
        events: series.d,
        head: { block: head!.h!, at: headAt },
        intervalBlocks: market.funding_interval_blocks!,
        priceDecimals: Number(market.config.price_decimals),
      },
    }
  }
  close() {
    this.adapter.close()
  }
}

/** Runs only under Eyeler's worker lease. Live strategies are refused by StrategyStore.start. */
export class StrategyWorker {
  constructor(
    private readonly store: StrategyStore,
    private readonly feed: StrategyMarketFeed,
    private readonly now: () => number = Date.now,
    private readonly executionDisabled: () => boolean = () => true,
  ) {}

  async tick(): Promise<void> {
    for (const row of await this.store.running()) {
      if (row.mode !== 'PAPER') continue
      const strategy = createStrategy(row.config)
      let state = row.state
      let now = this.now()
      if (this.executionDisabled() || (await this.store.killed(row.user_id))) {
        state = strategy.onRiskEvent(state, this.executionDisabled() ? 'EXECUTION_DISABLED' : 'KILL_SWITCH')
        await this.store.savePaperTick(
          row,
          { ...state, openOrders: [] },
          state.openOrders.flatMap((quote) => (quote.id ? [quote.id] : [])),
          [],
          [],
        )
        continue
      }
      let sample: PaperSample
      try {
        sample = await this.feed.sample(row.market_id)
        now = this.now()
      } catch {
        state = strategy.onRiskEvent(state, 'STALE_DATA')
        await this.store.savePaperTick(
          row,
          { ...state, openOrders: [] },
          state.openOrders.flatMap((quote) => (quote.id ? [quote.id] : [])),
          [],
          [],
        )
        continue
      }
      let funding: { at: number; amount: number } | undefined
      try {
        if (sample.funding?.marketId !== row.market_id) throw Error('STRATEGY_PAPER_FUNDING_TERMS_CHANGED')
        const result = applyPaperFunding(state, sample.funding, now, row.config.maxDataAgeMs)
        funding = result.funding
        state = result.state
      } catch {
        state = strategy.onRiskEvent(state, 'FUNDING')
        await this.store.savePaperTick(
          row,
          { ...state, openOrders: [] },
          state.openOrders.flatMap((quote) => (quote.id ? [quote.id] : [])),
          [],
          [],
        )
        continue
      }
      const preflight = strategy.onTick({ ...state, openOrders: [] }, sample.tick, now)
      if (preflight.risk.length) {
        await this.store.savePaperTick(
          row,
          { ...preflight.state, openOrders: [] },
          state.openOrders.flatMap((quote) => (quote.id ? [quote.id] : [])),
          [],
          [],
          funding,
        )
        continue
      }
      const fills: PaperFill[] = []
      const remaining: StrategyQuote[] = []
      let matchableNotional =
        Number.isFinite(sample.depthNotional) && sample.depthNotional > 0 ? sample.depthNotional * 0.01 : 0
      for (const quote of state.openOrders) {
        const crossed = quote.side === 'BUY' ? sample.tick.ask < quote.price : sample.tick.bid > quote.price
        const size = crossed ? Math.min(quote.size, matchableNotional / quote.price) : 0
        if (size > 0 && quote.id) {
          const signed = quote.side === 'BUY' ? size : -size
          const opening =
            state.inventory === 0 || Math.sign(state.inventory) === Math.sign(signed)
              ? size
              : Math.max(0, size - Math.abs(state.inventory))
          const fee = (opening * quote.price * sample.makerFeeMicros) / 1_000_000
          state = strategy.onFill(state, { at: now, side: quote.side, price: quote.price, size, fee })
          fills.push({ id: randomUUID(), orderId: quote.id, side: quote.side, price: quote.price, size, fee, at: now })
          matchableNotional -= size * quote.price
        }
        if (quote.size - size > 1e-9) remaining.push({ ...quote, size: quote.size - size })
      }
      const due = row.config.kind === 'GRID' || now - state.lastRefreshAt >= row.config.maker!.refreshMs
      const result = strategy.onTick({ ...state, openOrders: due ? [] : remaining }, sample.tick, now)
      const cancel = result.risk.length || due ? remaining.flatMap((quote) => (quote.id ? [quote.id] : [])) : []
      const quotes = result.risk.length || !due ? [] : result.quotes.map((quote) => ({ ...quote, id: randomUUID() }))
      const next = { ...result.state, openOrders: result.risk.length ? [] : due ? quotes : remaining }
      await this.store.savePaperTick(row, next, cancel, fills, quotes, funding)
    }
  }
  async close() {
    this.feed.close?.()
    await this.store.cancelPaperQuotes()
  }
}
