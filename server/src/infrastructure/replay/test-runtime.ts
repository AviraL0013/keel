import { randomUUID } from 'node:crypto'
import { buildTelemetryFreshness, type Action, type Book, type BookPositionSeed, type BookTelemetrySeed, type Decision } from '../../../../packages/domain/src/index.js'
import { evaluate } from '../../../../packages/risk-engine/src/index.js'
import type { RuntimeVenue } from '../../runtime.js'
import type { ExecutionRepository } from '../../workers/execution-worker.js'
import { ExecutionWorker } from '../../workers/execution-worker.js'
import { MemoryStore } from '../../memoryStore.js'

const ACCOUNT_ID = 7001
const MARKET_ID = 1
const POSITION_ID = 11

export class DeterministicTestVenue implements RuntimeVenue {
  private readonly position: BookPositionSeed = { side: 'LONG', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 94, leverage: 5, unrealizedPnl: 0, margin: 20, status: 'OPEN' }
  private readonly telemetry: BookTelemetrySeed = { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, spreadBps: 20, fundingRate: 0.0001, depthNotional: 10_000, volatility: 0.01, volume24h: 50_000, openInterest: 100_000, block: 1, timestamp: Date.now(), source: 'replay', freshnessMs: 1 }
  private currentPosition = { ...this.position }
  private currentTelemetry = { ...this.telemetry, source: 'replay' as const, freshnessMs: 1 }
  constructor(private readonly store: MemoryStore) {}
  private telemetrySnapshot() { const now = Date.now(); const updatedAt = this.currentTelemetry.timestamp; return { ...this.currentTelemetry, freshness: buildTelemetryFreshness({ marketUpdatedAt: updatedAt, positionUpdatedAt: this.currentPosition.timestamp ?? now, fundingUpdatedAt: updatedAt, orderbookUpdatedAt: updatedAt }, now) } }
  ready() { return true }
  async start() {}
  async close() {}
  async validate() { return 'VALID' as const }
  async listPositions() { const telemetry = this.telemetrySnapshot(); return [{ marketId: MARKET_ID, market: 'BTC-PERP', accountId: ACCOUNT_ID, positionId: POSITION_ID, position: { ...this.currentPosition }, telemetry, bookCreation: { allowed: telemetry.freshness.market.status === 'FRESH' && telemetry.freshness.position.status === 'FRESH', code: 'READY' as const, reason: 'Live market and position telemetry are within the configured safety threshold.', market: telemetry.freshness.market, position: telemetry.freshness.position } }] }
  async loadBookSetup(marketId: number, accountId: number, positionId: number) {
    if (marketId !== MARKET_ID || accountId !== ACCOUNT_ID || positionId !== POSITION_ID) throw new Error('TEST_POSITION_NOT_FOUND')
    return { market: 'BTC-PERP', position: { ...this.currentPosition }, telemetry: this.telemetrySnapshot(), reserveAvailable: 600 }
  }
  async capital() {
    const amount = (value: string | null, source: string, availability: 'AVAILABLE' | 'UNAVAILABLE' = value === null ? 'UNAVAILABLE' : 'AVAILABLE', reason?: string) => ({ amount: value, asset: 'AUSD', decimals: 6, source, availability, freshness: value === null ? 'UNKNOWN' as const : 'FRESH' as const, ...(reason ? { reason } : {}) })
    return { status: 'VALID' as const, accountId: ACCOUNT_ID, walletAusd: amount('1000.00', 'TEST_WALLET'), perplAvailable: amount('600.00', 'TEST_PERPL'), perplLocked: amount('100.00', 'TEST_PERPL'), bookReserved: amount(null, 'TEST_LEDGER', 'UNAVAILABLE', 'NO_BOOKS'), bookDeployed: amount(null, 'TEST_LEDGER', 'UNAVAILABLE', 'NO_BOOKS'), bookRemaining: amount(null, 'TEST_LEDGER', 'UNAVAILABLE', 'NO_BOOKS'), unreservedCapital: amount('500.00', 'TEST_LEDGER') }
  }
  async refresh(book: Book) {
    const current = { ...this.currentPosition, markPrice: this.currentTelemetry.mark, unrealizedPnl: (this.currentTelemetry.mark - this.position.entryPrice) * this.position.size, timestamp: Date.now() }
    this.currentPosition = current
    this.store.setPosition(book.id, { ...current, bookId: book.id })
    this.store.setTelemetry(book.id, { ...this.telemetrySnapshot(), timestamp: Date.now(), freshnessMs: 1 })
  }
  async submit(action: Action) { return { venueReference: `test-order-${action.id}`, status: 'CONFIRMED' as const } }
  async reconcile(action: Action) { return { ...action, status: 'CONFIRMED' as const, confirmedAt: new Date().toISOString() } }
  setScenario(scenario: string) {
    const base = this.currentTelemetry
    if (scenario === 'healthy') this.currentTelemetry = { ...base, mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, depthNotional: 10_000, spreadBps: 20, volatility: 0.01, freshnessMs: 1, timestamp: Date.now() }
    else if (scenario === 'floor-breach') this.currentTelemetry = { ...base, mark: 98, oracle: 98, bid: 97.9, ask: 98.1, mid: 98, freshnessMs: 1, timestamp: Date.now() }
    else if (scenario === 'deterioration') this.currentTelemetry = { ...base, mark: 98, oracle: 98, bid: 96, ask: 100, mid: 98, spreadBps: 408, depthNotional: 100, volatility: 0.25, freshnessMs: 1, timestamp: Date.now() }
    else if (scenario === 'stale') this.currentTelemetry = { ...base, freshnessMs: 20_000, timestamp: Date.now() - 20_000 }
    else throw new Error('TEST_SCENARIO_NOT_FOUND')
  }
}

