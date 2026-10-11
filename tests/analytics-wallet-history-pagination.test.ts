import { describe, expect, it } from 'vitest'
import {
  pageVerifiedWalletTrades,
  type VerifiedHistoryTrade,
} from '../server/src/infrastructure/analytics/wallet-completion.js'

const row = (block: bigint, transactionIndex: number, logIndex: number): VerifiedHistoryTrade => ({
  block,
  transactionIndex,
  logIndex,
  trade: {
    id: `${block}:0x${transactionIndex.toString(16).padStart(64, '0')}:${logIndex}`,
    time: '2026-10-11T00:00:00.000Z',
    marketId: 1,
    side: 'long',
    action: 'reduce',
    size: '0.01',
    price: '8299.10',
    notional: '82.991000',
    fee: '0.000001',
    realizedPnl: '-0.000001',
    transactionHash: `0x${transactionIndex.toString(16).padStart(64, '0')}`,
  },
})

describe('wallet history keyset pagination', () => {
  it('orders block, transaction and log descending across duplicate fetch overlap', () => {
    const items = [row(99n, 8, 4), row(100n, 1, 2), row(100n, 2, 1), row(100n, 2, 3), row(100n, 2, 3)]
    const first = pageVerifiedWalletTrades(items, 2)
    expect(first.items.map((item) => item.id)).toEqual([row(100n, 2, 3).trade.id, row(100n, 2, 1).trade.id])
    expect(first.nextCursor).not.toBeNull()
    const second = pageVerifiedWalletTrades(items, 2, first.nextCursor!)
    expect(second.items.map((item) => item.id)).toEqual([row(100n, 1, 2).trade.id, row(99n, 8, 4).trade.id])
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4)
  })

  it('rejects conflicting duplicates, occupied slots and malformed cursors', () => {
    const original = row(100n, 2, 3)
    expect(() =>
      pageVerifiedWalletTrades([original, { ...original, trade: { ...original.trade, fee: '9.000000' } }], 2),
    ).toThrow('ANALYTICS_HISTORY_DUPLICATE_CONFLICT')
    expect(() =>
      pageVerifiedWalletTrades([original, { ...original, trade: { ...original.trade, id: 'different' } }], 2),
    ).toThrow('ANALYTICS_HISTORY_SLOT_CONFLICT')
    expect(() =>
      pageVerifiedWalletTrades([original, { ...row(101n, 2, 3), trade: { ...original.trade, id: 'other' } }], 2),
    ).toThrow('ANALYTICS_HISTORY_TX_REORG')
    for (const cursor of [
      '!',
      Buffer.from('["100",-1,0]').toString('base64url'),
      Buffer.from('{}').toString('base64url'),
    ])
      expect(() => pageVerifiedWalletTrades([original], 1, cursor)).toThrow('ANALYTICS_HISTORY_CURSOR_INVALID')
    expect(() => pageVerifiedWalletTrades([original], 101)).toThrow('ANALYTICS_HISTORY_LIMIT_INVALID')
  })
})
