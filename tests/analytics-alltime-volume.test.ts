import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { PerplPublicAnalytics, type PublicMarket } from '../server/src/infrastructure/analytics/perpl-public.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'

const day = 86_400_000
const launch = Date.UTC(2026, 1, 12)
const through = launch + 3 * day
const markets = [{ id: 1 }, { id: 10 }] as PublicMarket[]

function reader(rows: Record<number, Array<{ t: number; v: string }>>, resolution = 86400) {
  return new PerplPublicAnalytics('https://fake.invalid', async (input) => {
    const [, id] = /\/market-data\/(\d+)\/candles\//.exec(String(input))!
    return Response.json({ r: resolution, d: rows[Number(id)] ?? [] })
  })
}

it('sums exact Perpl daily volume across staggered listed markets and excludes unfinished day', async () => {
  const result = await reader({
    1: [
      { t: launch, v: '1000001' },
      { t: launch + day, v: '2000002' },
      { t: launch + 2 * day, v: '3000003' },
      { t: through, v: '999999999' },
    ],
    10: [
      { t: launch + day, v: '4000004' },
      { t: launch + 2 * day, v: '5000005' },
    ],
  }).listedMarketVolume(markets, through)
  expect(result).toEqual({
    micros: 15_000_015n,
    from: launch,
    through,
    firstByMarket: { 1: launch, 10: launch + day },
    daily: [
      { time: launch, micros: 1_000_001n },
      { time: launch + day, micros: 6_000_006n },
      { time: launch + 2 * day, micros: 8_000_008n },
    ],
  })
})

it('keeps pre-listing days in daily charts but refuses a missing post-listing candle', async () => {
  const fixture = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8'))
  const context = { ...fixture.context, markets: fixture.context.markets.slice(0, 2) }
  const start = Date.UTC(2026, 9, 1)
  const app = Fastify()
  registerAnalyticsRoutes(app, null, {
    publicData: {
      context: async () => ({ value: context, asOf: new Date().toISOString(), block: null, stale: false }),
      listedMarketVolume: async () => ({
        micros: 0n,
        from: launch,
        through: Math.floor(Date.now() / day) * day,
        firstByMarket: { [context.markets[0].id]: launch, [context.markets[1].id]: start + day },
      }),
      volumeCandles: async (market: PublicMarket) =>
        market.id === context.markets[0].id
          ? [0, 1, 2].map((offset) => ({ time: start + offset * day, micros: 1_000_000n }))
          : [{ time: start + day, micros: 2_000_000n }],
    } as unknown as PerplPublicAnalytics,
  })
  try {
    const response = await app.inject(
      `/analytics/v1/protocol/timeseries?metric=volume&interval=1d&from=${new Date(start).toISOString()}&to=${new Date(start + 3 * day).toISOString()}`,
    )
    expect(response.statusCode).toBe(200)
    expect(response.json().data.points.map((point: { value: string | null }) => point.value)).toEqual([
      '1.000000',
      '3.000000',
      null,
    ])
  } finally {
    await app.close()
  }
})

it('leaves the current unfinished UTC day unavailable in daily volume charts', async () => {
  const fixture = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8'))
  const context = { ...fixture.context, markets: fixture.context.markets.slice(0, 2) }
  const today = Math.floor(Date.now() / day) * day
  const app = Fastify()
  registerAnalyticsRoutes(app, null, {
    publicData: {
      context: async () => ({ value: context, asOf: new Date().toISOString(), block: null, stale: false }),
      listedMarketVolume: async () => ({
        micros: 0n,
        from: launch,
        through: today,
        firstByMarket: Object.fromEntries(context.markets.map((market: PublicMarket) => [market.id, launch])),
      }),
      volumeCandles: async () => [
        { time: today - day, micros: 1_000_000n },
        { time: today, micros: 2_000_000n },
      ],
    } as unknown as PerplPublicAnalytics,
  })
  try {
    const response = await app.inject(
      `/analytics/v1/protocol/timeseries?metric=volume&interval=1d&from=${new Date(today - day).toISOString()}&to=${new Date().toISOString()}`,
    )
    expect(response.statusCode).toBe(200)
    expect(response.json().data.points.map((point: { value: string | null }) => point.value)).toEqual([
      '2.000000',
      null,
    ])
  } finally {
    await app.close()
  }
})

it('refuses gaps, malformed volume, wrong resolution, and missing launch anchor', async () => {
  const valid = {
    1: [
      { t: launch, v: '1' },
      { t: launch + day, v: '2' },
      { t: launch + 2 * day, v: '3' },
    ],
    10: [
      { t: launch + day, v: '4' },
      { t: launch + 2 * day, v: '5' },
    ],
  }
  for (const rows of [
    { ...valid, 1: [valid[1][0], valid[1][2]] },
    { ...valid, 1: [{ ...valid[1][0], v: '-1' }, ...valid[1].slice(1)] },
    { ...valid, 1: [{ ...valid[1][0], v: '1.0' }, ...valid[1].slice(1)] },
    { ...valid, 1: valid[1].slice(1) },
    { ...valid, 10: [] },
  ]) {
    await expect(reader(rows).listedMarketVolume(markets, through)).rejects.toThrow('PERPL_CANDLE_HISTORY_INCOMPLETE')
  }
  await expect(reader(valid, 3600).listedMarketVolume(markets, through)).rejects.toThrow(
    'PERPL_CANDLE_HISTORY_INCOMPLETE',
  )
})

it('serves labeled listed-market volume and fails soft when Perpl candles are incomplete', async () => {
  const fixture = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8'))
  const context = { ...fixture.context, markets: fixture.context.markets.slice(0, 2) }
  const cutoff = Math.floor(Date.now() / day) * day
  const candles = []
  for (let t = launch; t < cutoff; t += day) candles.push({ t, v: '1000000' })
  const makeApp = async (resolution: number) => {
    const app = Fastify()
    registerAnalyticsRoutes(app, null, {
      publicData: new PerplPublicAnalytics('https://fake.invalid', async (input) =>
        Response.json(String(input).endsWith('/v1/pub/context') ? context : { r: resolution, d: candles }),
      ),
    })
    await app.ready()
    return app
  }
  const app = await makeApp(86400)
  try {
    const response = await app.inject('/analytics/v1/protocol/summary?window=all')
    expect(response.statusCode).toBe(200)
    expect(response.json().data.volume.value).toBe(`${((cutoff - launch) / day) * 2}.000000`)
    expect(response.json().data.volume.note).toContain('Perpl API daily candles')
    expect(response.json().coverage.completeHistory).toBe(false)
    const week = await app.inject('/analytics/v1/protocol/summary?window=7d')
    expect(week.json().data.volume.value).toBe('14.000000')
    expect(week.json().data.volume.previous).toBe('14.000000')
    expect(week.json().data.volume.note).toContain('Perpl API daily candles')
    const month = await app.inject('/analytics/v1/protocol/summary?window=30d')
    expect(month.json().data.volume.value).toBe('60.000000')
    expect(month.json().data.volume.previous).toBe('60.000000')
  } finally {
    await app.close()
  }
  const broken = await makeApp(3600)
  try {
    const response = await broken.inject('/analytics/v1/protocol/summary?window=all')
    expect(response.statusCode).toBe(200)
    expect(response.json().data.volume.value).toBeNull()
    expect(response.json().data.openInterest.value).not.toBeNull()
  } finally {
    await broken.close()
  }
})
