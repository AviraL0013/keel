import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import {
  AnalyticsSnapshotRepository,
  PublicSnapshotSource,
  type SnapshotObservation,
} from '../server/src/infrastructure/analytics/snapshots.js'
import { AnalyticsSnapshotWorker } from '../server/src/workers/analytics-snapshots.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'
import type { PerplPublicAnalytics } from '../server/src/infrastructure/analytics/perpl-public.js'

const hour = 3_600_000
const now = Date.parse('2026-10-11T13:35:00.000Z')

describe('hourly protocol snapshots', () => {
  it('reads exact Exchange AUSD at a finalized Monad block and refuses wrong chain or token precision', async () => {
    let chainId = 143
    let decimals = 6
    const block = { number: 123n, timestamp: BigInt(Math.floor(now / 1000)) }
    const chain = {
      getChainId: async () => chainId,
      getBlock: async () => block,
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 1_234_567n : functionName === 'decimals' ? decimals : 'AUSD',
    }
    const source = new PublicSnapshotSource(
      {
        context: async () => {
          throw Error('NOT_USED')
        },
      } as never,
      chain as never,
      () => now,
    )
    expect(await source.read('tvl')).toEqual({
      metric: 'tvl',
      micros: 1_234_567n,
      observedAt: new Date(Math.floor(now / 1000) * 1000),
      block: 123,
    })
    chainId = 1
    await expect(source.read('tvl')).rejects.toThrow('MONAD_CHAIN_MISMATCH')
    chainId = 143
    decimals = 18
    await expect(source.read('tvl')).rejects.toThrow('ANALYTICS_TVL_SNAPSHOT_UNVERIFIED')
  })

  it('samples OI and Exchange AUSD separately, retries a failed metric, and never duplicates a completed hour', async () => {
    let clock = now
    let failTvl = true
    const calls: string[] = []
    const saved: SnapshotObservation[] = []
    const source = {
      read: async (metric: 'oi' | 'tvl') => {
        calls.push(metric)
        if (metric === 'tvl' && failTvl) throw Error('RPC_UNAVAILABLE')
        return { metric, micros: metric === 'oi' ? 1_500_000n : 2_500_000n, observedAt: new Date(clock), block: 123 }
      },
    }
    const worker = new AnalyticsSnapshotWorker(source, { save: async (value) => void saved.push(value) }, () => clock)
    expect(await worker.step()).toEqual({ oi: 'saved', tvl: 'failed' })
    failTvl = false
    expect(await worker.step()).toEqual({ oi: 'skipped', tvl: 'saved' })
    expect(await worker.step()).toEqual({ oi: 'skipped', tvl: 'skipped' })
    clock += hour
    expect(await worker.step()).toEqual({ oi: 'saved', tvl: 'saved' })
    expect(calls).toEqual(['oi', 'tvl', 'tvl', 'oi', 'tvl'])
    expect(saved).toHaveLength(4)
  })

  it('migration reruns and stores exact hourly OI/TVL without summing stock values', async () => {
    const db = new PGlite()
    try {
      const migration = await readFile('database/migrations/036_analytics_snapshots.sql', 'utf8')
      await db.exec(migration)
      await db.exec(migration)
      const query = async (sql: string, values?: unknown[]) => db.query<Record<string, unknown>>(sql, values)
      const repo = new AnalyticsSnapshotRepository({ query } as unknown as pg.Pool)
      await repo.save({ metric: 'oi', micros: 1_000_001n, observedAt: new Date(now), block: 123 })
      await repo.save({ metric: 'oi', micros: 1_000_002n, observedAt: new Date(now + 1000), block: 124 })
      await repo.save({ metric: 'tvl', micros: 2_000_003n, observedAt: new Date(now), block: 123 })
      const from = new Date(Math.floor(now / hour) * hour)
      const to = new Date(from.getTime() + 2 * hour)
      const oi = await repo.series('oi', '1h', from, to)
      const tvl = await repo.series('tvl', '1h', from, to)
      expect(oi.points.map((point) => point.value)).toEqual(['1.000002', null])
      expect(tvl.points.map((point) => point.value)).toEqual(['2.000003', null])
      expect(await repo.latest('tvl')).toEqual({ micros: 2_000_003n, observedAt: new Date(now), block: 123 })
      expect(oi.historyStartedAt).toBe(new Date(now + 1000).toISOString())
      expect(tvl.historyStartedAt).toBe(new Date(now).toISOString())
    } finally {
      await db.close()
    }
  }, 30_000)

  it('serves recorded OI with honest start and gaps through the existing route', async () => {
    const db = new PGlite()
    const prior = process.env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED
    process.env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED = 'true'
    const app = Fastify()
    try {
      await db.exec(await readFile('database/migrations/036_analytics_snapshots.sql', 'utf8'))
      const query = async (sql: string, values?: unknown[]) => db.query<Record<string, unknown>>(sql, values)
      const pool = { query } as unknown as pg.Pool
      const repo = new AnalyticsSnapshotRepository(pool)
      const bucket = Math.floor(Date.now() / hour) * hour
      const observedAt = new Date(bucket + 1000)
      await repo.save({ metric: 'oi', micros: 1_230_000n, observedAt, block: 123 })
      registerAnalyticsRoutes(app, pool)
      const from = new Date(bucket - hour).toISOString()
      const to = new Date().toISOString()
      const response = await app.inject(`/analytics/v1/protocol/timeseries?metric=oi&interval=1h&from=${from}&to=${to}`)
      expect(response.statusCode).toBe(200)
      expect(response.json().data.points.map((point: { value: string | null }) => point.value)).toEqual([
        null,
        '1.230000',
      ])
      expect(response.json().data.historyStartedAt).toBe(observedAt.toISOString())
      expect(response.json().source).toBe('perpl_api')
    } finally {
      await app.close()
      await db.close()
      if (prior === undefined) delete process.env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED
      else process.env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED = prior
    }
  }, 30_000)

  it('uses the finalized Exchange balance for summary TVL when snapshots are enabled', async () => {
    const prior = process.env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED
    process.env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED = 'true'
    const fixture = JSON.parse(await readFile('packages/analytics/fixtures/mainnet-public.json', 'utf8'))
    const app = Fastify()
    try {
      const pool = {
        query: async (sql: string) => ({
          rows: sql.includes('analytics_protocol_snapshots')
            ? [{ value_micros: '2000003', observed_at: new Date(), block_number: '123' }]
            : [],
        }),
      } as unknown as pg.Pool
      registerAnalyticsRoutes(app, pool, {
        publicData: {
          context: async () => ({ value: fixture.context, asOf: new Date().toISOString(), block: 123, stale: false }),
        } as PerplPublicAnalytics,
      })
      const response = await app.inject('/analytics/v1/protocol/summary?window=24h')
      expect(response.statusCode).toBe(200)
      expect(response.json().data.tvl.value).toBe('2.000003')
      expect(response.json().data.tvl.note).toContain('AUSD balance of Perpl Exchange')
    } finally {
      await app.close()
      if (prior === undefined) delete process.env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED
      else process.env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED = prior
    }
  })
})
