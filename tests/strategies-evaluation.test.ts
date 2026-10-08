import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { evaluateRecordedStrategies } from '../packages/strategies/src/evaluation.js'
import type { PerplBacktestFixture } from '../packages/strategies/src/backtest.js'
import type { StrategyConfig } from '../packages/strategies/src/index.js'

const fixture = JSON.parse(
  readFileSync('packages/strategies/fixtures/perpl-mainnet-btc-2026-09-08-10-08.json', 'utf8'),
) as PerplBacktestFixture
const configs = ['grid', 'maker'].map(
  (kind) => JSON.parse(readFileSync(`packages/strategies/fixtures/btc-${kind}-config.json`, 'utf8')) as StrategyConfig,
)

it('evaluates a recorded 30-day window with disjoint holdout, fixed parameter choices and stress', () => {
  const result = evaluateRecordedStrategies(configs, fixture)
  expect(result.training.candles).toBe(360)
  expect(result.holdout.candles).toBe(360)
  expect(result.training.to).toBe(result.holdout.from)
  expect(result.selectedWinner).toBeNull()
  expect(result.results).toHaveLength(24)
  expect(new Set(result.results.map((row) => row.parameter))).toEqual(
    new Set([
      'grid.levels=4',
      'grid.levels=8',
      'grid.levels=12',
      'maker.baseSpreadBps=10',
      'maker.baseSpreadBps=20',
      'maker.baseSpreadBps=40',
    ]),
  )
  for (const row of result.results) {
    expect(row.report.candles).toBe(360)
    expect(row.report.assumptions).toContain('hypothetical')
    expect(row.report.metrics.executionStressCost).toBeGreaterThanOrEqual(0)
    expect(row.profitabilityProven).toBe(false)
  }
})
it('refuses an undersized evaluation window or a LIVE configuration', () => {
  expect(() => evaluateRecordedStrategies(configs, { ...fixture, candles: fixture.candles.slice(0, 25) })).toThrow(
    'STRATEGY_EVALUATION_WINDOW_TOO_SHORT',
  )
  expect(() => evaluateRecordedStrategies([{ ...configs[0], mode: 'LIVE' }], fixture)).toThrow(
    'STRATEGY_EVALUATION_BACKTEST_ONLY',
  )
})
it('normalizes the full timeline before partitioning and rejects a gap at the split', () => {
  const normal = evaluateRecordedStrategies(configs, fixture)
  const reversed = evaluateRecordedStrategies(configs, { ...fixture, candles: [...fixture.candles].reverse() })
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  expect(digest(reversed)).toBe(digest(normal))
  const gap = structuredClone(fixture)
  gap.candles.splice(360, 1)
  expect(() => evaluateRecordedStrategies(configs, gap)).toThrow('STRATEGY_BACKTEST_CANDLE_GAP')
})
it('assigns exact split funding to the ending window before resetting holdout inventory', () => {
  const data: PerplBacktestFixture = {
    ...fixture,
    priceDecimals: 0,
    sizeDecimals: 3,
    baseMakerFeeMicros: 0,
    funding: [{ at: { b: 12, t: 168 * 3600000 }, feb: 12, rate: 10000, idx: 100, ppl: 3, sum: 3, div: 1 }],
    candles: Array.from({ length: 336 }, (_, index) => ({
      t: index * 3600000,
      o: 100,
      c: 100,
      l: 98,
      h: 100,
      v: '100000000000',
      n: 100,
    })),
  }
  const setup = {
    ...configs[0],
    quoteSize: 0.1,
    maxInventory: 1,
    maxNotional: 1000,
    grid: { lower: 99, upper: 101, levels: 4 },
  }
  const result = evaluateRecordedStrategies([setup], data)
  const training = result.results.find(
    (row) => row.parameter === 'grid.levels=4' && row.window === 'training' && row.stress === 'moderate',
  )!
  expect(training.report.appliedFundingEvents).toBe(1)
  expect(training.report.metrics.fundingPaid).toBeGreaterThan(0)
  expect(
    result.results.filter((row) => row.window === 'holdout').every((row) => row.report.appliedFundingEvents === 0),
  ).toBe(true)
})
