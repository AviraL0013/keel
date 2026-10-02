import { formatMoney, moneyMicros } from '../../../../packages/ausd/src/money.js'

/** Global public supply is context only, never wallet balance or Book collateral. */
export function publicAusdSupply(value: Record<string, unknown>) {
  if (value.partial === true) return { status: 'UNAVAILABLE' as const, reason: 'AGORA_METRICS_PARTIAL' }
  if (typeof value.totalSupply !== 'string') return { status: 'UNAVAILABLE' as const, reason: 'AGORA_METRICS_INVALID' }
  try {
    return {
      status: 'AVAILABLE' as const,
      scope: 'GLOBAL_AUSD' as const,
      supply: formatMoney(moneyMicros(value.totalSupply)),
      checkedAt: new Date().toISOString(),
    }
  } catch {
    return { status: 'UNAVAILABLE' as const, reason: 'AGORA_METRICS_INVALID' }
  }
}
