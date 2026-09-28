import Decimal from 'decimal.js'

export const AUSD_DECIMALS = 6
const SCALE = 1_000_000n
export type MoneyInput = string | number

/** Reject sub-micro amounts; never round a spend or a credit silently. */
export function moneyMicros(value: MoneyInput): bigint {
  // Above this display boundary, a JS number cannot safely carry every micro-unit.
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000))
    throw new Error('INVALID_AUSD_AMOUNT')
  try {
    const amount = new Decimal(value)
    const scaled = amount.mul(SCALE.toString())
    if (!amount.isFinite() || amount.isNegative() || !scaled.isInteger()) throw new Error('INVALID_AUSD_AMOUNT')
    return BigInt(scaled.toFixed(0))
  } catch {
    throw new Error('INVALID_AUSD_AMOUNT')
  }
}

export function formatMoney(micros: bigint): string {
  if (micros < 0n) throw new Error('INVALID_AUSD_AMOUNT')
  const whole = micros / SCALE
  const fractional = (micros % SCALE).toString().padStart(AUSD_DECIMALS, '0')
  return `${whole}.${fractional}`
}

export function canonicalMoney(micros: bigint): string {
  return formatMoney(micros)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1')
}

export function reserveHeadroom(
  available: MoneyInput,
  deployed: MoneyInput,
  reserved: MoneyInput,
  cap: MoneyInput,
): string {
  const free = moneyMicros(cap) - moneyMicros(deployed) - moneyMicros(reserved)
  return formatMoney([moneyMicros(available), free < 0n ? 0n : free].reduce((a, b) => (a < b ? a : b)))
}
