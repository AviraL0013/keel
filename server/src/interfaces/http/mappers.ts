import type { AutopsyEventDto, BookTelemetryDto, DecisionDto, ExecutionDto, NotificationDto, PositionDto, ReserveDto, RiskDto } from './dto.js'

const number = (value: unknown): number | null => value == null ? null : Number(value)
const text = (value: unknown): string | null => value == null ? null : String(value)
export function toPositionDto(row: Record<string, unknown>, side: string): PositionDto {
  return { bookId: String(row.book_id), side, size: number(row.size), entryPrice: number(row.entry_price), markPrice: number(row.mark_price), liquidationPrice: number(row.liquidation_price), leverage: number(row.leverage), unrealizedPnl: number(row.unrealized_pnl), margin: number(row.margin), status: text(row.status), observedAt: text(row.observed_at) }
}
export function toTelemetryDto(row: Record<string, unknown>): BookTelemetryDto {
  return { mark: number(row.mark), oracle: number(row.oracle), bid: number(row.bid), ask: number(row.ask), mid: number(row.mid), spreadBps: number(row.spread), fundingRate: number(row.funding), depthNotional: number(row.depth), volatility: number(row.volatility), block: number(row.block), timestamp: text(row.timestamp), source: text(row.source), freshnessMs: number(row.freshness) }
}
export function toRiskDto(row: Record<string, unknown>): RiskDto {
  return { state: String(row.state), action: String(row.action), amount: number(row.amount), reasonCodes: row.reason_codes, humanReadableReasons: row.human_readable_reasons, riskFeatures: row.risk_features, createdAt: String(row.created_at) }
}
export function toAutopsyDto(row: Record<string, unknown>): AutopsyEventDto { const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {}; const reasons = Array.isArray(payload.humanReadableReasons) ? payload.humanReadableReasons.join(' ') : null; return { id: String(row.id), bookId: String(row.book_id), type: String(row.type), timestamp: String(row.timestamp), decision: text(payload.state), reason: reasons, action: text(payload.action), venueResult: text(payload.venueReference ?? payload.error), postState: text(payload.postState), reserveEffect: number(payload.amount) } }
export function toActionDto(row: Record<string, unknown>): ExecutionDto { return { id: String(row.id), bookId: String(row.book_id), decisionId: text(row.decision_id), kind: String(row.kind), amount: number(row.amount), status: String(row.status), idempotencyKey: text(row.idempotency_key), venueReference: text(row.venue_reference), submittedAt: text(row.submitted_at), confirmedAt: text(row.confirmed_at), failedAt: text(row.failed_at), error: text(row.error) } }
export function toDecisionDto(row: Record<string, unknown>): DecisionDto { return { id: String(row.id), bookId: String(row.book_id), state: String(row.state), action: String(row.action), amount: number(row.amount), reasonCodes: row.reason_codes, humanReadableReasons: row.human_readable_reasons, riskFeatures: row.risk_features, createdAt: String(row.created_at) } }
export function toReserveDto(row: Record<string, unknown>): ReserveDto { return { bookId: String(row.book_id), available: number(row.available), reserved: number(row.reserved), deployed: number(row.deployed), cap: number(row.cap), updatedAt: text(row.updated_at) } }
export function toNotificationDto(row: Record<string, unknown>): NotificationDto { return { id: String(row.id), kind: String(row.kind), title: String(row.title), body: String(row.body), readAt: text(row.read_at), createdAt: String(row.created_at) } }
