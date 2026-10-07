/** Read-only Monad backfill into in-memory PostgreSQL; no production database or writes on-chain. */
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { AnalyticsRepository } from '../server/src/infrastructure/analytics/repository.js'
import { AnalyticsIndexer } from '../server/src/workers/analytics-indexer.js'

const rpcUrl = process.env.EYELER_ANALYTICS_RPC_URL
if (!rpcUrl) throw new Error('EYELER_ANALYTICS_RPC_URL_REQUIRED')
const response = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  signal: AbortSignal.timeout(20_000),
})
if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
const body = (await response.json()) as { result?: string }
if (!body.result) throw new Error('RPC_HEAD_MISSING')
const head = BigInt(body.result)
const startBlock = process.env.EYELER_ANALYTICS_START_BLOCK ? BigInt(process.env.EYELER_ANALYTICS_START_BLOCK) : null
const db = new PGlite()
try {
  await db.exec(await readFile('database/migrations/020_analytics.sql', 'utf8'))
  const query = async (sql: string, values?: unknown[]) => {
    const result = await db.query<Record<string, unknown>>(sql, values)
    return { ...result, rowCount: result.affectedRows ?? result.rows.length }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const repo = new AnalyticsRepository(pool)
  const indexer = new AnalyticsIndexer(repo, {
    databaseUrl: ':memory:',
    rpcUrl,
    perplApiUrl: 'https://app.perpl.xyz/api',
    startBlock,
    historyVerified: false,
    confirmationDepth: 12n,
    chunkSize: 20n,
    pollMs: 3000,
  })
  let indexed = 0
  for (let i = 0; i < 3; i++) if ((await indexer.step()) === 'indexed') indexed++
  const [raw, fills, flows, liqs, checkpoint] = await Promise.all([
    query('SELECT count(*) AS count FROM analytics_raw_events'),
    query('SELECT count(*) AS count,coalesce(sum(notional_micros),0) AS volume_micros FROM analytics_fills'),
    query('SELECT count(*) AS count FROM analytics_flows'),
    query('SELECT count(*) AS count FROM analytics_liquidations'),
    repo.checkpoint(),
  ])
  console.log(
    JSON.stringify({
      chainId: 143,
      recentStartBlock: checkpoint?.startBlock.toString(),
      head: head.toString(),
      chunksIndexed: indexed,
      nextBlock: checkpoint?.nextBlock.toString(),
      rawEvents: raw.rows[0].count,
      makerFills: fills.rows[0].count,
      makerVolumeMicros: fills.rows[0].volume_micros,
      flows: flows.rows[0].count,
      liquidations: liqs.rows[0].count,
    }),
  )
} finally {
  await db.close()
}
