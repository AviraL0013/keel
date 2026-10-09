import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chainConfigs } from '../packages/chain/src/index.js'
import { deriveEvent, type MarketPrecision } from '../packages/analytics/src/aggregate.js'
import { decodeExchangeLog, type ChainLog } from '../packages/analytics/src/decoder.js'
import { AnalyticsRepository } from '../server/src/infrastructure/analytics/repository.js'
import { indexerConfig } from '../server/src/workers/analytics-indexer.js'
import { databaseFixture } from './helpers/database.js'

const sample = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-logs.json', 'utf8')) as {
  logs: ChainLog[]
  blocks: Record<string, string>
}
const publicSample = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')) as {
  context: {
    markets: Array<{ id: number; perpetual_id: number; config: { price_decimals: number; size_decimals: number } }>
  }
}
const markets = new Map<number, MarketPrecision>(
  publicSample.context.markets.map((market) => [
    market.perpetual_id,
    {
      marketId: market.id,
      priceDecimals: market.config.price_decimals,
      sizeDecimals: market.config.size_decimals,
    },
  ]),
)

describe('analytics SQL migration and checkpoint', () => {
  it('falls back to public mainnet RPC for recent history and keeps archive starts distinct', () => {
    const recent = indexerConfig({ DATABASE_URL: 'fixture' })
    expect(recent.rpcUrl).toBe(chainConfigs.mainnet.rpcUrl)
    expect(recent.startBlock).toBeNull()
    expect(recent.historyVerified).toBe(false)
    expect(recent.chunkSize).toBe(20n)
    expect(indexerConfig({ DATABASE_URL: 'fixture', EYELER_ANALYTICS_RPC_URL: 'fixture' }).rpcUrl).toBe('fixture')
    const archive = indexerConfig({
      DATABASE_URL: 'fixture',
      EYELER_ANALYTICS_RPC_URL: 'fixture',
      EYELER_ANALYTICS_START_BLOCK: '54773010',
    })
    expect(archive.startBlock).toBe(54773010n)
    expect(archive.historyVerified).toBe(true)
    expect(
      indexerConfig({
        DATABASE_URL: 'fixture',
        EYELER_ANALYTICS_RPC_URL: 'fixture',
        EYELER_ANALYTICS_START_BLOCK: '111000000',
      }).historyVerified,
    ).toBe(false)
  })
  it('re-runs migration and indexes real logs idempotently after rewind', async () => {
    const { db, store } = await databaseFixture()
    try {
      await db.exec(readFileSync('database/migrations/020_analytics.sql', 'utf8'))
      const repo = new AnalyticsRepository(store.pool)
      const recent = await repo.initialize(1000n, false)
      expect(recent.historyVerified).toBe(false)
      expect(recent.nextBlock).toBe(1000n)
      const archive = await repo.initialize(900n, true)
      expect(archive.startBlock).toBe(900n)
      expect(archive.nextBlock).toBe(900n)
      expect(archive.historyVerified).toBe(true)
      await store.pool.query('DELETE FROM analytics_checkpoint')
      const raw = sample.logs.filter((log) => log.blockNumber === sample.logs[0].blockNumber)
      const number = BigInt(raw[0].blockNumber)
      const blocks = [
        {
          number,
          hash: raw[0].blockHash,
          timestamp: new Date(Number(BigInt(sample.blocks[raw[0].blockNumber])) * 1000),
        },
      ]
      const logs = raw.map((item) => {
        const decoded = decodeExchangeLog(item)
        return { raw: item, decoded, derived: decoded ? deriveEvent(decoded, markets) : null }
      })
      await repo.saveChunk(blocks, logs, number, number)
      expect((await repo.checkpoint())?.nextBlock).toBe(number + 1n)
      const first = await store.pool.query('SELECT count(*)::int AS count FROM analytics_raw_events')
      expect(first.rows[0].count).toBe(raw.length)
      await repo.rewind(number)
      expect((await repo.checkpoint())?.nextBlock).toBe(number)
      await repo.saveChunk(blocks, logs, number, number)
      const second = await store.pool.query('SELECT count(*)::int AS count FROM analytics_raw_events')
      expect(second.rows[0].count).toBe(raw.length)
      const earlier = await repo.initialize(number - 100n, true)
      expect(earlier.startBlock).toBe(number - 100n)
      expect(earlier.nextBlock).toBe(number - 100n)
      expect(earlier.lastBlockHash).toBeNull()
      expect((await store.pool.query('SELECT count(*)::int AS count FROM analytics_raw_events')).rows[0].count).toBe(
        raw.length,
      )
    } finally {
      await db.close()
    }
  })
})
