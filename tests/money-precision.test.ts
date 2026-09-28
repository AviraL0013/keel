import { describe, expect, it, vi } from 'vitest'
import { ReserveLedger } from '../packages/chain/src/ledger.js'
import { formatMoney, moneyMicros, reserveHeadroom } from '../packages/ausd/src/money.js'
import { settleDefense } from '../server/src/reserveSettlement.js'

describe('AUSD money precision', () => {
  it('keeps exact balances through decimal reserve and deployment cycles', () => {
    const ledger = new ReserveLedger()
    ledger.append({ bookId: 'b', type: 'RESERVE_CREATED', amount: 1 })
    for (let i = 0; i < 3; i++) {
      ledger.append({ bookId: 'b', type: 'RESERVE_RESERVED', amount: 0.1 })
      ledger.append({ bookId: 'b', type: 'RESERVE_RELEASED', amount: 0.1 })
      ledger.append({ bookId: 'b', type: 'RESERVE_DEPLOYED', amount: 0.2 })
    }
    ledger.append({ bookId: 'b', type: 'RESERVE_DEPLOYED', amount: 0.000001 })
    expect(ledger.balanceExact('b')).toEqual({
      total: '1.000000',
      reserved: '0.000000',
      deployed: '0.600001',
      available: '0.399999',
    })
  })

  it('accepts the exact cap boundary and rejects one micro-unit over it', () => {
    expect(reserveHeadroom('1', '0.2', '0.3', '1')).toBe('0.500000')
    const ledger = new ReserveLedger()
    ledger.append({ bookId: 'b', type: 'RESERVE_CREATED', amount: 0.3 })
    ledger.append({ bookId: 'b', type: 'RESERVE_DEPLOYED', amount: 0.3 })
    expect(() => ledger.append({ bookId: 'b', type: 'RESERVE_DEPLOYED', amount: 0.000001 })).toThrow(
      'RESERVE_CAP_EXCEEDED',
    )
  })

  it('does not deploy funds still reserved for another action', () => {
    const ledger = new ReserveLedger()
    ledger.append({ bookId: 'b', type: 'RESERVE_CREATED', amount: 1 })
    ledger.append({ bookId: 'b', type: 'RESERVE_RESERVED', amount: 0.9 })
    expect(() => ledger.append({ bookId: 'b', type: 'RESERVE_DEPLOYED', amount: 0.2 })).toThrow(
      'RESERVE_AVAILABLE_EXCEEDED',
    )
  })

  it('matches randomized integer micro-unit arithmetic', () => {
    let seed = 17
    let balance = 1_000_000n
    const ledger = new ReserveLedger()
    ledger.append({ bookId: 'random', type: 'RESERVE_CREATED', amount: 1 })
    for (let i = 0; i < 1000; i++) {
      seed = (seed * 48271) % 2147483647
      const value = BigInt(seed % 1000)
      const amount = formatMoney(value)
      expect(moneyMicros(amount)).toBe(value)
      ledger.append({ bookId: 'random', type: 'RESERVE_DEPLOYED', amount: Number(amount) })
      balance -= value
      expect(ledger.balanceExact('random').available).toBe(formatMoney(balance))
    }
    expect(() => moneyMicros('0.0000001')).toThrow('INVALID_AUSD_AMOUNT')
    expect(() => moneyMicros(1_000_000_001)).toThrow('INVALID_AUSD_AMOUNT')
    expect(moneyMicros('1000000001.000001')).toBe(1_000_000_001_000_001n)
  })

  it('rejects sub-micro deployment before touching the database', async () => {
    const query = vi.fn()
    await expect(settleDefense({ query }, 'book', 0.0000001, 'action', 'decision')).rejects.toThrow(
      'INVALID_DEPLOYMENT_AMOUNT',
    )
    expect(query).not.toHaveBeenCalled()
  })
})
