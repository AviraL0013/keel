import type { Book, CapitalSnapshot } from '../../../../packages/domain/src/index.js'

export type AuthResponse = { address: string; chainId: number; connectedAt: string; scope: 'read' | 'trade'; token: string }
export type BookDto = Omit<Book, 'userId'>
export type PositionDto = {
  bookId: string; side: string; size: number | null; entryPrice: number | null; markPrice: number | null
  liquidationPrice: number | null; liquidationEstimated: boolean; leverage: number | null; unrealizedPnl: number | null; margin: number | null
  status: string | null; observedAt: string | null
}
export type TelemetryFreshnessPointDto = { status: 'FRESH' | 'STALE' | 'UNKNOWN'; source: string | null; updatedAt: string | null; effectiveAt?: string | null; ageMs: number | null; thresholdMs: number }
export type TelemetryFreshnessDto = { market: TelemetryFreshnessPointDto; position: TelemetryFreshnessPointDto; funding: TelemetryFreshnessPointDto; orderbook: TelemetryFreshnessPointDto; thresholdsMs: { marketMs: number; positionMs: number; fundingMs: number; orderbookMs: number } }
export type BookTelemetryDto = {
  mark: number | null; oracle: number | null; bid: number | null; ask: number | null; mid: number | null
  spreadBps: number | null; fundingRate: number | null; depthNotional: number | null; volatility: number | null
  block: number | null; timestamp: string | null; source: string | null; freshnessMs: number | null; freshness: TelemetryFreshnessDto | null
  liquidationDistance: number | null
}
export type CapitalSnapshotDto = CapitalSnapshot
export type ExecutionDto = {
  id: string; bookId: string; decisionId: string | null; kind: string; amount: number | null; status: string
  idempotencyKey: string | null; venueReference: string | null; submittedAt: string | null; confirmedAt: string | null
  failedAt: string | null; error: string | null
}
export type AutopsyEventDto = {
  id: string; bookId: string; type: string; timestamp: string
  decision: string | null; reason: string | null; action: string | null; venueResult: string | null
  postState: string | null; reserveEffect: number | null
}
export type NotificationDto = {
  id: string; kind: string; title: string; body: string; readAt: string | null; createdAt: string
}
export type RiskDto = {
  state: string; action: string; amount: number | null; reasonCodes: unknown; humanReadableReasons: unknown; riskFeatures: unknown; createdAt: string
}
export type BookRiskDto = { status: 'DECIDED' | 'NO_DECISION'; state: string | null; action: string | null; amount: number | null; reasonCodes: string[]; reasons: string[]; reasonCode: string | null; reason: string; riskFeatures: unknown; createdAt: string | null }
export type ExecutionSummaryDto = { status: string; actionId: string | null; kind: string | null; amount: number | null; venueReference: string | null; error: string | null; reason: string }
export type BookStateDto = { book: BookDto; position: PositionDto | null; telemetry: BookTelemetryDto | null; risk: BookRiskDto; execution: ExecutionSummaryDto; reserve: ReserveDto | null }
export type DecisionDto = RiskDto & { id: string; bookId: string }
export type ReserveDto = { bookId: string; available: number | null; reserved: number | null; deployed: number | null; cap: number | null; updatedAt: string | null }

export function toBookDto(book: Book): BookDto { const { userId: _userId, ...dto } = book; return dto }
