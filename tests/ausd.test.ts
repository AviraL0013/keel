import { describe, expect, it } from 'vitest'
import { AusdAdapter } from '../packages/ausd/src/index.js'
import type { ChainAdapter } from '../packages/chain/src/index.js'

describe('AUSD unit handling', () => {
  it('keeps wallet collateral fractional when reconciling raw units', () => {
    const adapter = new AusdAdapter({} as ChainAdapter)
    const result = adapter.reconcileReserve(
      { bookId: 'book', available: 99.45741, reserved: 0, deployed: 0, cap: 100, updatedAt: new Date().toISOString() },
      99457410n,
      6,
    )
    expect(result.externalWalletRaw).toBe('99457410')
    expect(result.externalWalletBalance).toBe('99.45741')
  })

  it('reconciles decimal reserve components without floating-point addition', () => {
    const adapter = new AusdAdapter({} as ChainAdapter)
    const result = adapter.reconcileReserve(
      { bookId: 'book', available: 0.1, reserved: 0.2, deployed: 0.3, cap: 1, updatedAt: new Date().toISOString() },
      600000n,
      6,
    )
    expect(result.reconciled).toBe(true)
  })
})
