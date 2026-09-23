import { buildTelemetryFreshness, type Book, type Decision, type NormalizedTelemetry, type Position, type Reserve } from '../../../packages/domain/src/index.js'
import { evaluate } from '../../../packages/risk-engine/src/index.js'

type Point = { status: string; updatedAt: string | number | null; ageMs: number | null }
type SnapshotPosition = { size: number | null; entryPrice: number | null; markPrice: number | null; liquidationPrice: number | null; leverage: number | null; unrealizedPnl: number | null; margin: number | null; status: string | null }
type SnapshotTelemetry = { mark: number | null; oracle: number | null; bid: number | null; ask: number | null; mid: number | null; spreadBps: number | null; fundingRate: number | null; depthNotional: number | null; volatility: number | null; block: number | null; freshness: { market: Point; position: Point; funding: Point; orderbook: Point } | null }
type SnapshotReserve = { available: number | null; reserved: number | null; deployed: number | null; cap: number | null }

/** Read-only evaluation of the exact snapshot sent to the dashboard. No execution or lifecycle mutation. */
export function evaluateBookSnapshot(book: Book, position: SnapshotPosition | null, telemetry: SnapshotTelemetry | null, reserve: SnapshotReserve | null, priorEfficiency: number, executionHealthy: boolean, now = Date.now()): Decision | null {
  if (!position || !telemetry || !reserve) return null
  const value = (input: number | null) => input ?? Number.NaN
  const at = (point?: Point) => point?.updatedAt ? (typeof point.updatedAt === 'number' ? point.updatedAt : Date.parse(point.updatedAt)) : Number.NaN
  const sources = telemetry.freshness
  const timestamp = at(sources?.market)
  const normalizedPosition: Position = { bookId: book.id, side: book.side, size: value(position.size), entryPrice: value(position.entryPrice), markPrice: value(telemetry.mark), liquidationPrice: value(position.liquidationPrice), leverage: value(position.leverage), unrealizedPnl: value(position.unrealizedPnl), margin: value(position.margin), status: position.status as Position['status'], timestamp: at(sources?.position) }
  const normalizedReserve: Reserve = { bookId: book.id, available: value(reserve.available), reserved: value(reserve.reserved), deployed: value(reserve.deployed), cap: value(reserve.cap), updatedAt: new Date(now).toISOString() }
  const normalizedTelemetry: NormalizedTelemetry = { mark: value(telemetry.mark), oracle: value(telemetry.oracle), bid: value(telemetry.bid), ask: value(telemetry.ask), mid: value(telemetry.mid), spreadBps: value(telemetry.spreadBps), fundingRate: value(telemetry.fundingRate), depthNotional: value(telemetry.depthNotional), volatility: value(telemetry.volatility), block: value(telemetry.block), timestamp, marketTimestamp: timestamp, positionTimestamp: at(sources?.position), fundingTimestamp: at(sources?.funding), orderbookTimestamp: at(sources?.orderbook), freshness: sources ? buildTelemetryFreshness({ marketUpdatedAt: at(sources.market), positionUpdatedAt: at(sources.position), fundingUpdatedAt: at(sources.funding), orderbookUpdatedAt: at(sources.orderbook) }, now) : undefined, freshnessMs: now - timestamp, volume24h: 0, openInterest: 0, source: 'perpl-ws', executionHealthy }
  const decision = evaluate(book, normalizedPosition, normalizedReserve, normalizedTelemetry, priorEfficiency, now)
  if (decision.reasonCodes.includes('STALE_STATE') && sources) {
    const staleSources = (['market', 'position', 'funding', 'orderbook'] as const).filter(key => sources[key].status !== 'FRESH')
    if (staleSources.length) {
      const labels = staleSources.map(source => source === 'orderbook' ? 'depth' : source)
      return { ...decision, humanReadableReasons: [`${labels.join(', ')} telemetry is ${staleSources.some(source => sources[source].status === 'UNKNOWN') ? 'unavailable' : 'stale'}.`] }
    }
  }
  return decision
}
