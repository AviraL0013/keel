import { formatMoney, moneyMicros } from '../../../packages/ausd/src/money.js'

function exact(value: string, error: string): bigint {
  if (!/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error(error)
  try {
    return moneyMicros(value)
  } catch {
    throw new Error(error)
  }
}

/** Account free collateral must cover the new opening and every ACTIVE Book's available reserve. */
export function assertOpeningReserveCoverage(free: string, required: string, availableReserves: string[]): string {
  const balance = exact(free, 'PERPL_FREE_BALANCE_UNAVAILABLE')
  const cost = exact(required, 'PERPL_OPEN_COLLATERAL_INVALID')
  if (balance < cost) throw new Error('PERPL_FREE_BALANCE_INSUFFICIENT')
  let promised = 0n
  for (const reserve of availableReserves) promised += exact(reserve, 'OPENING_RESERVES_UNAVAILABLE')
  const after = balance - cost
  if (after < promised) throw new Error('OPENING_WOULD_UNDERFUND_BOOK_RESERVES')
  return formatMoney(after)
}
