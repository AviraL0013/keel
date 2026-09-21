import { describe, expect, it } from 'vitest'
import { normalizePerplBalance } from '../packages/perpl/src/index.js'

describe('Perpl capital normalization', () => {
  it('converts raw six-decimal collateral at the adapter boundary', () => {
    const balance = normalizePerplBalance('99457410', '0', 6, 1_800_000_000_000)
    expect(balance.available).toBe('99.457410')
    expect(balance.locked).toBe('0.000000')
    expect(balance.decimals).toBe(6)
    expect(balance.updatedAt).toBe(1_800_000_000_000)
  })

  it('preserves large, zero, and fractional balances without Number scaling', () => {
    expect(normalizePerplBalance('10000000000', '0', 6).available).toBe('10000.000000')
    expect(normalizePerplBalance('0', '123456', 6)).toMatchObject({ available: '0.000000', locked: '0.123456' })
    expect(normalizePerplBalance('9007199254740991', '1', 6).available).toBe('9007199254.740991')
  })
})
