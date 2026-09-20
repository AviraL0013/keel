import { describe, expect, it, vi } from 'vitest'
import { PerplHistory } from '../packages/perpl/src/history.js'
describe('Perpl signed history adapter', () => {
  it('signs exact target, paginates, filters, and rejects cursor loops', async () => {
    const sign = vi.fn().mockResolvedValue('sig')
    let page = 0
    const transport = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ 'X-API-Key': 'key', 'X-API-Signature': 'sig' })
      page++
      return new Response(JSON.stringify(page === 1 ? { d: [{ acc: 7, rq: 9, mkt: 1 }], np: 'next' } : { d: [{ acc: 8, rq: 9, mkt: 1 }], np: '' }), { status: 200 })
    })
    const history = new PerplHistory('https://testnet.perpl.xyz/api', { apiKey: 'key', sign } , transport)
    const rows = await history.read<{ acc: number; rq: number; mkt: number }>('order-history', item => item.acc === 7)
    expect(rows).toEqual([{ acc: 7, rq: 9, mkt: 1 }]); expect(sign).toHaveBeenCalledTimes(2); expect(transport).toHaveBeenCalledTimes(2)
    const looping = new PerplHistory('https://testnet.perpl.xyz/api', { apiKey: 'key', sign }, vi.fn().mockImplementation(async () => new Response(JSON.stringify({ d: [], np: 'same' }), { status: 200 })))
    await expect(looping.read('fills', () => true)).rejects.toThrow('PERPL_HISTORY_CURSOR_LOOP')
  })
})
