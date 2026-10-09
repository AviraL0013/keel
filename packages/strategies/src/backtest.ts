import { createStrategy, initialState, strategyEquity, type StrategyConfig, type StrategyQuote } from './index.js'

export type PerplBacktestFixture = {
  source: string
  retrievedAt: string
  candleUrl: string
  fundingUrl: string
  fundingUrls?: string[]
  marketId: number
  priceDecimals: number
  sizeDecimals: number
  baseMakerFeeMicros: number
  baseTakerFeeMicros: number
  candles: Array<{ t: number; o: number; c: number; h: number; l: number; v: string; n: number }>
  funding: Array<{
    at: { b: number; t: number }
    rate: number
    idx: number
    feb: number
    ppl: number
    sum: number
    div: number
  }>
}
export type BacktestReport = {
  source: string
  from: number
  to: number
  candles: number
  fundingEvents: number
  appliedFundingEvents: number
  assumptions: string
  metrics: {
    pnl: number
    endingEquity: number
    maxDrawdownPct: number
    sharpeLike: number
    fillRate: number
    turnover: number
    feesPaid: number
    fundingPaid: number
    executionStressCost: number
    quoteCount: number
    filledQuoteCount: number
    riskEvents: string[]
  }
  equityCurve: Array<{ at: number; equity: number }>
}
export type BacktestStress = {
  participationBps: number
  queueAheadNotional: number
  penetrationBps: number
  adverseSelectionBps: number
}

const round = (value: number) => Number(value.toFixed(8))

/** Validate the complete timeline before any split or simulation. */
export function backtestTimeline(fixture: PerplBacktestFixture) {
  if (!Array.isArray(fixture.candles) || fixture.candles.length < 2 || !Array.isArray(fixture.funding))
    throw Error('STRATEGY_BACKTEST_INPUT_INVALID')
  const candles = [...fixture.candles].sort((a, b) => a.t - b.t)
  const intervals = new Map<number, PerplBacktestFixture['funding'][number]>()
  for (const event of fixture.funding) {
    if (
      !event ||
      !event.at ||
      ![event.at.b, event.at.t, event.feb, event.rate, event.idx, event.ppl, event.sum, event.div].every(
        Number.isSafeInteger,
      ) ||
      event.at.b <= 0 ||
      event.at.b !== event.feb ||
      event.at.t < 0 ||
      event.idx <= 0 ||
      event.div <= 0
    )
      throw Error('STRATEGY_BACKTEST_FUNDING_INVALID')
    // Only div=1 payment scaling is independently established by the API example.
    if (event.div !== 1) throw Error('STRATEGY_BACKTEST_FUNDING_SCALE_UNVERIFIED')
    const prior = intervals.get(event.feb)
    if (
      prior &&
      ['rate', 'idx', 'ppl', 'sum', 'div'].some(
        (key) => prior[key as keyof typeof prior] !== event[key as keyof typeof event],
      )
    )
      throw Error('STRATEGY_BACKTEST_FUNDING_CONFLICT')
    intervals.set(event.feb, event)
  }
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
    if (
      ![candle.t, candle.o, candle.c, candle.h, candle.l, candle.n].every(Number.isSafeInteger) ||
      candle.t < 0 ||
      candle.l <= 0 ||
      candle.h < candle.l ||
      candle.o < candle.l ||
      candle.o > candle.h ||
      candle.c < candle.l ||
      candle.c > candle.h ||
      candle.n < 0 ||
      !/^\d+$/.test(candle.v)
    )
      throw Error('STRATEGY_BACKTEST_CANDLE_INVALID')
    if (index > 0 && candle.t - candles[index - 1]!.t !== 3_600_000) throw Error('STRATEGY_BACKTEST_CANDLE_GAP')
  }
  return { candles, funding: [...intervals.values()].sort((a, b) => a.at.t - b.at.t) }
}

