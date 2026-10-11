import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { PerplPublicAnalytics } from '../server/src/infrastructure/analytics/perpl-public.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'
import { databaseFixture } from './helpers/database.js'

const context = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')).context

it('serves complete 30-day rollup fees, users and flow buckets without claiming all-time coverage', async () => {
  const previous = process.env.EYELER_ANALYTICS_ROLLUPS_ENABLED
  process.env.EYELER_ANALYTICS_ROLLUPS_ENABLED = 'true'
  const db = await databaseFixture()
  const app = Fastify()
  try {
    const day = 86_400_000
    const to = Math.floor(Date.now() / day) * day
    const hour = 3_600_000
    const hourEnd = Math.floor(Date.now() / hour) * hour
    const from = to - 30 * day
    await db.store.pool.query(
      `INSERT INTO analytics_rollup_coverage(from_block,to_block,from_time,through_time,end_hash,log_count)
       VALUES(54773010,54773110,$1,$2,$3,1)`,
      [new Date(from), new Date(hourEnd), `0x${'a'.repeat(64)}`],
    )
    await db.store.pool.query(
      `INSERT INTO analytics_rollup_bucket(from_block,to_block,grain,bucket_start,market_id,fees_micros,
        revenue_micros,deposits_micros,withdrawals_micros,liquidation_count,liquidation_notional_micros,
        long_opens,short_opens) VALUES(54773010,54773110,'day',$1,-1,123456,50000,2000000,1000000,1,500000,1,0)`,
      [new Date(to - day)],
    )
    await db.store.pool.query(
      `INSERT INTO analytics_rollup_actor(from_block,to_block,grain,bucket_start,account_id,owner_address)
       VALUES(54773010,54773110,'day',$1,5438,$2)`,
      [new Date(to - day), '0x1234567890abcdef1234567890abcdef12345678'],
    )
    await db.store.pool.query(
      `INSERT INTO analytics_rollup_bucket(from_block,to_block,grain,bucket_start,market_id,fees_micros,
        revenue_micros,deposits_micros,withdrawals_micros,liquidation_count,liquidation_notional_micros,
        long_opens,short_opens) VALUES(54773010,54773110,'hour',$1,-1,654321,25000,500000,250000,1,500000,1,0)`,
      [new Date(hourEnd - hour)],
    )
    await db.store.pool.query(
      `INSERT INTO analytics_rollup_actor(from_block,to_block,grain,bucket_start,account_id,owner_address)
       VALUES(54773010,54773110,'hour',$1,5438,$2)`,
      [new Date(hourEnd - hour), '0x1234567890abcdef1234567890abcdef12345678'],
    )
    const publicData = new PerplPublicAnalytics('https://fixture.invalid', async () => Response.json(context))
    registerAnalyticsRoutes(app, db.store.pool, { publicData })
    const summary = await app.inject('/analytics/v1/protocol/summary?window=30d')
    expect(summary.statusCode).toBe(200)
    expect(summary.json().data.fees.value).toBe('0.123456')
    expect(summary.json().data.activeUsers.value).toBe('1')
    expect(summary.json().coverage).toMatchObject({ label: 'Last 30 days', completeHistory: false })
    expect(summary.json().data.revenue.history).toMatchObject({
      source: 'monad_exchange',
      data: { interval: '1d', from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    })
    expect(summary.json().data.revenue.history.data.points).toHaveLength(30)
    expect(summary.json().data.revenue.history.data.points.at(-1).value).toBe('0.050000')
    const feesHistory = await app.inject(
      `/analytics/v1/protocol/timeseries?metric=fees&interval=1d&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`,
    )
    expect(feesHistory.statusCode).toBe(200)
    expect(feesHistory.json().data.points.at(-1).value).toBe('0.123456')
    const userHistory = await app.inject(
      `/analytics/v1/protocol/timeseries?metric=active_users&interval=1d&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`,
    )
    expect(userHistory.statusCode).toBe(200)
    expect(userHistory.json().data.points.at(-1).value).toBe('1')
    const liquidations = await app.inject(
      `/analytics/v1/liquidations?from=${new Date(to - day).toISOString()}&to=${new Date(to).toISOString()}&limit=1`,
    )
    expect(liquidations.statusCode).toBe(200)
    expect(liquidations.json().data.dailyNotional).toEqual({
      interval: '1d',
      from: new Date(to - day).toISOString(),
      to: new Date(to).toISOString(),
      points: [{ time: new Date(to - day).toISOString(), value: '0.500000' }],
    })
    const flows = await app.inject('/analytics/v1/protocol/flows?window=30d')
    expect(flows.statusCode).toBe(200)
    expect(flows.json().data.net).toBe('1.000000')
    expect(flows.json().data.buckets).toHaveLength(30)
    expect(flows.json().data.buckets.at(-1).net).toBe('1.000000')
    const week = await app.inject('/analytics/v1/protocol/summary?window=7d')
    expect(week.statusCode).toBe(200)
    expect(week.json().data.fees.value).toBe('0.123456')
    expect(week.json().coverage.label).toBe('Last 7 days')
    const hourly = await app.inject('/analytics/v1/protocol/summary?window=24h')
    expect(hourly.statusCode).toBe(200)
    expect(hourly.json().data.fees.value).toBe('0.654321')
    const hourlyFlows = await app.inject('/analytics/v1/protocol/flows?window=24h')
    expect(hourlyFlows.statusCode).toBe(200)
    expect(hourlyFlows.json().data.net).toBe('0.250000')
    expect(hourlyFlows.json().data.buckets).toHaveLength(24)
  } finally {
    await app.close()
    await db.db.close()
    if (previous === undefined) delete process.env.EYELER_ANALYTICS_ROLLUPS_ENABLED
    else process.env.EYELER_ANALYTICS_ROLLUPS_ENABLED = previous
  }
}, 30_000)
