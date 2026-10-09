import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { PerplPublicAnalytics, type PublicMarket } from '../server/src/infrastructure/analytics/perpl-public.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'

const recorded = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8'))
const market = recorded.context.markets.find((m: PublicMarket) => m.id === 1) as PublicMarket
const from = 1791302400000,
  step = 3600000,
  to = 1791388800000
const fetcher =
  (candles = recorded.candles) =>
  async (url: unknown) => {
    if (String(url).endsWith('/v1/pub/context')) return Response.json(recorded.context)
    if (!String(url).includes('/v1/market-data/1/candles/')) throw Error('UNEXPECTED_FAKE_REQUEST')
    return Response.json(candles)
  }

it('decodes recorded BTC completed closes exactly with candle provenance and archived staleness', async () => {
  const api = new PerplPublicAnalytics('https://fake.invalid', fetcher())
  const prices = await api.prices(market, '1h', from, to + step)
  expect(prices.block).toBe(111365948)
  expect(prices.asOf).toBe('2026-10-07T16:00:00.000Z')
  expect(prices.stale).toBe(true)
  expect(prices.data.points.slice(0, 2)).toEqual([
    { time: '2026-10-06T16:00:00.000Z', value: '85607.9' },
    { time: '2026-10-06T17:00:00.000Z', value: '85702.0' },
  ])
  expect(prices.data.points.at(-1)).toEqual({ time: new Date(to).toISOString(), value: null })
})

it('leaves absent buckets null and rejects malformed prices, resolution and conflicting replay', async () => {
  const raw = { ...recorded.candles, d: recorded.candles.d.slice(0, 1) }
  const prices = await new PerplPublicAnalytics('https://fake.invalid', fetcher(raw)).prices(
    market,
    '1h',
    from,
    from + 2 * step,
  )
  expect(prices.data.points[1].value).toBeNull()
  expect(prices.stale).toBe(true)
  for (const mutation of [
    { ...raw, r: 86400 },
    { ...raw, at: { ...raw.at, t: Date.now() + 2 * step } },
    { ...raw, at: { ...raw.at, t: Number.MAX_SAFE_INTEGER } },
    { ...raw, d: [{ ...raw.d[0], c: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...raw, d: [{ ...raw.d[0], c: -1 }] },
    { ...raw, d: [{ ...raw.d[0], t: from + 1 }] },
    { ...raw, d: [raw.d[0], { ...raw.d[0], c: 1 }] },
  ]) {
    await expect(
      new PerplPublicAnalytics('https://fake.invalid', fetcher(mutation)).prices(market, '1h', from, to),
    ).rejects.toThrow('PERPL_CANDLES_INVALID')
  }
})

it('paginates bounded candle windows, deduplicates identical boundary rows and orders by time', async () => {
  const calls: string[] = []
  const startAt = Date.UTC(2026, 6, 1)
  const reader = new PerplPublicAnalytics('https://fake.invalid', async (input) => {
    calls.push(String(input))
    const [, start, end] = /\/(\d+)-(\d+)$/.exec(String(input))!
    const rows = []
    for (let t = Number(start); t < Number(end); t += step) rows.push({ t, c: 856079 })
    return Response.json({ r: 3600, at: { b: 111365948, t: startAt + 2100 * step }, d: [...rows.reverse(), rows[0]] })
  })
  const response = await reader.prices(market, '1h', startAt, startAt + 2100 * step)
  expect(calls).toHaveLength(3)
  expect(response.data.points).toHaveLength(2100)
  expect(response.data.points[0].time).toBe(new Date(startAt).toISOString())
  expect(response.data.points.at(-1)?.time).toBe(new Date(startAt + 2099 * step).toISOString())
  expect(response.data.points.every((p) => p.value === '85607.9')).toBe(true)
})

it('serves recorded prices read-only, validates ranges and IDs and caches one exact request', async () => {
  let calls = 0
  const app = Fastify()
  registerAnalyticsRoutes(app, null, {
    publicData: new PerplPublicAnalytics('https://fake.invalid', async (input) => {
      calls++
      return fetcher()(input)
    }),
  })
  try {
    const path = `/analytics/v1/markets/1/prices?interval=1h&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`
    const first = await app.inject(path)
    expect(first.statusCode).toBe(200)
    expect(first.json().source).toBe('perpl_api')
    expect(first.json().data.marketId).toBe(1)
    expect(first.json().data.points[0].value).toBe('85607.9')
    expect((await app.inject(path)).json()).toEqual(first.json())
    expect(calls).toBe(2)
    for (const [url, status] of [
      ['/analytics/v1/markets/9999/prices?interval=1h', 404],
      ['/analytics/v1/markets/1/prices?interval=1m', 400],
      ['/analytics/v1/markets/1/prices?interval=1h&from=bad', 400],
      ['/analytics/v1/markets/1/prices?interval=1h&from=2020-01-01T00:00:00.000Z', 400],
      ['/analytics/v1/markets/1/prices?interval=1h&from=1969-12-31T23:00:00.000Z&to=1970-01-01T01:00:00.000Z', 400],
    ] as const)
      expect((await app.inject(url)).statusCode).toBe(status)
  } finally {
    await app.close()
  }
})
