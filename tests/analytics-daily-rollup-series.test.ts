import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { readDailyRollupSeries } from '../server/src/infrastructure/analytics/daily-rollup-series.js'

it('returns daily revenue and liquidation totals only where block coverage proves whole days', async () => {
  const db = new PGlite()
  try {
    const migration = await readFile('database/migrations/021_analytics_rollups.sql', 'utf8')
    await db.exec(migration)
    await db.exec(migration)
    const from = new Date('2026-10-08T00:00:00.000Z')
    const to = new Date('2026-10-10T00:00:00.000Z')
    await db.query(
      `INSERT INTO analytics_rollup_coverage
      (from_block,to_block,from_time,through_time,end_hash,log_count)
      VALUES(54773010,54773020,'2026-10-07T23:59:00Z','2026-10-09T00:00:01Z',$1,2)`,
      [`0x${'a'.repeat(64)}`],
    )
    await db.query(
      `INSERT INTO analytics_rollup_bucket
      (from_block,to_block,grain,bucket_start,market_id,fees_micros,revenue_micros,liquidation_notional_micros)
      VALUES(54773010,54773020,'day',$1,-1,3000003,1000001,2000002)`,
      [from],
    )
    await db.query(
      `INSERT INTO analytics_rollup_actor(from_block,to_block,grain,bucket_start,account_id,owner_address)
       VALUES(54773010,54773020,'day',$1,5438,'0x1234567890abcdef1234567890abcdef12345678')`,
      [from],
    )
    const query = async (sql: string, values?: unknown[]) => db.query<Record<string, unknown>>(sql, values)
    const pool = { connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool
    const revenue = await readDailyRollupSeries(pool, 'revenue', from, to)
    const liquidations = await readDailyRollupSeries(pool, 'liquidation_notional', from, to)
    const fees = await readDailyRollupSeries(pool, 'fees', from, to)
    const users = await readDailyRollupSeries(pool, 'active_users', from, to)
    expect(revenue.points.map((point) => point.value)).toEqual(['1.000001', null])
    expect(liquidations.points.map((point) => point.value)).toEqual(['2.000002', null])
    expect(fees.points.map((point) => point.value)).toEqual(['3.000003', null])
    expect(users.points.map((point) => point.value)).toEqual(['1', null])
    expect(revenue.completeDays).toBe(1)
    expect(revenue.block).toBe(54773019)
  } finally {
    await db.close()
  }
}, 30_000)

it('keeps a fully covered daily user count unavailable when any account owner is unproved', async () => {
  const db = new PGlite()
  try {
    await db.exec(await readFile('database/migrations/021_analytics_rollups.sql', 'utf8'))
    const from = new Date('2026-10-08T00:00:00.000Z')
    const to = new Date('2026-10-10T00:00:00.000Z')
    await db.query(
      `INSERT INTO analytics_rollup_coverage
       (from_block,to_block,from_time,through_time,end_hash,log_count)
       VALUES(54773010,54773020,$1,$2,$3,1)`,
      [from, to, `0x${'b'.repeat(64)}`],
    )
    await db.query(
      `INSERT INTO analytics_rollup_actor(from_block,to_block,grain,bucket_start,account_id,owner_address)
       VALUES(54773010,54773020,'day',$1,5438,NULL)`,
      [from],
    )
    const query = async (sql: string, values?: unknown[]) => db.query<Record<string, unknown>>(sql, values)
    const pool = { connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool
    const users = await readDailyRollupSeries(pool, 'active_users', from, to)
    expect(users.points.map((point) => point.value)).toEqual([null, '0'])
    expect(users.completeDays).toBe(2)
  } finally {
    await db.close()
  }
}, 30_000)
