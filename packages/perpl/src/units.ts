import Decimal from 'decimal.js'

export function decodeScaled(value: number, decimals: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('INVALID_SCALE')
  return new Decimal(value).div(new Decimal(10).pow(decimals)).toNumber()
}

export function encodeScaled(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('INVALID_SCALE')
  const scaled = new Decimal(value).mul(new Decimal(10).pow(decimals)).toDecimalPlaces(0, Decimal.ROUND_HALF_DOWN)
  if (!scaled.isInteger() || !scaled.isFinite() || scaled.gt(Number.MAX_SAFE_INTEGER)) throw new Error('SCALED_VALUE_UNSAFE')
  return scaled.toNumber()
}

export const decodePrice = decodeScaled
export const decodeSize = decodeScaled
export const encodePrice = encodeScaled
export const encodeSize = encodeScaled

/** Protocol Amount is an integer base-unit decimal string. Keep exact decimal text at boundaries. */
export function decodeAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('INVALID_AMOUNT')
  return new Decimal(raw).div(new Decimal(10).pow(decimals)).toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

export function encodeAmount(human: string, decimals: number): string {
  if (!/^\d+(?:\.\d+)?$/.test(human) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('INVALID_AMOUNT')
  const raw = new Decimal(human).mul(new Decimal(10).pow(decimals))
  if (!raw.isInteger()) throw new Error('AMOUNT_PRECISION_EXCEEDED')
  return raw.toFixed(0)
}
