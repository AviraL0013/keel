import { describe, expect, it } from 'vitest'
import { reconcileBookCapital } from '../server/src/infrastructure/capital/reconciliation.js'

describe('Capital source reconciliation', () => {
  it('keeps each Book ledger bucket distinct and warns only above Perpl free balance', () => {
    const rows = [
      {
        bookId: 'a',
        available: '0.100001',
        reserved: '0.200000',
        deployed: '0.300000',
        updatedAt: '2026-10-02T00:00:00Z',
      },
      {
        bookId: 'b',
        available: '0.899999',
        reserved: '0.100000',
        deployed: '0.400000',
        updatedAt: '2026-10-02T00:01:00Z',
      },
    ]
    const atBoundary = reconcileBookCapital(rows, '1.000000')
    expect(atBoundary).toMatchObject({
      available: '1.000000',
      reserved: '0.300000',
      deployed: '0.700000',
      unreserved: '0.000000',
      coverage: undefined,
    })
    expect(atBoundary.allocations).toHaveLength(2)
    expect(atBoundary.allocations[0]).toMatchObject({ bookId: 'a', available: '0.100001' })
    expect(reconcileBookCapital(rows, '0.999999').coverage).toMatchObject({
      shortfall: '0.000001',
      promised: '1.000000',
      perplFree: '0.999999',
    })
  })

  it('sums random six-decimal allocations using integer micro-units without adding wallet or Perpl balances', () => {
    let seed = 19
    const next = () => (seed = (seed * 16807) % 2147483647) % 1_000_000
    for (let sample = 0; sample < 100; sample++) {
      const micros = Array.from({ length: 5 }, next)
      const rows = micros.map((value, index) => ({
        bookId: String(index),
        available: `${value / 1_000_000}`,
        reserved: '0',
        deployed: '0',
        updatedAt: '2026-10-02T00:00:00Z',
      }))
      const result = reconcileBookCapital(rows, '10.000000')
      expect(BigInt(result.available.replace('.', '').padEnd(7, '0'))).toBe(
        BigInt(micros.reduce((sum, value) => sum + value, 0)),
      )
      expect(result.coverage).toBeUndefined()
    }
  })

  it('marks coverage unavailable when Perpl balance is unavailable', () => {
    const result = reconcileBookCapital([
      { bookId: 'a', available: '1', reserved: '0', deployed: '0', updatedAt: '2026-10-02T00:00:00Z' },
    ])
    expect(result.available).toBe('1.000000')
    expect(result.unreserved).toBeNull()
    expect(result.coverage).toBeUndefined()
  })
})