/** Candle simulation: quote on one close, fill only after strict penetration on next candle. */
export function runBacktest(
  config: StrategyConfig,
  fixture: PerplBacktestFixture,
  stress?: BacktestStress,
): BacktestReport {
  if (
    config.mode !== 'BACKTEST' ||
    fixture.marketId !== config.marketId ||
    !Number.isSafeInteger(fixture.priceDecimals) ||
    fixture.priceDecimals < 0 ||
    fixture.priceDecimals > 12 ||
    !Number.isSafeInteger(fixture.sizeDecimals) ||
    fixture.sizeDecimals < 0 ||
    fixture.sizeDecimals > 12 ||
    !Number.isSafeInteger(fixture.baseMakerFeeMicros) ||
    Math.abs(fixture.baseMakerFeeMicros) > 1_000_000 ||
    !Array.isArray(fixture.candles) ||
    fixture.candles.length < 2 ||
    !Array.isArray(fixture.funding)
  )
    throw new Error('STRATEGY_BACKTEST_INPUT_INVALID')
  const assumptions = stress ?? {
    participationBps: 100,
    queueAheadNotional: 0,
    penetrationBps: 0,
    adverseSelectionBps: 0,
  }
  if (
    !Number.isSafeInteger(assumptions.participationBps) ||
    assumptions.participationBps <= 0 ||
    assumptions.participationBps > 100 ||
    !Number.isFinite(assumptions.queueAheadNotional) ||
    assumptions.queueAheadNotional < 0 ||
    ![assumptions.penetrationBps, assumptions.adverseSelectionBps].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 200,
    )
  )
    throw Error('STRATEGY_BACKTEST_STRESS_INVALID')
  const strategy = createStrategy(config)
  let state = initialState(config)
  let orders: StrategyQuote[] = []
  let quoteCount = 0
  let filledQuoteCount = 0
  let turnover = 0
  let executionStressCost = 0
  let fundingIndex = 0
  let appliedFundingEvents = 0
  let peak = config.capital
  let maxDrawdownPct = 0
  const equityCurve: BacktestReport['equityCurve'] = []
  const { candles, funding } = backtestTimeline(fixture)
  const scale = 10 ** fixture.priceDecimals
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
    const closeAt = candle.t + 3_600_000
    const close = candle.c / scale
    if (!(
      Number.isSafeInteger(candle.t) &&
      candle.c > 0 &&
      candle.h >= candle.l &&
      candle.h >= candle.c &&
      candle.l <= candle.c &&
      Number.isFinite(close) &&
      close > 0
    ))
      throw new Error('STRATEGY_BACKTEST_CANDLE_INVALID')
    while (fundingIndex < funding.length && funding[fundingIndex]!.at.t <= closeAt) {
      const event = funding[fundingIndex++]!
      if (event.at.t < candles[0]!.t) continue
      const payment = state.inventory * (event.ppl / scale)
      state = strategy.onFunding(state, { at: event.at.t, amount: payment })
      appliedFundingEvents++
    }
    if (index > 0 && orders.length) {
      const low = candle.l / scale
      const high = candle.h / scale
      const penetration = assumptions.penetrationBps / 10_000
      const crossed = orders.filter((order) =>
        order.side === 'BUY' ? low < order.price * (1 - penetration) : high > order.price * (1 + penetration),
      )
      const bothSides = crossed.some((order) => order.side === 'BUY') && crossed.some((order) => order.side === 'SELL')
      if (!bothSides) {
        const volume = Number(candle.v) / 1_000_000
        let remainingNotional =
          Number.isFinite(volume) && volume > 0
            ? Math.max(0, (volume * assumptions.participationBps) / 10_000 - assumptions.queueAheadNotional)
            : 0
        for (const order of crossed) {
          const sizeScale = 10 ** fixture.sizeDecimals
          const size = Math.floor(Math.min(order.size, remainingNotional / order.price) * sizeScale) / sizeScale
          if (size <= 0) continue
          const signed = order.side === 'BUY' ? size : -size
          const openingSize =
            state.inventory === 0 || Math.sign(state.inventory) === Math.sign(signed)
              ? size
              : Math.max(0, size - Math.abs(state.inventory))
          const fee = (openingSize * order.price * fixture.baseMakerFeeMicros) / 1_000_000
          // An explicitly hypothetical adverse-selection cost is separate from venue fees.
          const penalty = (size * order.price * assumptions.adverseSelectionBps) / 10_000
          executionStressCost += penalty
          state = strategy.onFill(state, { at: closeAt, side: order.side, price: order.price, size, fee })
          state = { ...state, cashFlow: state.cashFlow - penalty }
          remainingNotional -= size * order.price
          turnover += size * order.price
          filledQuoteCount++
        }
      }
    }
    // Every simulated order is canceled before refresh. Candle OHLC has no order-level lifetime or queue data.
    orders = []
    state = { ...state, openOrders: [] }
    const halfSpread = close * 0.0005
    const tick = {
      at: closeAt,
      bid: close - halfSpread,
      ask: close + halfSpread,
      mark: close,
      oracle: close,
      volatility: (candle.h - candle.l) / candle.c,
      fundingRate: 0,
    }
    const result = strategy.onTick(state, tick, closeAt)
    state = result.state
    orders = result.quotes
    quoteCount += orders.length
    const equity = strategyEquity(state, close)
    peak = Math.max(peak, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - equity) / peak) * 100 : 0)
    equityCurve.push({ at: closeAt, equity: round(equity) })
  }
  const endingEquity = equityCurve.at(-1)!.equity
  const returns = equityCurve
    .slice(1)
    .map((point, index) => (point.equity - equityCurve[index]!.equity) / Math.max(equityCurve[index]!.equity, 1e-9))
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length
  const sharpeLike = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(returns.length) : 0
  return {
    source: fixture.source,
    from: equityCurve[0]!.at,
    to: equityCurve.at(-1)!.at,
    candles: candles.length,
    fundingEvents: funding.length,
    appliedFundingEvents,
    assumptions: `Orders enter after hourly candle close (open timestamp plus one hour); next-candle strict penetration (${assumptions.penetrationBps} bps); ${assumptions.participationBps} bps volume participation cap; hypothetical queue-ahead notional ${assumptions.queueAheadNotional} and adverse-selection cost ${assumptions.adverseSelectionBps} bps; size rounded down to step; ambiguous two-sided candles skipped; all quotes canceled at next close; synthetic 10 bps spread; base maker fee on opening size; funding at recorded payment per lot, once per interval, div=1 only, on pre-bar inventory before hypothetical close-time fills. Intrabar funding exposure is unknown. No actual queue, mark/oracle, liquidation, or fill proof.`,
    metrics: {
      pnl: round(endingEquity - config.capital),
      endingEquity,
      maxDrawdownPct: round(maxDrawdownPct),
      sharpeLike: round(sharpeLike),
      fillRate: quoteCount ? filledQuoteCount / quoteCount : 0,
      turnover: round(turnover / config.capital),
      feesPaid: round(state.feesPaid),
      fundingPaid: round(state.fundingPaid),
      executionStressCost: round(executionStressCost),
      quoteCount,
      filledQuoteCount,
      riskEvents: state.riskEvents,
    },
    equityCurve,
  }
}
