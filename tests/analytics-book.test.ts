import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { PerplPublicAnalytics, type PublicMarket } from '../server/src/infrastructure/analytics/perpl-public.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'

const context = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')).context
const market = context.markets.find((item: PublicMarket) => item.id === 1) as PublicMarket
const book = () => ({
  mt: 15,
  sn: 112964454,
  at: { b: 112964454, t: Date.now() },
  bid: [
    { p: 835009, s: 1468, o: 9 },
    { p: 835008, s: 300, o: 2 },
  ],
  ask: [
    { p: 835010, s: 264, o: 4 },
    { p: 835016, s: 94, o: 1 },
  ],
})

it('serves bounded Perpl book with exact scaled levels and source timestamp', async () => {
  let calls = 0
  const publicData = new PerplPublicAnalytics('https://fake.invalid', async (input) => {
    calls++
    return Response.json(String(input).endsWith('/v1/pub/context') ? context : book())
  })
  const expected = await publicData.book(market)
  expect(expected.value.bids[0]).toEqual({ price: '83500.9', size: '0.01468', orders: 9 })
  expect(expected.value.asks[0]).toEqual({ price: '83501.0', size: '0.00264', orders: 4 })
  expect(expected.value.spreadBps).toBe('0.0120')
  const app = Fastify()
  registerAnalyticsRoutes(app, null, { publicData })
  try {
    const response = await app.inject('/analytics/v1/markets/1/book')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ source: 'perpl_api', block: 112964454, stale: false, data: expected.value })
    expect((await app.inject('/analytics/v1/markets/1/book')).json()).toEqual(response.json())
    expect(calls).toBe(3)
    expect((await app.inject('/analytics/v1/markets/999/book')).statusCode).toBe(404)
  } finally {
    await app.close()
  }
})

it('rejects crossed, unordered, stale and malformed order books', async () => {
  for (const mutation of [
    { ...book(), bid: [{ p: 835011, s: 1, o: 1 }] },
    {
      ...book(),
      bid: [
        { p: 835009, s: 1, o: 1 },
        { p: 835010, s: 1, o: 1 },
      ],
    },
    { ...book(), at: { b: 112964454, t: Date.now() - 3_600_001 } },
    { ...book(), ask: [{ p: 835010, s: -1, o: 1 }] },
  ]) {
    const source = new PerplPublicAnalytics('https://fake.invalid', async () => Response.json(mutation))
    await expect(source.book(market)).rejects.toThrow('PERPL_BOOK_INVALID')
  }
})
