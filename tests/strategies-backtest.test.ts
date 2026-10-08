import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runBacktest, type PerplBacktestFixture } from '../packages/strategies/src/backtest.js'
import type { StrategyConfig } from '../packages/strategies/src/index.js'

const config: StrategyConfig = {
  kind: 'GRID',
  mode: 'BACKTEST',
  marketId: 1,
  accountId: 1,
  capital: 1000,
  quoteSize: 0.001,
  maxNotional: 1000,
  maxInventory: 0.01,
  maxOpenOrders: 4,
  maxDailyLoss: 100,
  maxDrawdownPct: 10,
  maxVolatility: 0.1,
  maxDataAgeMs: 60_000,
  maxPriceBandBps: 200,
  maxFundingRate: 0.01,
  leverage: 1,
  grid: { lower: 80_000, upper: 95_000, levels: 8 },
}

describe('Perpl strategy backtest', () => {
  it('runs against recorded public candle and funding data with finite metrics', async () => {
    const fixture = JSON.parse(
      await readFile('packages/strategies/fixtures/perpl-mainnet-btc-2026-10-05.json', 'utf8'),
    ) as PerplBacktestFixture
    const report = runBacktest(config, fixture)
    expect(report.candles).toBe(25)
    expect(report.fundingEvents).toBe(33)
    expect(report.metrics.feesPaid).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(report.metrics.pnl)).toBe(true)
    expect(report.metrics.fillRate).toBeGreaterThanOrEqual(0)
    expect(report.metrics.fillRate).toBeLessThanOrEqual(1)
    expect(report.assumptions).toContain('next-candle')
  })
  it('charges observed payment per lot exactly once after a funding timestamp update', () => {
    const fixture: PerplBacktestFixture = {
      source: 'fake recorded-shape fixture',
      retrievedAt: '2026-10-07T00:00:00Z',
      candleUrl: '',
      fundingUrl: '',
      marketId: 1,
      priceDecimals: 0,
      sizeDecimals: 3,
      baseMakerFeeMicros: 0,
      baseTakerFeeMicros: 0,
      candles: [
        { t: 0, o: 100, c: 100, h: 100, l: 100, v: '1000000000', n: 1 },
        { t: 3600000, o: 100, c: 99, h: 100, l: 97, v: '1000000000', n: 1 },
        { t: 7200000, o: 99, c: 99, h: 99, l: 99, v: '1000000000', n: 1 },
      ],
      funding: [
        { at: { b: 12, t: 10799999 }, feb: 12, rate: 10000, idx: 100, ppl: 3, sum: 3, div: 1 },
        { at: { b: 12, t: 10800000 }, feb: 12, rate: 10000, idx: 100, ppl: 3, sum: 3, div: 1 },
      ],
    } as PerplBacktestFixture
    const result = runBacktest(
      { ...config, quoteSize: 0.1, maxInventory: 0.1, grid: { lower: 98, upper: 102, levels: 3 } },
      fixture,
    )
    expect(result.metrics.fundingPaid).toBe(0.3)
    expect(result.fundingEvents).toBe(1)
    expect(result.appliedFundingEvents).toBe(1)
    expect(result.equityCurve[0].at).toBe(3600000)
    expect(result.to).toBe(10800000)
  })
  it('refuses incomplete funding terms, conflicting intervals, gaps and invalid OHLC', async () => {
    const fixture = JSON.parse(
      await readFile('packages/strategies/fixtures/perpl-mainnet-btc-2026-10-05.json', 'utf8'),
    ) as PerplBacktestFixture
    const missing = structuredClone(fixture) as any
    delete missing.funding[0].ppl
    expect(() => runBacktest(config, missing)).toThrow('STRATEGY_BACKTEST_FUNDING_INVALID')
    const conflicting = structuredClone(fixture) as any
    conflicting.funding.push({ ...conflicting.funding[0], ppl: conflicting.funding[0].ppl + 1 })
    expect(() => runBacktest(config, conflicting)).toThrow('STRATEGY_BACKTEST_FUNDING_CONFLICT')
    const unsupported = structuredClone(fixture) as any
    unsupported.funding[0].div = 100
    expect(() => runBacktest(config, unsupported)).toThrow('STRATEGY_BACKTEST_FUNDING_SCALE_UNVERIFIED')
    const gap = structuredClone(fixture)
    gap.candles.splice(4, 1)
    expect(() => runBacktest(config, gap)).toThrow('STRATEGY_BACKTEST_CANDLE_GAP')
    const invalid = structuredClone(fixture)
    invalid.candles[0]!.o = invalid.candles[0]!.h + 1
    expect(() => runBacktest(config, invalid)).toThrow('STRATEGY_BACKTEST_CANDLE_INVALID')
  })
  it('applies explicit queue, participation and adverse-selection stress without claiming real fills', () => {
    const fixture: PerplBacktestFixture = {
      source: 'fake',
      retrievedAt: '2026-10-07T00:00:00Z',
      candleUrl: '',
      fundingUrl: '',
      marketId: 1,
      priceDecimals: 0,
      sizeDecimals: 3,
      baseMakerFeeMicros: 0,
      baseTakerFeeMicros: 0,
      candles: [
        { t: 0, o: 100, c: 100, h: 100, l: 100, v: '1000000000', n: 1 },
        { t: 3600000, o: 100, c: 99, h: 100, l: 97, v: '1000000000', n: 1 },
      ],
      funding: [],
    }
    const setup = { ...config, quoteSize: 0.1, maxInventory: 0.1, grid: { lower: 98, upper: 102, levels: 3 } }
    const options = { participationBps: 100, queueAheadNotional: 5, penetrationBps: 10, adverseSelectionBps: 20 }
    const stressed = runBacktest(setup, fixture, options)
    expect(stressed.metrics.executionStressCost).toBe(0.009996)
    expect(stressed.metrics.feesPaid).toBe(0)
    expect(stressed.assumptions).toContain('hypothetical')
    expect(runBacktest(setup, fixture, { ...options, queueAheadNotional: 10 }).metrics.filledQuoteCount).toBe(0)
    expect(() => runBacktest(setup, fixture, { ...options, participationBps: 101 })).toThrow(
      'STRATEGY_BACKTEST_STRESS_INVALID',
    )
  })
  it('does not give fee-free openings or fills on a mere touch', () => {
    const fixture: PerplBacktestFixture = {
      source: 'test',
      retrievedAt: '2026-10-07T00:00:00Z',
      candleUrl: '',
      fundingUrl: '',
      marketId: 1,
      priceDecimals: 0,
      sizeDecimals: 3,
      baseMakerFeeMicros: 1000,
      baseTakerFeeMicros: 2000,
      candles: [
        { t: 0, o: 100, c: 100, h: 101, l: 99, v: '1000000000', n: 10 },
        { t: 3600000, o: 100, c: 100, h: 101, l: 99, v: '1000000000', n: 10 },
      ],
      funding: [],
    }
    const result = runBacktest(
      {
        ...config,
        quoteSize: 0.1,
        capital: 100,
        maxNotional: 100,
        maxInventory: 0.1,
        grid: { lower: 99, upper: 101, levels: 3 },
      },
      fixture,
    )
    expect(result.metrics.fillRate).toBe(0)
    expect(result.metrics.feesPaid).toBe(0)
  })
})
