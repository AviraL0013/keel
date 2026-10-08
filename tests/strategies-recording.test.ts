import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { captureStrategyWindow } from '../packages/strategies/src/recording.js'

const recorded = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8'))
const from = 1791302400000,
  to = 1791388800000
const transport = () =>
  vi.fn(async (url: string, init?: RequestInit) => {
    expect(url.startsWith('https://app.perpl.xyz/api/')).toBe(true)
    expect(init?.method ?? 'GET').toBe('GET')
    expect(init?.headers).toBeUndefined()
    return Response.json(
      url.endsWith('/context') ? recorded.context : url.includes('/candles/') ? recorded.candles : recorded.funding,
    )
  })

it('records unsigned completed hourly BTC evidence without credentials or private methods', async () => {
  const read = transport()
  const result = await captureStrategyWindow(from, to, read)
  expect(result.candles).toHaveLength(24)
  expect(result.candles[0].c).toBe(856079)
  expect(result.priceDecimals).toBe(1)
  expect(result.baseMakerFeeMicros).toBe(45)
  expect(result.funding.every((event) => event.at.t >= from && event.at.t < to)).toBe(true)
  expect(read).toHaveBeenCalledTimes(3)
})
it.each([401, 403])('stops immediately on HTTP %s without any alternate access', async (status) => {
  const read = vi.fn(async () => new Response('', { status }))
  await expect(captureStrategyWindow(from, to, read)).rejects.toThrow(`PERPL_RECORDING_HTTP_${status}`)
  expect(read).toHaveBeenCalledTimes(1)
})
it('refuses mixed chains, incomplete candles and oversized funding windows', async () => {
  const wrong = vi.fn(async () => Response.json({ ...recorded.context, chain: { chain_id: 10143 } }))
  await expect(captureStrategyWindow(from, to, wrong)).rejects.toThrow('PERPL_RECORDING_CONTEXT_MISMATCH')
  expect(wrong).toHaveBeenCalledTimes(1)
  const gaps = transport().mockImplementation(async (url) =>
    Response.json(
      url.endsWith('/context') ? recorded.context : { ...recorded.candles, d: recorded.candles.d.slice(1) },
    ),
  )
  await expect(captureStrategyWindow(from, to, gaps)).rejects.toThrow('PERPL_RECORDING_CANDLES_INCOMPLETE')
  const read = transport()
  await expect(captureStrategyWindow(from, from + 31 * 86400000, read)).rejects.toThrow('PERPL_RECORDING_RANGE_INVALID')
  expect(read).not.toHaveBeenCalled()
})
it('splits funding capture below 500 intervals and stops on an authorization error', async () => {
  const start = 1791129600000,
    end = start + 2 * 86400000
  let fundingCalls = 0
  const read = vi.fn(async (url: string) => {
    if (url.endsWith('/context'))
      return Response.json({
        ...recorded.context,
        markets: [{ ...recorded.context.markets[0], funding_interval_sec: 120 }],
      })
    if (url.includes('/candles/'))
      return Response.json({
        r: 3600,
        d: Array.from({ length: 48 }, (_, index) => ({ ...recorded.candles.d[0], t: start + index * 3600000 })),
      })
    fundingCalls++
    if (fundingCalls === 2) return new Response('', { status: 403 })
    const range = url.split('/').at(-1)!.split('-').map(Number)
    expect(range[1] - range[0]).toBeLessThan(500 * 120000)
    return Response.json({ m: 1, d: [] })
  })
  await expect(captureStrategyWindow(start, end, read)).rejects.toThrow('PERPL_RECORDING_HTTP_403')
  expect(fundingCalls).toBe(2)
})
