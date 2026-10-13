import Decimal from 'decimal.js'
import type { StrategyConfig } from './index.js'
import type { OpeningMarketDetail } from '../../perpl/src/opening-market.js'
import type { WireOrder, WirePosition } from '../../perpl/src/decoder.js'

const Exact = Decimal.clone({ precision: 160 })
export type LiveStrategySnapshot = {
  environment: 'mainnet' | 'testnet'
  accountId: number
  marketId: number
  account: { balance: string; locked: string; lastRequestId: string }
  market: OpeningMarketDetail
  contractMarketId: number
  oracleRaw: number
  volatility: string
  fundingRate: string
  makerFeeMicros: number
  funding: { sumRaw: string; divisor: string }
  positions: WirePosition[]
  orders: WireOrder[]
  observedAt: number
  headBlock: number
  epoch: string
  sequence: number
  /** Same-block Exchange views, including the venue's position PnL and funding. */
  equity: string
  inventory: string
  positionCollateral: string
  depositTotal: string
  withdrawalTotal: string
  chainBlock: number
  chainHash: string
  chainFinalized: boolean
}
export type LiveStrategyRiskState = {
  baselineEquity: string
  peakEquity: string
  dayStartEquity: string
  dayKey: string
  lastRefreshAt: number
  lastBlock: number
  lastRequestId: string
  depositTotal: string
  withdrawalTotal: string
}
export type LiveStrategyQuote = {
  side: 'BUY' | 'SELL'
  priceRaw: number
  sizeRaw: number
  price: string
  size: string
  required: string
}
const value = (input: string | number) => {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(String(input))) throw Error('STRATEGY_LIVE_DECIMAL_INVALID')
  const parsed = new Exact(String(input))
  if (!parsed.isFinite()) throw Error('STRATEGY_LIVE_DECIMAL_INVALID')
  return parsed
}
export function startLiveRisk(snapshot: LiveStrategySnapshot, now: number): LiveStrategyRiskState {
  return {
    baselineEquity: value(snapshot.equity).toFixed(),
    peakEquity: value(snapshot.equity).toFixed(),
    dayStartEquity: value(snapshot.equity).toFixed(),
    dayKey: new Date(now).toISOString().slice(0, 10),
    lastRefreshAt: 0,
    lastBlock: snapshot.chainBlock,
    lastRequestId: snapshot.account.lastRequestId,
    depositTotal: snapshot.depositTotal,
    withdrawalTotal: snapshot.withdrawalTotal,
  }
}

