import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
import { buildStrategyRunReport } from './report.js'

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const from = option('from'),
  to = option('to'),
  strategy = option('strategy')
if (!from || !to)
  throw new Error(
    'USAGE: tsx server/src/infrastructure/strategies/report-cli.ts --from <ISO> --to <ISO> [--strategy <uuid>]',
  )
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const report = await buildStrategyRunReport(pool, from, to, strategy)
  const name = `run-${Date.parse(from)}-${Date.parse(to)}${strategy ? `-${strategy}` : ''}.json`
  const path = resolve('reports/strategies', name)
  await mkdir(resolve('reports/strategies'), { recursive: true })
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(
    JSON.stringify({
      path,
      strategies: report.strategies.length,
      realFills: report.strategies.reduce((sum, item) => sum + item.fills.filter((fill) => !fill.simulated).length, 0),
    }),
  )
} finally {
  await pool.end()
}
