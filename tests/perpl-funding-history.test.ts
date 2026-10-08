import { afterEach, expect, it, vi } from 'vitest'
import { PerplAdapter } from '../packages/perpl/src/index.js'

afterEach(() => vi.unstubAllGlobals())

it('reads only unsigned funding history and refuses invalid ranges before transport', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ m: 1, d: [] }), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  const adapter = new PerplAdapter('mainnet')
  try {
    expect(await adapter.getFundingHistory(1, 1000, 2000)).toEqual({ m: 1, d: [] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.toString()).toBe('https://app.perpl.xyz/api/v1/market-data/1/funding/1000-2000')
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    for (const args of [
      [0, 1000, 2000],
      [1, -1, 2000],
      [1, 2000, 2000],
      [1, 1000.5, 2000],
    ])
      await expect(adapter.getFundingHistory(args[0]!, args[1]!, args[2]!)).rejects.toThrow(
        'PERPL_FUNDING_RANGE_INVALID',
      )
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally {
    adapter.close()
  }
})

it('does not retry or replace a public funding 401/403 with another source', async () => {
  for (const status of [401, 403]) {
    const fetcher = vi.fn(async () => new Response('{}', { status }))
    vi.stubGlobal('fetch', fetcher)
    const adapter = new PerplAdapter('mainnet')
    try {
      await expect(adapter.getFundingHistory(1, 1000, 2000)).rejects.toThrow()
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      adapter.close()
    }
  }
})
