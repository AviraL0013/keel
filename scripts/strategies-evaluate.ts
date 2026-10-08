import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { evaluateRecordedStrategies } from '../packages/strategies/src/evaluation.js'
import type { PerplBacktestFixture } from '../packages/strategies/src/backtest.js'
import type { StrategyConfig } from '../packages/strategies/src/index.js'

const path = process.argv[2] ?? 'packages/strategies/fixtures/perpl-mainnet-btc-2026-09-08-10-08.json'
const raw = await readFile(path)
const fixture = JSON.parse(raw.toString()) as PerplBacktestFixture
const configs = await Promise.all(
  ['grid', 'maker'].map(
    async (kind) =>
      JSON.parse(await readFile(`packages/strategies/fixtures/btc-${kind}-config.json`, 'utf8')) as StrategyConfig,
  ),
)
const result = evaluateRecordedStrategies(configs, fixture)
await mkdir('reports/strategies', { recursive: true })
await writeFile(
  'reports/strategies/sensitivity.json',
  `${JSON.stringify({ fixtureSha256: createHash('sha256').update(raw).digest('hex'), ...result }, null, 2)}\n`,
)
console.log(
  JSON.stringify(
    {
      training: result.training,
      holdout: result.holdout,
      selectedWinner: result.selectedWinner,
      results: result.results.map((row) => ({
        parameter: row.parameter,
        window: row.window,
        stress: row.stress,
        ...row.report.metrics,
      })),
    },
    null,
    2,
  ),
)
