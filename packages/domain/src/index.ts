export type BookStance = 'DEFEND' | 'HARVEST' | 'KILL'
export type RiskState = 'HOLD' | 'DEFEND' | 'REDUCE' | 'EXIT' | 'SAFE_MODE'
export type ActionKind = 'DEFEND' | 'REDUCE' | 'EXIT'
export type ActionStatus = 'QUEUED' | 'VALIDATING' | 'SUBMITTING' | 'SUBMITTED' | 'VERIFYING' | 'CONFIRMED' | 'PARTIAL' | 'CANCELED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN'
export type PositionSide = 'LONG' | 'SHORT'
export type BookStatus = 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'SAFE_MODE'
export type PositionStatus = 'OPEN' | 'CLOSED' | 'LIQUIDATED' | 'DELEVERAGED' | 'UNWOUND' | 'FAILED'
export type BookPositionSeed = Omit<Position, 'bookId'>
export type BookTelemetrySeed = Omit<NormalizedTelemetry, 'source' | 'freshnessMs'> & { source?: NormalizedTelemetry['source']; freshnessMs?: number }
export type Book = { id: string; userId: string; market: string; marketId?: number; venueAccountId?: number; venuePositionId?: number; side: PositionSide; stance: BookStance; liquidationFloor: number; defenseCap: number; timeLimitMs: number; automationEnabled: boolean; status: BookStatus; createdAt: string; updatedAt: string }
export type Position = { bookId: string; side: PositionSide; size: number; entryPrice: number; markPrice: number; liquidationPrice: number; liquidationEstimated?: boolean; leverage: number; unrealizedPnl: number; margin: number; status: PositionStatus; timestamp?: number; observedAt?: number; collateralPerDistancePoint?: number }
export type Reserve = { bookId: string; available: number; reserved: number; deployed: number; cap: number; updatedAt: string }
export type FreshnessStatus = 'FRESH' | 'STALE' | 'UNKNOWN'
export type FreshnessThresholds = { marketMs: number; positionMs: number; fundingMs: number; orderbookMs: number }
export const defaultFreshnessThresholds: FreshnessThresholds = { marketMs: 10_000, positionMs: 10_000, fundingMs: 10_000, orderbookMs: 10_000 }
export type TelemetryFreshnessPoint = { status: FreshnessStatus; updatedAt?: number; ageMs?: number; thresholdMs: number }
export type TelemetryFreshness = { market: TelemetryFreshnessPoint; position: TelemetryFreshnessPoint; funding: TelemetryFreshnessPoint; orderbook: TelemetryFreshnessPoint; thresholdsMs: FreshnessThresholds }
export function freshnessPoint(updatedAt: number | undefined, now = Date.now(), thresholdMs = defaultFreshnessThresholds.marketMs): TelemetryFreshnessPoint {
  if (updatedAt === undefined || !Number.isFinite(updatedAt) || updatedAt <= 0) return { status: 'UNKNOWN', thresholdMs }
  const ageMs = now >= updatedAt ? now - updatedAt : 0
  return { status: ageMs <= thresholdMs ? 'FRESH' : 'STALE', updatedAt, ageMs, thresholdMs }
}
export function buildTelemetryFreshness(input: { marketUpdatedAt?: number; positionUpdatedAt?: number; fundingUpdatedAt?: number; orderbookUpdatedAt?: number }, now = Date.now(), thresholds = defaultFreshnessThresholds): TelemetryFreshness {
  return { market: freshnessPoint(input.marketUpdatedAt, now, thresholds.marketMs), position: freshnessPoint(input.positionUpdatedAt, now, thresholds.positionMs), funding: freshnessPoint(input.fundingUpdatedAt, now, thresholds.fundingMs), orderbook: freshnessPoint(input.orderbookUpdatedAt, now, thresholds.orderbookMs), thresholdsMs: thresholds }
}
export type NormalizedTelemetry = { mark: number; oracle: number; bid: number; ask: number; mid: number; spreadBps: number; fundingRate: number; depthNotional: number; volatility: number; volume24h: number; openInterest: number; block: number; timestamp: number; marketTimestamp?: number; positionTimestamp?: number; fundingTimestamp?: number; orderbookTimestamp?: number; combinedTimestamp?: number; marketFreshnessMs?: number; positionFreshnessMs?: number; fundingFreshnessMs?: number; orderbookFreshnessMs?: number; freshness?: TelemetryFreshness; source: 'perpl-rest' | 'perpl-ws' | 'replay'; freshnessMs: number; executionHealthy?: boolean }
export type TelemetrySnapshot = NormalizedTelemetry
export type CapitalSnapshot = { status: 'VALID' | 'UNAVAILABLE'; accountId?: number; ausdBalance: string | null; perplAvailable: string | null; perplLocked: string | null; bookReserved: string | null; bookDeployed: string | null; bookRemaining: string | null; unreservedCapital: string | null; ausd?: { raw: string; decimals: number; symbol: string; token: string; chainId: number }; agora?: Record<string, unknown> }
export type RiskFeatures = { liquidationDistance: number; fundingPressure: number; spreadBps: number; depthCoverage: number; volatility: number; reserveHeadroom: number; capUtilization: number; timeRemainingMs: number; defenseEfficiency: number; fresh: boolean }
export type Decision = { id: string; bookId: string; state: RiskState; action: ActionKind | 'HOLD' | 'SAFE_MODE'; amount: number; reasonCodes: string[]; humanReadableReasons: string[]; riskFeatures: RiskFeatures; createdAt: string }
export type Action = { id: string; bookId: string; decisionId: string; kind: ActionKind; amount: number; status: ActionStatus; idempotencyKey: string; beforeState?: { position: Position; reserve: Reserve; telemetry: NormalizedTelemetry }; venueReference?: string; submittedAt?: string; confirmedAt?: string; failedAt?: string; error?: string }
export type AutopsyEvent = { id: string; bookId: string; type: string; payload: Record<string, unknown>; block?: number; timestamp: string; decision?: Decision; action?: Action; venueResult?: Record<string, unknown>; postState?: Record<string, unknown>; reserveEffect?: Record<string, unknown> }
