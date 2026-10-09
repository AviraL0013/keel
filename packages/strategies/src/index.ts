export type StrategyMode = 'BACKTEST' | 'PAPER' | 'LIVE'
export type StrategyKind = 'GRID' | 'MARKET_MAKER'
export type StrategySide = 'BUY' | 'SELL'
export type StrategyConfig = {
  kind: StrategyKind
  mode: StrategyMode
  marketId: number
  accountId: number
  capital: number
  quoteSize: number
  maxNotional: number
  maxInventory: number
  maxOpenOrders: number
  maxDailyLoss: number
  maxDrawdownPct: number
  maxVolatility: number
  maxDataAgeMs: number
  maxPriceBandBps: number
  maxFundingRate: number
  leverage: number
  liveConfirmed?: boolean
  grid?: { lower: number; upper: number; levels: number }
  maker?: { baseSpreadBps: number; volatilitySpreadMultiplier: number; inventorySkewBps: number; refreshMs: number }
}
export type StrategyTick = {
  at: number
  bid: number
  ask: number
  mark: number
  oracle: number
  volatility: number
  fundingRate: number
  sourceTimes?: { market: number; orderbook: number; funding: number }
}
export type StrategyFill = { at: number; side: StrategySide; price: number; size: number; fee: number }
export type StrategyFunding = { at: number; amount: number }
export type StrategyQuote = { id?: string; side: StrategySide; price: number; size: number }
export type StrategyRiskCode =
  | 'DAILY_LOSS'
  | 'DRAWDOWN'
  | 'VOLATILITY'
  | 'STALE_DATA'
  | 'PRICE_BAND'
  | 'FUNDING'
  | 'INVENTORY'
  | 'NOTIONAL'
  | 'OPEN_ORDERS'
  | 'KILL_SWITCH'
  | 'EXECUTION_DISABLED'
export type StrategyState = {
  capital: number
  inventory: number
  cashFlow: number
  feesPaid: number
  fundingPaid: number
  peakEquity: number
  dayStartEquity: number
  dayKey: string
  lastRefreshAt: number
  lastMark?: number
  lastFundingAt?: number
  /** Paper-only interval identity. This is not verified live financial evidence. */
  paperFundingCursor?: {
    marketId: number
    feb: number
    rate: number
    idx: number
    ppl: number
    sum: number
    div: number
    at: number
    intervalBlocks: number
    priceDecimals: number
  }
  lastPaperObservedAt?: number
  openOrders: StrategyQuote[]
  status: 'READY' | 'PAUSED' | 'HALTED'
  riskEvents: StrategyRiskCode[]
}
export type StrategyResult = { state: StrategyState; quotes: StrategyQuote[]; risk: StrategyRiskCode[] }
export type Strategy = {
  onTick(state: StrategyState, tick: StrategyTick, now: number): StrategyResult
  onFill(state: StrategyState, fill: StrategyFill): StrategyState
  onFunding(state: StrategyState, funding: StrategyFunding): StrategyState
  onRiskEvent(state: StrategyState, event: StrategyRiskCode): StrategyState
}

const finitePositive = (value: number) => Number.isFinite(value) && value > 0
const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0

export function validateStrategyConfig(config: StrategyConfig, liveEnabled = false): StrategyConfig {
  if (
    !['GRID', 'MARKET_MAKER'].includes(config.kind) ||
    !['BACKTEST', 'PAPER', 'LIVE'].includes(config.mode) ||
    !Number.isSafeInteger(config.marketId) ||
    config.marketId <= 0 ||
    !Number.isSafeInteger(config.accountId) ||
    config.accountId <= 0 ||
    ![
      config.capital,
      config.quoteSize,
      config.maxNotional,
      config.maxInventory,
      config.maxDailyLoss,
      config.maxDrawdownPct,
      config.maxVolatility,
      config.maxDataAgeMs,
      config.maxPriceBandBps,
      config.maxFundingRate,
      config.leverage,
    ].every(finitePositive) ||
    !Number.isSafeInteger(config.maxOpenOrders) ||
    config.maxOpenOrders < 1 ||
    config.maxOpenOrders > 100 ||
    config.maxDrawdownPct > 100 ||
    config.maxDailyLoss > config.capital ||
    config.leverage > 100 ||
    config.maxVolatility > 1 ||
    config.maxFundingRate > 1 ||
    config.maxPriceBandBps > 1000 ||
    config.maxNotional > config.capital * config.leverage
  )
    throw new Error('STRATEGY_CONFIG_INVALID')
  if (config.kind === 'GRID') {
    const grid = config.grid
    if (
      !grid ||
      !finitePositive(grid.lower) ||
      !finitePositive(grid.upper) ||
      grid.lower >= grid.upper ||
      !Number.isSafeInteger(grid.levels) ||
      grid.levels < 2 ||
      grid.levels > 100
    )
      throw new Error('STRATEGY_CONFIG_INVALID')
  } else {
    const maker = config.maker
    if (
      !maker ||
      !finitePositive(maker.baseSpreadBps) ||
      maker.baseSpreadBps > 1000 ||
      !finiteNonnegative(maker.volatilitySpreadMultiplier) ||
      !finiteNonnegative(maker.inventorySkewBps) ||
      !Number.isSafeInteger(maker.refreshMs) ||
      maker.refreshMs < 100
    )
      throw new Error('STRATEGY_CONFIG_INVALID')
  }
  if (config.mode === 'LIVE' && (!liveEnabled || config.liveConfirmed !== true))
    throw new Error('STRATEGIES_LIVE_DISABLED')
  return structuredClone(config)
}

