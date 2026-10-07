import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PerplPublicAnalytics } from '../server/src/infrastructure/analytics/perpl-public.js'
import { WalletChainAnalytics } from '../server/src/infrastructure/analytics/wallet-chain.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'
import { databaseFixture } from './helpers/database.js'

const live = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')) as {
  context: unknown
  funding: unknown
  candles: unknown
}
const walletFixture = JSON.parse(readFileSync('packages/analytics/fixtures/_wallets_address.json', 'utf8')) as {
  asOf: string
  block: number
  source: 'monad_exchange'
  stale: boolean
  data: { address: string; accountIds: string[]; margin: unknown; positions: unknown[] }
}
const address = walletFixture.data.address
let fetchCount = 0
const mockFetch = async (input: string | URL | Request) => {
  fetchCount++
  const url = String(input)
  const body = url.endsWith('/v1/pub/context') ? live.context : url.includes('/funding/') ? live.funding : live.candles
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('Analytics v1 public HTTP routes', () => {
  const app = Fastify()
  let db: Awaited<ReturnType<typeof databaseFixture>>
  beforeAll(async () => {
    db = await databaseFixture()
    const publicData = new PerplPublicAnalytics('https://fixture.perpl.invalid/api', mockFetch as typeof fetch)
    const wallet = {
      profile: async (requested: string) =>
        requested.toLowerCase() === address.toLowerCase()
          ? { ...walletFixture, data: { ...walletFixture.data, address: requested } }
          : null,
    } as unknown as WalletChainAnalytics
    registerAnalyticsRoutes(app, db.store.pool, { publicData, wallet })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    await db.db.close()
  })

  it('serves every mandatory endpoint with v1 envelope', async () => {
    const now = Date.now()
    const from = new Date(now - 86_400_000).toISOString()
    const to = new Date(now).toISOString()
    const paths = [
      '/analytics/v1/protocol/summary?window=24h',
      `/analytics/v1/protocol/timeseries?metric=volume&interval=1h&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      '/analytics/v1/protocol/flows',
      '/analytics/v1/markets',
      '/analytics/v1/markets/1',
      `/analytics/v1/markets/1/funding?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      '/analytics/v1/liquidations',
      `/analytics/v1/search?q=${address}`,
      `/analytics/v1/wallets/${address}`,
      `/analytics/v1/wallets/${address}/trades`,
      `/analytics/v1/wallets/${address}/performance`,
      `/analytics/v1/wallets/compare?addresses=${address}`,
    ]
    for (const path of paths) {
      const response = await app.inject({ method: 'GET', url: path })
      expect(response.statusCode, path).toBe(200)
      const body = response.json() as Record<string, unknown>
      expect(
        Object.keys(body)
          .filter((key) => key !== 'coverage')
          .sort(),
        path,
      ).toEqual(['asOf', 'block', 'data', 'source', 'stale'])
      expect(response.headers['cache-control']).toMatch(/max-age=/)
    }
  })

  it('validates windows, addresses, compare cap, ranges, and cursors', async () => {
    for (const path of [
      '/analytics/v1/protocol/summary?window=1y',
      '/analytics/v1/wallets/0x123',
      `/analytics/v1/wallets/compare?addresses=${[address, address, address, address, address].join(',')}`,
      '/analytics/v1/protocol/timeseries?metric=volume&interval=1h&from=bad',
      '/analytics/v1/liquidations?cursor=!!',
    ]) {
      const response = await app.inject({ method: 'GET', url: path })
      expect(response.statusCode, path).toBe(400)
    }
  })

  it('caches context and marks uncovered flow history stale', async () => {
    const before = fetchCount
    const first = await app.inject('/analytics/v1/markets')
    const second = await app.inject('/analytics/v1/markets')
    expect(second.json()).toEqual(first.json())
    expect(fetchCount).toBe(before)
    const flows = await app.inject('/analytics/v1/protocol/flows')
    expect(flows.json().stale).toBe(true)
    expect(flows.json().data.net).toBeNull()
    const all = await app.inject('/analytics/v1/protocol/summary?window=all')
    expect(all.json().coverage.completeHistory).toBe(false)
    expect(all.json().coverage.label).toBe('No indexed history')
  })

  it('uses stable keyset cursors for liquidation pages', async () => {
    const hash = `0x${'b'.repeat(64)}`
    const when = new Date()
    await db.store.pool.query('INSERT INTO analytics_blocks(block_number,block_hash,occurred_at) VALUES($1,$2,$3)', [
      '999999999',
      hash,
      when,
    ])
    await db.store.pool.query(
      'INSERT INTO analytics_accounts(account_id,address,created_block) VALUES(42,$1,999999999)',
      [address.toLowerCase()],
    )
    for (const index of [1, 2, 3]) {
      await db.store.pool.query(
        `INSERT INTO analytics_raw_events(block_number,transaction_hash,log_index,transaction_index,block_hash,data,topics)
        VALUES(999999999,$1,$2,0,$1,'0x','[]')`,
        [hash, index],
      )
      await db.store.pool.query(
        `INSERT INTO analytics_liquidations(block_number,transaction_hash,log_index,account_id,market_id,side,lot_raw,price_raw,notional_micros,realized_pnl_micros,occurred_at)
        VALUES(999999999,$1,$2,42,1,'long',1,1,1000000,-100000,$3)`,
        [hash, index, when],
      )
    }
    const first = await app.inject('/analytics/v1/liquidations?limit=1')
    expect(first.statusCode).toBe(200)
    expect(first.json().data.items[0].id).toContain(':3')
    expect(first.json().data.summary.count).toBe(3)
    const second = await app.inject(`/analytics/v1/liquidations?limit=1&cursor=${first.json().data.nextCursor}`)
    expect(second.statusCode).toBe(200)
    expect(second.json().data.items[0].id).toContain(':2')
  })
})
