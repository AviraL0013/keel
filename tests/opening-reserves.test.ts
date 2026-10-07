import { expect, it } from 'vitest'
import { assertOpeningReserveCoverage } from '../server/src/application/opening-reserves.js'

it('accepts the exact six-decimal reserve boundary and refuses one micro below it', () => {
  expect(assertOpeningReserveCoverage('30.151271', '20.151271', ['4.000000', '6.000000'])).toBe('10.000000')
  expect(() => assertOpeningReserveCoverage('30.151270', '20.151271', ['4.000000', '6.000000'])).toThrow(
    'OPENING_WOULD_UNDERFUND_BOOK_RESERVES',
  )
  expect(() => assertOpeningReserveCoverage('20.151270', '20.151271', [])).toThrow('PERPL_FREE_BALANCE_INSUFFICIENT')
})

it('fails closed on unreadable or over-precise money', () => {
  for (const value of ['NaN', '-1', '1.0000001', ''])
    expect(() => assertOpeningReserveCoverage(value, '1.000000', [])).toThrow('PERPL_FREE_BALANCE_UNAVAILABLE')
})
