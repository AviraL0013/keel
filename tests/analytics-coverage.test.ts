import Fastify from 'fastify'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'
import type { PerplPublicAnalytics, PublicContext } from '../server/src/infrastructure/analytics/perpl-public.js'
import { databaseFixture } from './helpers/database.js'
import { encodeAbiParameters, encodeEventTopics, type AbiEvent } from 'viem'
import { decodeExchangeLog, EXCHANGE } from '../packages/analytics/src/decoder.js'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.js'
import { AnalyticsRepository } from '../server/src/infrastructure/analytics/repository.js'
import type pg from 'pg'

const deploymentBlock = 54773010
const lastBlock = 111000000
const address = '0x1234567890abcdef1234567890abcdef12345678'
const hash = `0x${'a'.repeat(64)}`
const sample = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')) as {
  context: PublicContext
}

describe('analytics evidence coverage', () => {
  let db: Awaited<ReturnType<typeof databaseFixture>>
  let now: number
  beforeAll(async () => {
    db = await databaseFixture()
  })
  afterAll(async () => {
    await db.db.close()
  })
  beforeEach(async () => {
    now = Date.now()
    await db.store.pool.query('TRUNCATE analytics_blocks CASCADE')
    await db.store.pool.query('TRUNCATE analytics_accounts,analytics_checkpoint')
  })

  async function checkpoint(lastTime: number, start = deploymentBlock) {
    await db.store.pool.query(
      'INSERT INTO analytics_blocks(block_number,block_hash,occurred_at) VALUES($1,$2,$3),($4,$2,$5)',
      [start, hash, new Date(now - 60 * 86_400_000), lastBlock, new Date(lastTime)],
    )
    await db.store.pool.query(
      'INSERT INTO analytics_checkpoint(chain_id,start_block,next_block,history_verified) VALUES(143,$1,$2,true)',
      [start, lastBlock + 1],
    )
  }

  async function event(index: number, accountId: number, kind: 'maker' | 'position', mapped = true, ago = 1000) {
    const at = new Date(now - ago)
    await db.store.pool.query(
      `INSERT INTO analytics_raw_events(block_number,transaction_hash,log_index,transaction_index,block_hash,data,topics)
      VALUES($1,$2,$3,0,$2,'0x','[]')`,
      [lastBlock, hash, index],
    )
    if (mapped)
      await db.store.pool.query(
        'INSERT INTO analytics_accounts(account_id,address,created_block) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [accountId, accountId === 1 ? address : `0x${accountId.toString(16).padStart(40, '0')}`, deploymentBlock],
      )
    if (kind === 'maker')
      await db.store.pool.query(
        `INSERT INTO analytics_fills(block_number,transaction_hash,log_index,account_id,market_id,price_raw,size_raw,
      notional_micros,fee_micros,builder_fee_micros,occurred_at) VALUES($1,$2,$3,$4,1,1,1,3000000,100000,0,$5)`,
        [lastBlock, hash, index, accountId, at],
      )
    else
      await db.store.pool.query(
        `INSERT INTO analytics_position_events(block_number,transaction_hash,log_index,account_id,market_id,side,action,
      size_raw,realized_pnl_micros,protocol_fee_micros,occurred_at) VALUES($1,$2,$3,$4,1,'long','close',0,1000000,0,$5)`,
        [lastBlock, hash, index, accountId, at],
      )
  }

  function makeApp(
    candles: Array<Array<{ time: number; micros: bigint }>> = [],
    pool = db.store.pool,
    markets = sample.context.markets,
  ) {
    const context = { ...sample.context, markets }
    const publicData = {
      context: async () => ({ value: context, asOf: new Date(now).toISOString(), block: lastBlock, stale: false }),
      volumeCandles: async (market: { id: number }) =>
        candles[context.markets.findIndex((m) => m.id === market.id)] ?? [],
    } as unknown as PerplPublicAnalytics
    const app = Fastify()
    registerAnalyticsRoutes(app, pool, { publicData })
    return app
  }

  async function request(path: string, candles: Array<Array<{ time: number; micros: bigint }>> = []) {
    const app = makeApp(candles)
    try {
      const response = await app.inject(path)
      expect(response.statusCode, response.body).toBe(200)
      return response.json()
    } finally {
      await app.close()
    }
  }

  async function episode() {
    await event(1, 1, 'position', true, 2000)
    await db.store.pool.query(
      "UPDATE analytics_position_events SET action='open',size_raw=100,realized_pnl_micros=NULL WHERE log_index=1",
    )
    await event(2, 1, 'position')
  }

  async function unsupported(
    name: string,
    index: number,
    accountId = 1,
    perpetualId = sample.context.markets[0].perpetual_id,
  ) {
    const definition = exchangeEvents.find((entry) => entry.name === name) as AbiEvent
    const values = definition.inputs.map((input) =>
      input.type === 'bool'
        ? false
        : input.name === 'perpId'
          ? BigInt(perpetualId)
          : input.name === 'accountId'
            ? BigInt(accountId)
            : input.name === 'deltaPnlCNS'
              ? -2_000_000n
              : 0n,
    )
    const data = encodeAbiParameters(definition.inputs, values)
    const topics = encodeEventTopics({ abi: [definition], eventName: name })
    const decoded = decodeExchangeLog({
      address: EXCHANGE,
      blockNumber: `0x${lastBlock.toString(16)}`,
      blockHash: hash,
      transactionHash: hash,
      transactionIndex: '0x0',
      logIndex: `0x${index.toString(16)}`,
      data,
      topics: topics as `0x${string}`[],
    })!
    await db.store.pool.query(
      `INSERT INTO analytics_raw_events(block_number,transaction_hash,log_index,transaction_index,block_hash,event_name,args,data,topics)
      VALUES($1,$2,$3,0,$2,$4,$5,$6,$7)`,
      [lastBlock, hash, index, name, JSON.stringify(decoded.args), data, JSON.stringify(topics)],
    )
  }

  it('does not turn a recent checkpoint write into fresh complete history', async () => {
    const lastTime = now - 2 * 86_400_000
    await checkpoint(lastTime)
    const body = await request('/analytics/v1/protocol/flows?window=24h')
    expect(body.asOf).toBe(new Date(lastTime).toISOString())
    expect(body.stale).toBe(true)
    expect(body.coverage.completeHistory).toBe(false)
    expect(body.data.net).toBeNull()
  })

  it('never labels a configured recent start as all-time history', async () => {
    await checkpoint(now, deploymentBlock + 100)
    const body = await request('/analytics/v1/protocol/summary?window=all')
    expect(body.coverage.completeHistory).toBe(false)
    expect(body.coverage.label).not.toBe('All time')
  })

  it('keeps incomplete wallet performance unavailable even when a close is indexed', async () => {
    await checkpoint(now, deploymentBlock + 100)
    await event(1, 1, 'position')
    const body = await request(`/analytics/v1/wallets/${address}/performance`)
    expect(body.data.realizedPnl).toBeNull()
    expect(body.data.closedTrades).toBe(0)
  })

  it('does not publish zero PnL when a position owner remains unresolved', async () => {
    await checkpoint(now)
    await event(1, 1, 'position', false)
    const body = await request(`/analytics/v1/wallets/${address}/performance`)
    expect(body.data.realizedPnl).toBeNull()
    const compare = await request(`/analytics/v1/wallets/compare?addresses=${address}`)
    expect(compare.data.wallets[0].realizedPnl).toBeNull()
  })

  it('does not hide an unmapped second account behind one mapped profitable episode', async () => {
    await checkpoint(now)
    await episode()
    await event(3, 2, 'position', false)
    const body = await request(`/analytics/v1/wallets/${address}/performance`)
    expect(body.data.realizedPnl).toBeNull()
    expect(body.data.closedTrades).toBe(0)
  })

  it('does not infer no wallet trading from an unmapped maker participant', async () => {
    await checkpoint(now)
    await event(1, 1, 'maker', false)
    expect((await request(`/analytics/v1/wallets/${address}/performance`)).data.realizedPnl).toBeNull()
  })

  it('invalidates wallet and compare performance immediately when coverage is lost', async () => {
    await checkpoint(now)
    await episode()
    const app = makeApp()
    try {
      const path = `/analytics/v1/wallets/${address}/performance`
      expect((await app.inject(path)).json().data.realizedPnl).toBe('1.000000')
      expect((await app.inject('/analytics/v1/markets')).json().data.items[0].longOpenInterest).toBe('0.000000')
      await db.store.pool.query('UPDATE analytics_checkpoint SET history_verified=false')
      const next = (await app.inject(path)).json()
      expect(next.coverage.completeHistory).toBe(false)
      expect(next.data.realizedPnl).toBeNull()
      expect((await app.inject('/analytics/v1/markets')).json().data.items[0].longOpenInterest).toBeNull()
      expect(
        (await app.inject(`/analytics/v1/wallets/compare?addresses=${address}`)).json().data.wallets[0].realizedPnl,
      ).toBeNull()
    } finally {
      await app.close()
    }
  })

  it('invalidates cached performance after a same-height block replacement', async () => {
    await checkpoint(now)
    await episode()
    const app = makeApp()
    try {
      const path = `/analytics/v1/wallets/${address}/performance`
      expect((await app.inject(path)).json().data.realizedPnl).toBe('1.000000')
      await db.store.pool.query(
        "UPDATE analytics_position_events SET realized_pnl_micros=-2000000 WHERE action='close'",
      )
      await db.store.pool.query('UPDATE analytics_blocks SET block_hash=$1 WHERE block_number=$2', [
        `0x${'b'.repeat(64)}`,
        lastBlock,
      ])
      expect((await app.inject(path)).json().data.realizedPnl).toBe('-2.000000')
    } finally {
      await app.close()
    }
  })

  it('invalidates cached complete results when deployment coverage evidence disappears', async () => {
    await checkpoint(now)
    await episode()
    const app = makeApp()
    try {
      const path = `/analytics/v1/wallets/${address}/performance`
      expect((await app.inject(path)).json().data.realizedPnl).toBe('1.000000')
      expect((await app.inject('/analytics/v1/markets')).json().data.items[0].longOpenInterest).toBe('0.000000')
      await db.store.pool.query('DELETE FROM analytics_blocks WHERE block_number=$1', [deploymentBlock])
      const next = (await app.inject(path)).json()
      expect(next.coverage.completeHistory).toBe(false)
      expect(next.data.realizedPnl).toBeNull()
      expect((await app.inject('/analytics/v1/markets')).json().data.items[0].longOpenInterest).toBeNull()
    } finally {
      await app.close()
    }
  })

  it.each([
    `/analytics/v1/wallets/${address}/performance`,
    `/analytics/v1/wallets/compare?addresses=${address}`,
    '/analytics/v1/markets',
    '/analytics/v1/markets/1',
  ])('refuses mixed history when replay rewinds after metadata read for %s', async (path) => {
    await checkpoint(now)
    await episode()
    let armed = true
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        const result = await db.store.pool.query(sql, values)
        if (armed && sql.includes('FROM analytics_checkpoint c')) {
          armed = false
          await new AnalyticsRepository(db.store.pool).rewind(BigInt(lastBlock))
        }
        return result
      },
    } as unknown as pg.Pool
    const app = makeApp([], pool)
    try {
      const response = await app.inject(path)
      expect(response.statusCode).toBe(503)
      expect(response.json().message).toBe('ANALYTICS_HISTORY_CHANGED')
      expect(response.headers['cache-control']).toBe('no-store')
    } finally {
      await app.close()
    }
  })

  it.each(['PositionDeleveraged', 'PositionDeleveragedV2', 'PositionUnwound', 'PositionUnwoundV2'])(
    'does not publish partial episode PnL or skew after unsupported %s settlement',
    async (name) => {
      await checkpoint(now)
      await episode()
      await unsupported(name, 3)
      const body = await request(`/analytics/v1/wallets/${address}/performance`)
      expect(body.data.realizedPnl).toBeNull()
      expect(body.data.closedTrades).toBe(0)
      const market = (await request('/analytics/v1/markets/1')).data
      expect(market.longOpenInterest).toBeNull()
      expect(market.shortOpenInterest).toBeNull()
      expect(market.longSharePct).toBeNull()
    },
  )

  it('recalculates rejected cached performance after replay returns to the same height and hash', async () => {
    await checkpoint(now)
    await episode()
    let armed = true
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        const result = await db.store.pool.query(sql, values)
        if (armed && sql.includes('FROM analytics_checkpoint c')) {
          armed = false
          await new AnalyticsRepository(db.store.pool).rewind(BigInt(lastBlock))
        }
        return result
      },
    } as unknown as pg.Pool
    const app = makeApp([], pool)
    try {
      const path = `/analytics/v1/wallets/${address}/performance`
      expect((await app.inject(path)).statusCode).toBe(503)
      await db.store.pool.query('INSERT INTO analytics_blocks(block_number,block_hash,occurred_at) VALUES($1,$2,$3)', [
        lastBlock,
        hash,
        new Date(now),
      ])
      await episode()
      await db.store.pool.query(
        "UPDATE analytics_position_events SET realized_pnl_micros=-2000000 WHERE action='close'",
      )
      await db.store.pool.query('UPDATE analytics_checkpoint SET next_block=$1,last_block_hash=$2,updated_at=now()', [
        lastBlock + 1,
        hash,
      ])
      const next = await app.inject(path)
      expect(next.statusCode).toBe(200)
      expect(next.json().coverage.completeHistory).toBe(true)
      expect(next.json().data.realizedPnl).toBe('-2.000000')
    } finally {
      await app.close()
    }
  })

  it('preserves a verified episode and unaffected market when unsupported settlement belongs elsewhere', async () => {
    await checkpoint(now)
    await episode()
    await db.store.pool.query('INSERT INTO analytics_accounts(account_id,address,created_block) VALUES(2,$1,$2)', [
      `0x${'2'.repeat(40)}`,
      deploymentBlock,
    ])
    await unsupported('PositionUnwound', 3, 2, sample.context.markets[1].perpetual_id)
    expect((await request(`/analytics/v1/wallets/${address}/performance`)).data.realizedPnl).toBe('1.000000')
    const market = (await request('/analytics/v1/markets/1')).data
    expect(market.longOpenInterest).toBe('0.000000')
    expect(market.shortOpenInterest).toBe('0.000000')
  })

  it('maps unsupported contract perpetual IDs to their distinct public market IDs', async () => {
    await checkpoint(now)
    await episode()
    await unsupported('PositionUnwoundV2', 3, 1, 100)
    const app = makeApp([], db.store.pool, [{ ...sample.context.markets[0], perpetual_id: 100 }])
    try {
      const response = await app.inject('/analytics/v1/markets/1')
      expect(response.statusCode).toBe(200)
      expect(response.json().data.longOpenInterest).toBeNull()
      expect(response.json().data.shortOpenInterest).toBeNull()
    } finally {
      await app.close()
    }
  })

  it('refuses skew when an unsupported settlement has no verified public market mapping', async () => {
    await checkpoint(now)
    await unsupported('PositionUnwoundV2', 3, 1, 65535)
    const app = makeApp()
    try {
      const response = await app.inject('/analytics/v1/markets/1')
      expect(response.statusCode).toBe(503)
      expect(response.json().message).toBe('ANALYTICS_SETTLEMENT_CONTEXT_UNAVAILABLE')
      expect(response.headers['cache-control']).toBe('no-store')
    } finally {
      await app.close()
    }
  })

  it('counts maker and taker participants using settled position evidence', async () => {
    await checkpoint(now)
    await event(1, 1, 'maker')
    await event(2, 2, 'position')
    const body = await request('/analytics/v1/protocol/summary?window=24h')
    expect(body.data.activeUsers.value).toBe('2')
  })

  it('does not report an unresolved account owner as zero active users', async () => {
    await checkpoint(now)
    await event(1, 1, 'maker', false)
    const body = await request('/analytics/v1/protocol/summary?window=24h')
    expect(body.data.activeUsers.value).toBeNull()
  })

  it('does not count a partial liquidation victim as a trader', async () => {
    await checkpoint(now)
    await event(1, 1, 'maker')
    await event(2, 2, 'position')
    await db.store.pool.query("UPDATE analytics_raw_events SET event_name='PositionLiquidated' WHERE log_index=2")
    await db.store.pool.query("UPDATE analytics_position_events SET action='reduce' WHERE log_index=2")
    const body = await request('/analytics/v1/protocol/summary?window=24h')
    expect(body.data.activeUsers.value).toBe('1')
  })

  it('uses indexed fill volume for a covered series', async () => {
    await checkpoint(now)
    await event(1, 1, 'maker')
    const from = new Date(now - 86_400_000).toISOString()
    const to = new Date(now).toISOString()
    const body = await request(`/analytics/v1/protocol/timeseries?metric=volume&interval=1h&from=${from}&to=${to}`)
    expect(body.source).toBe('derived')
    expect(body.data.points.some((point: { value: string | null }) => point.value === '3.000000')).toBe(true)
  })

  it('does not sum a partial market candle into a protocol total', async () => {
    const time = Math.floor(now / 3_600_000) * 3_600_000 - 3_600_000
    const from = new Date(time).toISOString()
    const to = new Date(time + 3_600_000).toISOString()
    const body = await request(`/analytics/v1/protocol/timeseries?metric=volume&interval=1h&from=${from}&to=${to}`, [
      [{ time, micros: 3000000n }],
      [],
    ])
    expect(body.data.points[0].value).toBeNull()
    expect(body.stale).toBe(true)
  })

  it('serves covered buckets while leaving the interval after the finalized head unavailable', async () => {
    await checkpoint(now)
    await event(1, 1, 'maker', true, 3_600_000)
    const from = new Date(now - 86_400_000).toISOString()
    const to = new Date(now + 10_000).toISOString()
    const body = await request(`/analytics/v1/protocol/timeseries?metric=volume&interval=1h&from=${from}&to=${to}`)
    expect(body.source).toBe('derived')
    expect(body.data.points.some((point: { value: string | null }) => point.value === '3.000000')).toBe(true)
    expect(body.data.points.at(-1).value).toBeNull()
  })
})