export function initialState(config: StrategyConfig): StrategyState {
  return {
    capital: config.capital,
    inventory: 0,
    cashFlow: 0,
    feesPaid: 0,
    fundingPaid: 0,
    peakEquity: config.capital,
    dayStartEquity: config.capital,
    dayKey: '',
    lastRefreshAt: 0,
    openOrders: [],
    status: 'READY',
    riskEvents: [],
  }
}

export function strategyEquity(state: StrategyState, mark: number): number {
  return state.capital + state.cashFlow + state.inventory * mark - state.feesPaid - state.fundingPaid
}

function validatedTick(tick: StrategyTick, now: number, config: StrategyConfig): StrategyRiskCode[] {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(tick.at) ||
    ![tick.bid, tick.ask, tick.mark, tick.oracle, tick.volatility, tick.fundingRate].every(Number.isFinite) ||
    tick.bid <= 0 ||
    tick.ask <= tick.bid ||
    tick.mark <= 0 ||
    tick.oracle <= 0 ||
    tick.at > now ||
    now - tick.at > config.maxDataAgeMs
  )
    return ['STALE_DATA']
  if (
    tick.sourceTimes &&
    Object.values(tick.sourceTimes).some(
      (at) => !Number.isSafeInteger(at) || at <= 0 || at > now || now - at > config.maxDataAgeMs,
    )
  )
    return ['STALE_DATA']
  const risk: StrategyRiskCode[] = []
  if (tick.volatility > config.maxVolatility) risk.push('VOLATILITY')
  if (
    Math.abs(tick.mark / tick.oracle - 1) * 10_000 > config.maxPriceBandBps + 1e-8 ||
    Math.abs(tick.bid / tick.oracle - 1) * 10_000 > config.maxPriceBandBps + 1e-8 ||
    Math.abs(tick.ask / tick.oracle - 1) * 10_000 > config.maxPriceBandBps + 1e-8
  )
    risk.push('PRICE_BAND')
  if (Math.abs(tick.fundingRate) > config.maxFundingRate) risk.push('FUNDING')
  return risk
}

function desiredQuotes(config: StrategyConfig, state: StrategyState, tick: StrategyTick): StrategyQuote[] {
  if (config.kind === 'GRID') {
    const { lower, upper, levels } = config.grid!
    const quotes: StrategyQuote[] = []
    for (let index = 0; index < levels; index++) {
      const price = Number((lower + ((upper - lower) * index) / (levels - 1)).toFixed(8))
      if (price <= tick.bid) quotes.push({ side: 'BUY', price, size: config.quoteSize })
      else if (price >= tick.ask) quotes.push({ side: 'SELL', price, size: config.quoteSize })
    }
    return quotes.sort((a, b) => Math.abs(a.price - tick.mark) - Math.abs(b.price - tick.mark))
  }
  const maker = config.maker!
  const spreadBps = maker.baseSpreadBps + tick.volatility * maker.volatilitySpreadMultiplier
  const skewBps = (state.inventory / config.maxInventory) * maker.inventorySkewBps
  const mid = (tick.bid + tick.ask) / 2
  const skew = (mid * skewBps) / 10_000
  const bid = Math.min(tick.bid, Math.min(tick.bid, mid * (1 - spreadBps / 10_000)) - skew)
  const ask = Math.max(tick.ask, Math.max(tick.ask, mid * (1 + spreadBps / 10_000)) - skew)
  return [
    { side: 'BUY', price: Number(bid.toFixed(8)), size: config.quoteSize },
    { side: 'SELL', price: Number(ask.toFixed(8)), size: config.quoteSize },
  ]
}

