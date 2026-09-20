import { describe, expect, it } from 'vitest'
import { decodePrice, decodeSize, encodePrice, encodeSize, decodeAmount, encodeAmount } from '../packages/perpl/src/units.js'
import { mapPerplOrderStatus } from '../packages/perpl/src/trading.js'

describe('Perpl scaled numeric units', () => {
  it('round trips documented BTC price and size scales', () => {
    expect(decodePrice(950000, 1)).toBe(95000)
    expect(encodePrice(95000, 1)).toBe(950000)
    expect(decodeSize(10000, 5)).toBe(0.1)
    expect(encodeSize(0.1, 5)).toBe(10000)
  })
  it('does not double scale values', () => {
    const human = decodeSize(123456, 5)
    expect(encodeSize(human, 5)).toBe(123456)
  })
  it('keeps collateral exact at token decimals', () => {
    expect(decodeAmount('1234567', 6)).toBe('1.234567')
    expect(encodeAmount('1.234567', 6)).toBe('1234567')
  })
  it.each([[1, 'SUBMITTED'], [2, 'CONFIRMED'], [3, 'PARTIAL'], [4, 'CONFIRMED'], [5, 'CANCELED'], [6, 'EXPIRED'], [7, 'FAILED'], [8, 'CONFIRMED'], [9, 'CONFIRMED'], [10, 'CONFIRMED']] as const)('maps vendor order status %s', (wire, expected) => {
    expect(mapPerplOrderStatus(wire)).toBe(expected)
  })
})
