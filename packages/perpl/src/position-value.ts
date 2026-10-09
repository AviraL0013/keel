/** Pinned SDK position.rs effective_entry_price, revision 01b9910761755b0a0d9c710c1ede62ab937daa7d.
 * This reconstructs venue entry residue. It does not attribute a position to a strategy.
 */
export const POSITION_Q16 = 65536n
export function positionEntryQ16(side: number, pricePNS: bigint, residue: bigint): bigint {
  if (
    ![0, 1].includes(side) ||
    typeof pricePNS !== 'bigint' ||
    pricePNS < 0n ||
    pricePNS >= 1n << 256n ||
    typeof residue !== 'bigint' ||
    residue < 0n ||
    residue >= POSITION_Q16
  )
    throw Error('POSITION_ENTRY_UNVERIFIED')
  const whole = side === 0 && residue > 0n && pricePNS >= 1n ? pricePNS - 1n : pricePNS
  return whole * POSITION_Q16 + residue
}

export function effectivePositionEntry(side: number, pricePNS: bigint, residue: bigint, priceDecimals: number): string {
  if (!Number.isSafeInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 18)
    throw Error('POSITION_ENTRY_PRECISION_INVALID')
  // Q16's denominator has only factors of two: multiplying by 5^16 gives an exact terminating decimal.
  const raw = positionEntryQ16(side, pricePNS, residue) * 5n ** 16n
  const decimals = priceDecimals + 16,
    scale = 10n ** BigInt(decimals)
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${raw / scale}${fraction ? '.' + fraction : ''}`
}
