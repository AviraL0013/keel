import { describe, expect, it, vi } from 'vitest'
import { PerplHistory } from '../packages/perpl/src/history.js'
describe('Perpl signed history adapter', () => {
  it('reads the current wallet snapshot with its state block', async () => {
    const sign = vi.fn().mockResolvedValue('sig')
    const transport = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ at: { b: 123 }, as: [{ id: 642, b: '1000000', lb: '200000' }] }), {
        status: 200,
      }),
    )
    const history = new PerplHistory('https://testnet.perpl.xyz/api', { apiKey: 'key', sign }, transport)
    await expect(history.wallet()).resolves.toEqual({
      at: { b: 123 },
      as: [{ id: 642, b: '1000000', lb: '200000' }],
    })
    expect(sign).toHaveBeenCalledWith('GET', '/v1/trading/wallet', '', expect.any(String), expect.any(String))
    expect(transport).toHaveBeenCalledWith(
      'https://testnet.perpl.xyz/api/v1/trading/wallet',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-API-Key': 'key', 'X-API-Signature': 'sig' }) }),
    )
  })

  it('signs exact target, paginates, filters, and rejects cursor loops', async () => {
    const sign = vi.fn().mockResolvedValue('sig')
    let page = 0
    const transport = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ 'X-API-Key': 'key', 'X-API-Signature': 'sig' })
      page++
      return new Response(
        JSON.stringify(
          page === 1 ? { d: [{ acc: 7, rq: 9, mkt: 1 }], np: 'next' } : { d: [{ acc: 8, rq: 9, mkt: 1 }], np: '' },
        ),
        { status: 200 },
      )
    })
    const history = new PerplHistory('https://testnet.perpl.xyz/api', { apiKey: 'key', sign }, transport)
    const rows = await history.read<{ acc: number; rq: string; mkt: number }>('order-history', (item) => item.acc === 7)
    expect(rows).toEqual([{ acc: 7, rq: '9', mkt: 1 }])
    expect(sign).toHaveBeenCalledTimes(2)
    expect(transport).toHaveBeenCalledTimes(2)
    const looping = new PerplHistory(
      'https://testnet.perpl.xyz/api',
      { apiKey: 'key', sign },
      vi.fn().mockImplementation(async () => new Response(JSON.stringify({ d: [], np: 'same' }), { status: 200 })),
    )
    await expect(looping.read('fills', () => true)).rejects.toThrow('PERPL_HISTORY_CURSOR_LOOP')
  })

  it('stops a reconciliation scan after the first page older than the action block', async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          d: [{ acc: 642, rq: '1791001362444', at: { b: 66118126 } }],
          np: 'older',
        }),
        { status: 200 },
      ),
    )
    const history = new PerplHistory(
      'https://testnet.perpl.xyz/api',
      { apiKey: 'key', sign: async () => 'sig' },
      transport,
    )
    expect(
      await history.read<{ acc: number; rq: string; at: { b: number } }>(
        'order-history',
        (item) => item.rq === '1791001362445',
        66118287,
      ),
    ).toEqual([])
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('scans the next page when the boundary block might continue there', async () => {
    const transport = vi.fn().mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            new URL(url).searchParams.has('page')
              ? {
                  d: [
                    { rq: 'target', at: { b: 100 } },
                    { rq: 'old', at: { b: 99 } },
                  ],
                  np: 'older',
                }
              : {
                  d: [
                    { rq: 'other', at: { b: 101 } },
                    { rq: 'other', at: { b: 100 } },
                  ],
                  np: 'next',
                },
          ),
          { status: 200 },
        ),
    )
    const history = new PerplHistory(
      'https://testnet.perpl.xyz/api',
      { apiKey: 'key', sign: async () => 'sig' },
      transport,
    )
    expect(
      await history.read<{ rq: string; at: { b: number } }>('order-history', (item) => item.rq === 'target', 100),
    ).toEqual([{ rq: 'target', at: { b: 100 } }])
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('does not cut off history when a page lacks a reliable block', async () => {
    const transport = vi
      .fn()
      .mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              new URL(url).searchParams.has('page')
                ? { d: [{ rq: 'target', at: { b: 101 } }], np: '' }
                : { d: [{ rq: 'other', at: {} }], np: 'next' },
            ),
            { status: 200 },
          ),
      )
    const history = new PerplHistory(
      'https://testnet.perpl.xyz/api',
      { apiKey: 'key', sign: async () => 'sig' },
      transport,
    )
    expect(
      await history.read<{ rq: string; at: { b?: number } }>('order-history', (item) => item.rq === 'target', 100),
    ).toEqual([{ rq: 'target', at: { b: 101 } }])
    expect(transport).toHaveBeenCalledTimes(2)
  })
})
