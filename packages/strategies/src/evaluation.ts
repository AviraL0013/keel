import {
  backtestTimeline,
  runBacktest,
  type BacktestReport,
  type BacktestStress,
  type PerplBacktestFixture,
} from './backtest.js'
import type { StrategyConfig } from './index.js'

export type StrategyEvaluation = {
  training: { from: number; to: number; candles: number }
  holdout: { from: number; to: number; candles: number }
  selectedWinner: null
  results: Array<{
    kind: string
    parameter: string
    window: 'training' | 'holdout'
    stress: string
    report: BacktestReport
    profitabilityProven: false
  }>
}
const scenarios: Array<{ name: string; assumptions: BacktestStress }> = [
  {
    name: 'moderate',
    assumptions: { participationBps: 100, queueAheadNotional: 25, penetrationBps: 5, adverseSelectionBps: 5 },
  },
  {
    name: 'severe',
    assumptions: { participationBps: 10, queueAheadNotional: 100, penetrationBps: 20, adverseSelectionBps: 20 },
  },
]

/** Predeclared sensitivity analysis. Neither split is used to select a winning configuration. */
export function evaluateRecordedStrategies(
  configs: StrategyConfig[],
  fixture: PerplBacktestFixture,
): StrategyEvaluation {
  if (fixture.candles.length < 14 * 24) throw Error('STRATEGY_EVALUATION_WINDOW_TOO_SHORT')
  if (!configs.length || configs.some((config) => config.mode !== 'BACKTEST'))
    throw Error('STRATEGY_EVALUATION_BACKTEST_ONLY')
  const timeline = backtestTimeline(fixture)
  const split = Math.floor(timeline.candles.length / 2)
  const subsets = [timeline.candles.slice(0, split), timeline.candles.slice(split)]
  const windows = subsets.map((candles) => ({
    from: candles[0]!.t,
    to: candles.at(-1)!.t + 3_600_000,
    candles: candles.length,
  }))
  const results: StrategyEvaluation['results'] = []
  for (const base of configs) {
    for (const parameter of base.kind === 'GRID' ? [4, 8, 12] : [10, 20, 40]) {
      const config =
        base.kind === 'GRID'
          ? { ...base, grid: { ...base.grid!, levels: parameter } }
          : { ...base, maker: { ...base.maker!, baseSpreadBps: parameter } }
      for (const [index, candles] of subsets.entries()) {
        const window = windows[index]!
        const data = {
          ...fixture,
          candles,
          funding: timeline.funding.filter(
            (event) => (index === 0 ? event.at.t >= window.from : event.at.t > window.from) && event.at.t <= window.to,
          ),
        }
        for (const scenario of scenarios)
          results.push({
            kind: config.kind,
            parameter: base.kind === 'GRID' ? `grid.levels=${parameter}` : `maker.baseSpreadBps=${parameter}`,
            window: index === 0 ? 'training' : 'holdout',
            stress: scenario.name,
            report: runBacktest(config, data, scenario.assumptions),
            profitabilityProven: false,
          })
      }
    }
  }
  return { training: windows[0]!, holdout: windows[1]!, selectedWinner: null, results }
}
