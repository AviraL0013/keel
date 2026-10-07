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