class MemoryExecutionRepository implements ExecutionRepository {
  constructor(private readonly store: MemoryStore) {}
  async getActionByIdempotency(key: string) { for (const book of this.store.listAllBooks()) { const action = this.store.getActions(book.id).find(item => item.idempotencyKey === key); if (action) return action } return null }
  async getActiveAction(bookId: string) { return this.store.getActions(bookId).find(item => !['CONFIRMED', 'PARTIAL', 'CANCELED', 'EXPIRED', 'FAILED', 'UNKNOWN'].includes(item.status)) ?? null }
  async saveAction(action: Action) { this.store.addAction(action) }
  async saveDecision(decision: Decision) { this.store.addDecision(decision) }
  async addEvent(event: { id: string; bookId: string; type: string; payload: Record<string, unknown>; timestamp: string }) { await this.store.addMemoryEvent(event.bookId, event.type, event.payload) }
  async getBookContext(bookId: string) {
    const book = this.store.getAnyBook(bookId); const position = this.store.getPosition(bookId); const telemetry = this.store.getTelemetry(bookId); const reserve = this.store.getReserveMemory(bookId)
    if (!book || !position || !telemetry || !reserve) throw new Error('TEST_BOOK_CONTEXT_UNAVAILABLE')
    return { book, position, telemetry, reserve, priorDefenseEfficiency: Infinity }
  }
  async finalize(action: Action) { this.store.addAction(action); if (action.status === 'CONFIRMED' && action.kind === 'DEFEND') this.store.updateReserve(action.bookId, action.amount); await this.store.addMemoryEvent(action.bookId, `${action.kind}_${action.status}`, { actionId: action.id, venueReference: action.venueReference, amount: action.amount }) }
  async updateReserve(bookId: string, amount: number) { this.store.updateReserve(bookId, amount) }
}

export class DeterministicTestRuntime {
  readonly venue: DeterministicTestVenue
  private readonly repository: MemoryExecutionRepository
  constructor(private readonly store: MemoryStore) { this.venue = new DeterministicTestVenue(store); this.repository = new MemoryExecutionRepository(store) }
  async executeAction(userId: string, bookId: string, kind: 'DEFEND' | 'REDUCE') {
    const book = await this.store.getBook(userId, bookId); if (!book) throw new Error('BOOK_NOT_FOUND')
    await this.venue.refresh(book)
    const context = await this.repository.getBookContext(bookId)
    const decision = evaluate(context.book, context.position, context.reserve, context.telemetry, context.priorDefenseEfficiency, Date.now())
    if (decision.action !== kind) throw new Error('POLICY_REJECTED')
    const withId: Decision = { ...decision, id: randomUUID() }
    await this.repository.saveDecision(withId)
    return this.result(await new ExecutionWorker(this.repository, this.venue, current => this.venue.refresh(current)).execute(withId))
  }
  async closeBook(userId: string, bookId: string) {
    const book = await this.store.getBook(userId, bookId); if (!book) throw new Error('BOOK_NOT_FOUND')
    await this.venue.refresh(book)
    const context = await this.repository.getBookContext(bookId)
    const decision: Decision = { ...evaluate({ ...context.book, stance: 'KILL', automationEnabled: true, status: 'ACTIVE' }, context.position, context.reserve, context.telemetry), id: randomUUID(), state: 'EXIT', action: 'EXIT', reasonCodes: ['USER_CLOSE'], humanReadableReasons: ['User requested a reduce-only position close.'], amount: 0 }
    await this.repository.saveDecision(decision)
    return this.result(await new ExecutionWorker(this.repository, this.venue, current => this.venue.refresh(current)).execute(decision, true))
  }
  private result(action: Action | Decision) { return 'status' in action ? { actionId: action.id, status: action.status } : { actionId: action.id, status: action.state } }
}
