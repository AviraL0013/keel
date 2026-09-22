import { buildTelemetryFreshness, type TelemetryFreshness } from '../../../../packages/domain/src/index.js'

/** Re-age persisted observations. A saved FRESH status is never a new observation. */
export function storedTelemetryFreshness(detail: unknown, now = Date.now()): TelemetryFreshness | undefined {
  if (!detail || typeof detail !== 'object') return undefined
  const value = detail as Record<string, unknown>
  const timestamp = (source: string): number | undefined => {
    const point = value[source]
    if (!point || typeof point !== 'object') return undefined
    const raw = (point as Record<string, unknown>).updatedAt
    if (raw == null) return undefined
    const time = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? Number(raw) : Date.parse(String(raw))
    return Number.isFinite(time) && time > 0 ? time : undefined
  }
  const freshness = buildTelemetryFreshness({ marketUpdatedAt: timestamp('market'), positionUpdatedAt: timestamp('position'), fundingUpdatedAt: timestamp('funding'), orderbookUpdatedAt: timestamp('orderbook') }, now)
  const funding = value.funding
  if (funding && typeof funding === 'object') {
    const effectiveAt = (funding as Record<string, unknown>).effectiveAt
    if (effectiveAt != null) {
      const parsed = typeof effectiveAt === 'number' ? effectiveAt : Date.parse(String(effectiveAt))
      if (Number.isFinite(parsed) && parsed > 0) freshness.funding.effectiveAt = parsed
    }
  }
  return freshness
}