/** Exact quote sizing and account risk. A quote is a proposal, never send authorization. */
export function planLiveStrategy(
  config: StrategyConfig,
  snapshot: LiveStrategySnapshot,
  prior: LiveStrategyRiskState,
  now: number,
): { quotes: LiveStrategyQuote[]; risk: string[]; state: LiveStrategyRiskState; equity: string; inventory: string } {
  const risk: string[] = []
  const market = snapshot.market
  const equity = value(snapshot.equity),
    inventory = value(snapshot.inventory)
  const capital = value(config.capital)
  const dayKey = new Date(now).toISOString().slice(0, 10)
  const state = {
    ...prior,
    dayKey,
    dayStartEquity: dayKey === prior.dayKey ? prior.dayStartEquity : equity.toFixed(),
    peakEquity: Exact.max(value(prior.peakEquity), equity).toFixed(),
    lastBlock: snapshot.chainBlock,
    lastRequestId: snapshot.account.lastRequestId,
  }
  const finish = (quotes: LiveStrategyQuote[] = []) => ({
    quotes,
    risk,
    state,
    equity: equity.toFixed(),
    inventory: inventory.toFixed(),
  })
  const fresh = (at: number) =>
    Number.isSafeInteger(at) && at > 0 && at <= now && now - at <= Math.min(config.maxDataAgeMs, 5000)
  if (
    config.mode !== 'LIVE' ||
    config.liveConfirmed !== true ||
    snapshot.accountId !== config.accountId ||
    snapshot.marketId !== config.marketId ||
    market.accountId !== config.accountId ||
    market.marketId !== config.marketId ||
    snapshot.environment !== market.environment ||
    !snapshot.epoch ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 0 ||
    !fresh(snapshot.observedAt) ||
    !fresh(market.marketObservedAt) ||
    !fresh(market.headObservedAt) ||
    !fresh(market.balanceObservedAt) ||
    !Number.isSafeInteger(snapshot.chainBlock) ||
    snapshot.chainBlock < prior.lastBlock ||
    snapshot.chainBlock > snapshot.headBlock ||
    snapshot.headBlock - snapshot.chainBlock > 3 ||
    !/^0x[0-9a-f]{64}$/i.test(snapshot.chainHash) ||
    !snapshot.chainFinalized
  ) {
    risk.push('STALE_DATA')
    return finish()
  }
  if (!market.marketOpen) risk.push('MARKET_CLOSED')
  if (snapshot.depositTotal !== prior.depositTotal || snapshot.withdrawalTotal !== prior.withdrawalTotal)
    risk.push('ACCOUNT_CAPITAL_CHANGED')
  if (value(state.dayStartEquity).minus(equity).gte(value(config.maxDailyLoss))) risk.push('DAILY_LOSS')
  if (
    value(state.peakEquity)
      .minus(equity)
      .mul(100)
      .gte(capital.mul(value(config.maxDrawdownPct)))
  )
    risk.push('DRAWDOWN')
  if (value(prior.baselineEquity).minus(equity).gte(value(config.maxDailyLoss))) risk.push('RUN_LOSS')
  if (value(snapshot.volatility).gt(value(config.maxVolatility))) risk.push('VOLATILITY')
  if (value(snapshot.fundingRate).abs().gt(value(config.maxFundingRate))) risk.push('FUNDING')
  if (inventory.abs().gt(value(config.maxInventory))) risk.push('INVENTORY')
  const priceScale = new Exact(10).pow(market.priceDecimals)
  const sizeScale = new Exact(10).pow(market.sizeDecimals)
  const bid = value(market.bidRaw).div(priceScale),
    ask = value(market.askRaw).div(priceScale)
  const mark = value(market.markRaw).div(priceScale),
    oracle = value(snapshot.oracleRaw).div(priceScale)
  if (!oracle.gt(0) || !bid.gt(0) || !ask.gt(bid) || !mark.gt(0)) risk.push('PRICE_BAND')
  else if (
    [bid, ask, mark].some((price) =>
      price
        .minus(oracle)
        .abs()
        .mul(10000)
        .gt(oracle.mul(value(config.maxPriceBandBps))),
    )
  )
    risk.push('PRICE_BAND')
  if (inventory.abs().mul(mark).gt(value(config.maxNotional))) risk.push('NOTIONAL')
  const leverage = value(config.leverage)
  if (leverage.mul(100).gt(new Exact(1_000_000).div(market.initialMarginBps)) || !leverage.mul(100).isInteger())
    risk.push('LEVERAGE')
  if (risk.length) return finish()
  const desired: Array<{ side: 'BUY' | 'SELL'; price: Decimal }> = []
  if (config.kind === 'GRID') {
    const grid = config.grid!
    for (let index = 0; index < grid.levels; index++) {
      const price = value(grid.lower).plus(
        value(grid.upper)
          .minus(value(grid.lower))
          .mul(index)
          .div(grid.levels - 1),
      )
      if (price.lte(bid)) desired.push({ side: 'BUY', price })
      else if (price.gte(ask)) desired.push({ side: 'SELL', price })
    }
    desired.sort((a, b) => a.price.minus(mark).abs().cmp(b.price.minus(mark).abs()))
  } else {
    const maker = config.maker!
    const spread = value(maker.baseSpreadBps)
      .plus(value(snapshot.volatility).mul(value(maker.volatilitySpreadMultiplier)))
      .div(10000)
    const mid = bid.plus(ask).div(2)
    const skew = mid.mul(inventory).div(value(config.maxInventory)).mul(value(maker.inventorySkewBps)).div(10000)
    desired.push({ side: 'BUY', price: Exact.min(bid, mid.mul(new Exact(1).minus(spread)).minus(skew)) })
    desired.push({ side: 'SELL', price: Exact.max(ask, mid.mul(new Exact(1).plus(spread)).minus(skew)) })
  }
  const rawSize = value(config.quoteSize).mul(sizeScale).floor()
  if (!rawSize.gt(0) || rawSize.gt(Number.MAX_SAFE_INTEGER)) {
    risk.push('SIZE_PRECISION')
    return finish()
  }
  const size = rawSize.div(sizeScale)
  let buys = new Exact(0),
    sells = new Exact(0),
    reserved = new Exact(0)
  const quotes: LiveStrategyQuote[] = []
  const loss = Exact.max(0, value(prior.baselineEquity).minus(equity))
  const budget = Exact.min(value(market.freeBalance), capital.minus(value(snapshot.positionCollateral)).minus(loss))
  for (const proposal of desired) {
    if (quotes.length >= config.maxOpenOrders) break
    const rawPrice = proposal.price
      .mul(priceScale)
      .toDecimalPlaces(0, proposal.side === 'BUY' ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL)
    if (!rawPrice.gt(0) || rawPrice.gt(Number.MAX_SAFE_INTEGER)) continue
    const price = rawPrice.div(priceScale),
      notional = price.mul(size)
    if (notional.mul(new Exact(10).pow(market.collateralDecimals)).lt(value(market.minimumNotionalRaw))) continue
    if (
      price
        .minus(oracle)
        .abs()
        .mul(10000)
        .gt(oracle.mul(value(config.maxPriceBandBps)))
    )
      continue
    const nextBuys = proposal.side === 'BUY' ? buys.plus(size) : buys
    const nextSells = proposal.side === 'SELL' ? sells.plus(size) : sells
    const extreme = Exact.max(inventory.plus(nextBuys).abs(), inventory.minus(nextSells).abs())
    if (extreme.gt(value(config.maxInventory)) || extreme.mul(Exact.max(mark, price)).gt(value(config.maxNotional)))
      continue
    const required = notional
      .div(leverage)
      .plus(notional.mul(market.takerFeeMicros).div(1_000_000))
      .plus(value(market.recycleFeeRaw).div(new Exact(10).pow(market.collateralDecimals)))
      .toDecimalPlaces(6, Decimal.ROUND_CEIL)
    if (reserved.plus(required).gt(budget)) continue
    if (quotes.some((quote) => quote.side === proposal.side && quote.priceRaw === rawPrice.toNumber())) continue
    quotes.push({
      side: proposal.side,
      priceRaw: rawPrice.toNumber(),
      sizeRaw: rawSize.toNumber(),
      price: price.toFixed(),
      size: size.toFixed(),
      required: required.toFixed(6),
    })
    buys = nextBuys
    sells = nextSells
    reserved = reserved.plus(required)
  }
  if (!quotes.length) risk.push('NO_ADMISSIBLE_QUOTES')
  return finish(quotes)
}
