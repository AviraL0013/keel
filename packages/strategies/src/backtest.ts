import { createStrategy, initialState, strategyEquity, type StrategyConfig, type StrategyQuote } from './index.js'

export type PerplBacktestFixture = {
  source: string
  retrievedAt: string
  candleUrl: string
  fundingUrl: string
  marketId: number
  priceDecimals: number
  sizeDecimals: number
  baseMakerFeeMicros: number
  baseTakerFeeMicros: number
  candles: Array<{ t: number; o: number; c: number; h: number; l: number; v: string; n: number }>
  funding: Array<{ at: { b: number; t: number }; rate: number; idx: number; feb: number }>
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
    quoteCount: number
    filledQuoteCount: number
    riskEvents: string[]
  }
  equityCurve: Array<{ at: number; equity: number }>
}

const round = (value: number) => Number(value.toFixed(8))

/** Candle simulation: quote on one close, fill only after strict penetration on next candle. */
export function runBacktest(config: StrategyConfig, fixture: PerplBacktestFixture): BacktestReport {
  if (
    config.mode !== 'BACKTEST' ||
    fixture.marketId !== config.marketId ||
    !Number.isSafeInteger(fixture.priceDecimals) ||
    fixture.priceDecimals < 0 ||
    fixture.priceDecimals > 12 ||
    !Number.isSafeInteger(fixture.baseMakerFeeMicros) ||
    Math.abs(fixture.baseMakerFeeMicros) > 1_000_000 ||
    !Array.isArray(fixture.candles) ||
    fixture.candles.length < 2
  )
    throw new Error('STRATEGY_BACKTEST_INPUT_INVALID')
  const strategy = createStrategy(config)
  let state = initialState(config)
  let orders: StrategyQuote[] = []
  let quoteCount = 0
  let filledQuoteCount = 0
  let turnover = 0
  let fundingIndex = 0
  let appliedFundingEvents = 0
  let peak = config.capital
  let maxDrawdownPct = 0
  const equityCurve: BacktestReport['equityCurve'] = []
  const candles = [...fixture.candles].sort((a, b) => a.t - b.t)
  const funding = [...fixture.funding].sort((a, b) => a.at.t - b.at.t)
  const scale = 10 ** fixture.priceDecimals
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
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
    while (fundingIndex < funding.length && funding[fundingIndex]!.at.t <= candle.t) {
      const event = funding[fundingIndex++]!
      if (event.at.t < candles[0]!.t) continue
      const payment = (state.inventory * (event.idx / scale) * event.rate) / 1_000_000
      state = strategy.onFunding(state, { at: event.at.t, amount: payment })
      appliedFundingEvents++
    }
    if (index > 0 && orders.length) {
      const low = candle.l / scale
      const high = candle.h / scale
      const crossed = orders.filter((order) => (order.side === 'BUY' ? low < order.price : high > order.price))
      const bothSides = crossed.some((order) => order.side === 'BUY') && crossed.some((order) => order.side === 'SELL')
      if (!bothSides) {
        const volume = Number(candle.v) / 1_000_000
        let remainingNotional = Number.isFinite(volume) && volume > 0 ? volume * 0.01 : 0
        for (const order of crossed) {
          const size = Math.min(order.size, remainingNotional / order.price)
          if (size <= 0) continue
          const signed = order.side === 'BUY' ? size : -size
          const openingSize =
            state.inventory === 0 || Math.sign(state.inventory) === Math.sign(signed)
              ? size
              : Math.max(0, size - Math.abs(state.inventory))
          const fee = (openingSize * order.price * fixture.baseMakerFeeMicros) / 1_000_000
          state = strategy.onFill(state, { at: candle.t, side: order.side, price: order.price, size, fee })
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
      at: candle.t,
      bid: close - halfSpread,
      ask: close + halfSpread,
      mark: close,
      oracle: close,
      volatility: (candle.h - candle.l) / candle.c,
      fundingRate: 0,
    }
    const result = strategy.onTick(state, tick, candle.t)
    state = result.state
    orders = result.quotes
    quoteCount += orders.length
    const equity = strategyEquity(state, close)
    peak = Math.max(peak, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - equity) / peak) * 100 : 0)
    equityCurve.push({ at: candle.t, equity: round(equity) })
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
    from: candles[0]!.t,
    to: candles.at(-1)!.t,
    candles: candles.length,
    fundingEvents: funding.length,
    appliedFundingEvents,
    assumptions:
      'Orders enter after candle close; next-candle strict penetration; one percent volume cap; ambiguous two-sided candles skipped; all quotes canceled at next close; synthetic 10 bps spread; base maker fee on opening size; funding at recorded event rate. No queue, mark/oracle, liquidation, or actual fill proof.',
    metrics: {
      pnl: round(endingEquity - config.capital),
      endingEquity,
      maxDrawdownPct: round(maxDrawdownPct),
      sharpeLike: round(sharpeLike),
      fillRate: quoteCount ? filledQuoteCount / quoteCount : 0,
      turnover: round(turnover / config.capital),
      feesPaid: round(state.feesPaid),
      fundingPaid: round(state.fundingPaid),
      quoteCount,
      filledQuoteCount,
      riskEvents: state.riskEvents,
    },
    equityCurve,
  }
}
