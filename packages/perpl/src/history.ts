import type { ApiKeySigner } from './index.js'
import type { WireFill, WireOrder, WirePosition, Stamp } from './decoder.js'
import { createNonce } from './signer.js'
import { parsePerplRequestIds } from './request-id.js'

export type AccountEvent = { id: number; m?: number; p?: number; r?: string | number; o?: number; et: number; a: string; at: Stamp }
export class PerplHistory {
  constructor(private readonly baseUrl: string, private readonly signer: ApiKeySigner, private readonly transport: typeof fetch = fetch) {}
  async read<T>(resource: 'account-history' | 'order-history' | 'position-history' | 'fills', predicate: (item: T) => boolean): Promise<T[]> {
    let page: string | undefined
    const result: T[] = []
    const seen = new Set<string>()
    for (let count = 0; count < 100; count++) {
      const query = new URLSearchParams({ count: '100' })
      if (page) query.set('page', page)
      const target = `/v1/trading/${resource}?${query}`
      const timestamp = String(Date.now()), nonce = createNonce()
      const signature = await this.signer.sign('GET', target, '', timestamp, nonce)
      const response = await this.transport(`${this.baseUrl.replace(/\/$/, '')}${target}`, {
        signal: AbortSignal.timeout(10000),
        headers: { 'X-API-Key': this.signer.apiKey, 'X-API-Timestamp': timestamp, 'X-API-Nonce': nonce, 'X-API-Signature': signature },
      })
      if (!response.ok) throw new Error(`PERPL_HISTORY_HTTP_${response.status}`)
      const data = parsePerplRequestIds(await response.text()) as { d?: T[]; np?: string }
      if (!Array.isArray(data.d)) throw new Error('PERPL_HISTORY_INVALID')
      result.push(...data.d.filter(predicate))
      if (!data.np) return result
      if (seen.has(data.np)) throw new Error('PERPL_HISTORY_CURSOR_LOOP')
      seen.add(data.np); page = data.np
    }
    throw new Error('PERPL_HISTORY_SCAN_LIMIT')
  }
  async evidence(accountId: number, requestId: string, marketId: number, positionId: number) {
    const [orders, positions, accounts, fills] = await Promise.all([
      this.read<WireOrder>('order-history', item => item.acc === accountId && String(item.rq) === requestId && item.mkt === marketId),
      this.read<WirePosition>('position-history', item => item.acc === accountId && item.pid === positionId && item.mkt === marketId),
      this.read<AccountEvent>('account-history', item => item.id === accountId && String(item.r) === requestId && item.m === marketId),
      this.read<WireFill>('fills', item => item.acc === accountId && item.mkt === marketId),
    ])
    return { orders, positions, accounts, fills: fills.filter(fill => orders.some(order => order.oid === fill.oid)) }
  }
}
