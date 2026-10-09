import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { runBacktest, type PerplBacktestFixture } from './backtest.js'
import type { StrategyConfig } from './index.js'

const [configName, fixtureName] = process.argv.slice(2)
if (!configName || !fixtureName)
  throw new Error('USAGE: tsx packages/strategies/src/backtest-cli.ts <config.json> <fixture.json>')
const config = JSON.parse(await readFile(resolve(configName), 'utf8')) as StrategyConfig
const fixture = JSON.parse(await readFile(resolve(fixtureName), 'utf8')) as PerplBacktestFixture
const report = runBacktest(config, fixture)
const output = resolve('reports/strategies', `${basename(configName, '.json')}-${report.from}-${report.to}.json`)
await mkdir(resolve('reports/strategies'), { recursive: true })
await writeFile(output, JSON.stringify({ config, report }, null, 2) + '\n', 'utf8')
console.log(
  JSON.stringify({
    output,
    metrics: report.metrics,
    candles: report.candles,
    fundingEvents: report.fundingEvents,
    appliedFundingEvents: report.appliedFundingEvents,
  }),
)