export function createStrategy(configInput: StrategyConfig, liveEnabled = false): Strategy {
  const config = validateStrategyConfig(configInput, liveEnabled)
  return {
    onTick(state, tick, now) {
      const tickRisk = validatedTick(tick, now, config)
      if (tickRisk.includes('STALE_DATA')) {
        const riskEvents = [...new Set([...state.riskEvents, 'STALE_DATA' as const])]
        return { state: { ...state, status: 'HALTED', riskEvents }, quotes: [], risk: ['STALE_DATA'] }
      }
      const equity = strategyEquity(state, tick.mark)
      const dayKey = new Date(now).toISOString().slice(0, 10)
      const dayStartEquity = !state.dayKey || state.dayKey === dayKey ? state.dayStartEquity : equity
      const peakEquity = Math.max(state.peakEquity, equity)
      const next = {
        ...state,
        dayKey,
        dayStartEquity,
        peakEquity,
        lastMark: tick.mark,
        riskEvents: [...state.riskEvents],
      }
      const risk = tickRisk
      if (Math.abs(state.inventory) > config.maxInventory + 1e-9) risk.push('INVENTORY')
      if (state.openOrders.length > config.maxOpenOrders) risk.push('OPEN_ORDERS')
      if (
        Math.abs(state.inventory) * tick.mark +
          state.openOrders.reduce((sum, order) => sum + order.price * order.size, 0) >
        config.maxNotional + 1e-9
      )
        risk.push('NOTIONAL')
      if (dayStartEquity - equity >= config.maxDailyLoss) risk.push('DAILY_LOSS')
      if (peakEquity > 0 && ((peakEquity - equity) / peakEquity) * 100 >= config.maxDrawdownPct) risk.push('DRAWDOWN')
      if (state.status !== 'READY') return { state: next, quotes: [], risk: [...risk, ...state.riskEvents] }
      if (risk.length)
        return {
          state: { ...next, status: 'HALTED', riskEvents: [...new Set([...next.riskEvents, ...risk])] },
          quotes: [],
          risk,
        }
      if (config.kind === 'MARKET_MAKER' && now - state.lastRefreshAt < config.maker!.refreshMs)
        return { state: next, quotes: [], risk: [] }
      const quotes: StrategyQuote[] = []
      let buy = state.openOrders.filter((order) => order.side === 'BUY').reduce((sum, order) => sum + order.size, 0)
      let sell = state.openOrders.filter((order) => order.side === 'SELL').reduce((sum, order) => sum + order.size, 0)
      let notional = state.openOrders.reduce(
        (sum, order) => sum + order.price * order.size,
        Math.abs(state.inventory) * tick.mark,
      )
      for (const quote of desiredQuotes(config, state, tick)) {
        if (
          Math.abs(quote.price / tick.mark - 1) * 10_000 > config.maxPriceBandBps + 1e-8 ||
          Math.abs(quote.price / tick.oracle - 1) * 10_000 > config.maxPriceBandBps + 1e-8
        )
          continue
        if (quotes.length + state.openOrders.length >= config.maxOpenOrders) break
        if (quote.side === 'BUY' && state.inventory + buy + quote.size > config.maxInventory + 1e-9) continue
        if (quote.side === 'SELL' && state.inventory - sell - quote.size < -config.maxInventory - 1e-9) continue
        if (notional + quote.price * quote.size > config.maxNotional + 1e-9) continue
        if (quote.side === 'BUY') buy += quote.size
        else sell += quote.size
        notional += quote.price * quote.size
        quotes.push(quote)
      }
      return { state: { ...next, lastRefreshAt: now }, quotes, risk: [] }
    },
    onFill(state, fill) {
      if (![fill.at, fill.price, fill.size, fill.fee].every(Number.isFinite) || fill.price <= 0 || fill.size <= 0)
        throw new Error('STRATEGY_FILL_INVALID')
      const signed = fill.side === 'BUY' ? fill.size : -fill.size
      return {
        ...state,
        inventory: state.inventory + signed,
        cashFlow: state.cashFlow - signed * fill.price,
        feesPaid: state.feesPaid + fill.fee,
      }
    },
    onFunding(state, funding) {
      if (!Number.isFinite(funding.at) || !Number.isFinite(funding.amount)) throw new Error('STRATEGY_FUNDING_INVALID')
      return { ...state, fundingPaid: state.fundingPaid + funding.amount }
    },
    onRiskEvent(state, event) {
      return { ...state, status: 'HALTED', riskEvents: [...new Set([...state.riskEvents, event])] }
    },
  }
}
