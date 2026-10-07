import { describe, expect, it } from 'vitest'
import {
  createStrategy,
  initialState,
  strategyEquity,
  validateStrategyConfig,
} from '../packages/strategies/src/index.js'
import type { StrategyConfig, StrategyTick } from '../packages/strategies/src/index.js'

const config: StrategyConfig = {
  kind: 'GRID',
  mode: 'PAPER',
  marketId: 16,
  accountId: 642,
  capital: 1000,
  quoteSize: 0.1,
  maxNotional: 500,
  maxInventory: 0.3,
  maxOpenOrders: 4,
  maxDailyLoss: 50,
  maxDrawdownPct: 5,
  maxVolatility: 0.08,
  maxDataAgeMs: 2000,
  maxPriceBandBps: 100,
  maxFundingRate: 0.001,
  leverage: 2,
  grid: { lower: 98, upper: 102, levels: 5 },
}
const tick: StrategyTick = { at: 1000, bid: 99, ask: 101, mark: 100, oracle: 100, volatility: 0.01, fundingRate: 0 }

describe('deterministic strategy and risk', () => {
  it('rejects invalid and unbounded configuration', () => {
    expect(() => validateStrategyConfig({ ...config, maxOpenOrders: 0 })).toThrow('STRATEGY_CONFIG_INVALID')
    expect(() => validateStrategyConfig({ ...config, grid: { lower: 110, upper: 90, levels: 5 } })).toThrow()
    expect(() => validateStrategyConfig({ ...config, mode: 'LIVE', liveConfirmed: true })).toThrow(
      'STRATEGIES_LIVE_DISABLED',
    )
  })
  it('posts bounded grid rungs within post-only touch and inventory cap', () => {
    const strategy = createStrategy(config)
    const result = strategy.onTick(initialState(config), tick, 1000)
    expect(result.risk).toEqual([])
    expect(result.quotes.length).toBeLessThanOrEqual(4)
    expect(result.quotes.length).toBeGreaterThan(0)
    expect(result.quotes.every((q) => q.price >= 98 && q.price <= 102)).toBe(true)
    expect(result.quotes.every((q) => q.price >= 99 && q.price <= 101)).toBe(true)
    expect(result.quotes.every((q) => (q.side === 'BUY' ? q.price <= tick.bid : q.price >= tick.ask))).toBe(true)
    expect(result.quotes.reduce((sum, q) => sum + (q.side === 'BUY' ? q.size : 0), 0)).toBeLessThanOrEqual(0.3)
  })
  it('accounts for fees and funding and stops on daily loss', () => {
    const strategy = createStrategy(config)
    let state = initialState(config)
    state = strategy.onFill(state, { at: 1000, side: 'BUY', price: 100, size: 0.1, fee: 2 })
    state = strategy.onFunding(state, { at: 1000, amount: 5 })
    expect(strategyEquity(state, 100)).toBe(993)
    state = strategy.onFunding(state, { at: 1000, amount: 50 })
    expect(strategy.onTick(state, tick, 1000).risk).toContain('DAILY_LOSS')
  })
  it('halts when equity falls below the configured peak drawdown', () => {
    const strategy = createStrategy({ ...config, maxDrawdownPct: 0.5 })
    const state = strategy.onFunding(initialState(config), { at: 1000, amount: 10 })
    expect(strategy.onTick(state, tick, 1000).risk).toContain('DRAWDOWN')
  })
  it('halts stale, volatile, out-of-band and adverse-funding ticks', () => {
    const strategy = createStrategy(config)
    const state = initialState(config)
    expect(strategy.onTick(state, tick, 4001).risk).toContain('STALE_DATA')
    expect(strategy.onTick(state, { ...tick, volatility: 0.1 }, 1000).risk).toContain('VOLATILITY')
    expect(strategy.onTick(state, { ...tick, oracle: 90 }, 1000).risk).toContain('PRICE_BAND')
    expect(strategy.onTick(state, { ...tick, fundingRate: 0.002 }, 1000).risk).toContain('FUNDING')
    expect(
      strategy.onTick(state, { ...tick, sourceTimes: { market: 1000, orderbook: 0, funding: 1000 } }, 3001).risk,
    ).toContain('STALE_DATA')
    expect(strategy.onTick(state, { ...tick, mark: Number.NaN }, 1000).state.peakEquity).toBe(config.capital)
    expect(strategy.onTick({ ...state, inventory: 0.4 }, tick, 1000).risk).toContain('INVENTORY')
  })
  it('skews market maker quotes and rate limits refresh', () => {
    const maker = createStrategy({
      ...config,
      kind: 'MARKET_MAKER',
      grid: undefined,
      maxPriceBandBps: 200,
      maker: { baseSpreadBps: 20, volatilitySpreadMultiplier: 100, inventorySkewBps: 50, refreshMs: 1000 },
    })
    const flat = maker.onTick(initialState({ ...config, kind: 'MARKET_MAKER' }), tick, 1000)
    const long = maker.onTick({ ...flat.state, inventory: 0.2, lastRefreshAt: 0 }, tick, 1000)
    expect(long.quotes[0]?.price).toBeLessThan(flat.quotes[0]!.price)
    expect(maker.onTick(flat.state, tick, 1500).quotes).toEqual([])
  })
})
