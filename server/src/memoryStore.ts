import type { Action, Book, Decision, NormalizedTelemetry, Position, Reserve } from '../../packages/domain/src/index.js'
import type { Store, StoredSession, CreateBookInput } from './infrastructure/database/postgres-store.js'
import { validateBookControls } from './bookControls.js'
export class MemoryStore implements Store {
  private readonly books = new Map<string, Book>();
  private readonly positions = new Map<string, Position>();
  private readonly telemetry = new Map<string, NormalizedTelemetry>();
  private readonly reserves = new Map<string, Reserve>();
  private readonly decisions = new Map<string, Decision[]>();
  private readonly actions = new Map<string, Action[]>();
  private readonly autopsy = new Map<string, Array<Record<string, unknown>>>();
  private readonly notifications = new Map<string, Array<Record<string, unknown>>>();
  private readonly challenges = new Map<string, { nonce: string; expiresAt: number; message: string }>();
  private readonly sessions = new Map<string, StoredSession>();

  async ensureUser(walletAddress: string) { return walletAddress.toLowerCase() }
  async createSession(token: string, session: StoredSession) { this.sessions.set(token, session) }
  async getSession(token: string) { const value = this.sessions.get(token); return value && value.expiresAt > Date.now() ? value : null }
  async revokeSession(token: string) { this.sessions.delete(token) }
  async updateBookControls(userId: string, bookId: string, patch: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] }) {
    const book = await this.getBook(userId, bookId); if (!book) return null
    validateBookControls(book, patch)
    if (patch.automationEnabled === true && (!book.marketId || !book.venueAccountId || !book.venuePositionId)) throw new Error('BOOK_NOT_ARMABLE')
    Object.assign(book, patch, { updatedAt: new Date().toISOString() })
    await this.addMemoryEvent(bookId, patch.stance === 'KILL' ? 'USER_KILL' : patch.status === 'PAUSED' ? 'USER_PAUSED' : 'BOOK_UPDATED', patch)
    return book
  }
  async createBook(userId: string, input: CreateBookInput) {
    const now = new Date().toISOString()
    const bound = Boolean(input.initialPosition && input.initialTelemetry && input.marketId && input.venueAccountId && input.venuePositionId)
    if (input.automationEnabled && !bound) throw new Error('BOOK_POSITION_BINDING_REQUIRED')
    const reserveAvailable = input.reserveAvailable ?? 0
    if (!Number.isFinite(reserveAvailable) || reserveAvailable < 0) throw new Error('INVALID_BOOK_RESERVE')
    if (!Number.isFinite(input.defenseCap) || input.defenseCap <= 0 || input.defenseCap > reserveAvailable) throw new Error('Defense cap cannot exceed reserve.')
    const book: Book = { ...input, automationEnabled: bound && input.automationEnabled, status: bound ? input.status : 'PAUSED', id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now }
    this.books.set(book.id, book)
    this.reserves.set(book.id, { bookId: book.id, available: reserveAvailable, reserved: 0, deployed: 0, cap: reserveAvailable, updatedAt: now })
    if (input.initialPosition) this.positions.set(book.id, { ...input.initialPosition, bookId: book.id })
    if (input.initialTelemetry) this.telemetry.set(book.id, { ...input.initialTelemetry, source: input.initialTelemetry.source ?? 'replay', freshnessMs: input.initialTelemetry.freshnessMs ?? 1 })
    await this.addMemoryEvent(book.id, 'BOOK_CREATED', { bookId: book.id })
    return book
  }
  async getBook(userId: string, bookId: string) { const book = this.books.get(bookId); return book?.userId === userId ? book : null }
  getAnyBook(bookId: string) { return this.books.get(bookId) }
  listAllBooks() { return [...this.books.values()] }
  async listBooks(userId: string) { return [...this.books.values()].filter(book => book.userId === userId) }
  async getPositionRow(userId: string, bookId: string) { const book = await this.getBook(userId, bookId); const position = book ? this.positions.get(bookId) : undefined; return position ? this.positionRow(position) : null }
  async getTelemetryRow(userId: string, bookId: string) { const book = await this.getBook(userId, bookId); const value = book ? this.telemetry.get(bookId) : undefined; return value ? this.telemetryRow(value) : null }
  async getRiskRow(userId: string, bookId: string) { const book = await this.getBook(userId, bookId); const value = book ? this.decisions.get(bookId)?.at(-1) : undefined; return value ? this.riskRow(value) : null }
  async revokeConnection() { return undefined }
  async registerDevice() { return undefined }
  async listAutopsy(userId: string, bookId: string) { return (await this.getBook(userId, bookId)) ? [...(this.autopsy.get(bookId) ?? [])].reverse() : [] }
  async listDecisions(userId: string, bookId: string) { return (await this.getBook(userId, bookId)) ? [...(this.decisions.get(bookId) ?? [])].reverse() : [] }
  async listActions(userId: string, bookId: string) { return (await this.getBook(userId, bookId)) ? [...(this.actions.get(bookId) ?? [])].reverse().map(action => this.actionRow(action)) : [] }
  async getReserve(userId: string, bookId: string) { return (await this.getBook(userId, bookId)) ? this.reserves.get(bookId) ?? null : null }
  async createChallenge(address: string, nonce: string, expiresAt: number, message: string) { this.challenges.set(address.toLowerCase(), { nonce, expiresAt, message }) }
  async consumeChallenge(address: string, nonce: string, message: string) { const value = this.challenges.get(address.toLowerCase()); if (!value || value.nonce !== nonce || value.message !== message || value.expiresAt <= Date.now()) return false; this.challenges.delete(address.toLowerCase()); return true }

  setPosition(bookId: string, position: Position) { this.positions.set(bookId, position) }
  setTelemetry(bookId: string, value: NormalizedTelemetry) { this.telemetry.set(bookId, value) }
  getPosition(bookId: string) { return this.positions.get(bookId) }
  getTelemetry(bookId: string) { return this.telemetry.get(bookId) }
  getReserveMemory(bookId: string) { return this.reserves.get(bookId) }
  addDecision(decision: Decision) {
    this.decisions.set(decision.bookId, [...(this.decisions.get(decision.bookId) ?? []), decision])
    if (decision.state !== 'HOLD') {
      const book = this.books.get(decision.bookId)
      if (book) this.notifications.set(book.userId, [...(this.notifications.get(book.userId) ?? []), { id: crypto.randomUUID(), kind: decision.state, title: decision.state, body: decision.humanReadableReasons.join(' '), read_at: null, created_at: decision.createdAt }])
    }
  }
  addAction(action: Action) { this.actions.set(action.bookId, [...(this.actions.get(action.bookId) ?? []).filter(item => item.id !== action.id), action]) }
  getAction(bookId: string, id: string) { return this.actions.get(bookId)?.find(action => action.id === id) }
  getActions(bookId: string) { return this.actions.get(bookId) ?? [] }
  updateReserve(bookId: string, amount: number) { const reserve = this.reserves.get(bookId); if (!reserve) return; this.reserves.set(bookId, { ...reserve, available: Math.max(0, reserve.available - amount), deployed: reserve.deployed + amount, updatedAt: new Date().toISOString() }) }
  async addMemoryEvent(bookId: string, type: string, payload: Record<string, unknown>) { this.autopsy.set(bookId, [...(this.autopsy.get(bookId) ?? []), { id: crypto.randomUUID(), book_id: bookId, type, payload, timestamp: new Date().toISOString() }]) }
  listNotifications(userId: string) { return this.notifications.get(userId) ?? [] }
  markNotificationRead(userId: string, id: string) { const rows = this.notifications.get(userId) ?? []; for (const row of rows) if (row.id === id) row.read_at = new Date().toISOString() }

  private positionRow(value: Position): Record<string, unknown> { return { book_id: value.bookId, side: value.side, size: value.size, entry_price: value.entryPrice, mark_price: value.markPrice, liquidation_price: value.liquidationPrice, leverage: value.leverage, unrealized_pnl: value.unrealizedPnl, margin: value.margin, status: value.status, observed_at: new Date(value.timestamp ?? Date.now()).toISOString() } }
  private telemetryRow(value: NormalizedTelemetry): Record<string, unknown> { return { mark: value.mark, oracle: value.oracle, bid: value.bid, ask: value.ask, mid: value.mid, spread: value.spreadBps, funding: value.fundingRate, depth: value.depthNotional, volatility: value.volatility, block: value.block, timestamp: new Date(value.timestamp).toISOString(), source: value.source, freshness: value.freshnessMs } }
  private riskRow(value: Decision): Record<string, unknown> { return { state: value.state, action: value.action, amount: value.amount, reason_codes: value.reasonCodes, human_readable_reasons: value.humanReadableReasons, risk_features: value.riskFeatures, created_at: value.createdAt } }
  private actionRow(value: Action): Record<string, unknown> { return { id: value.id, book_id: value.bookId, decision_id: value.decisionId, kind: value.kind, amount: value.amount, status: value.status, idempotency_key: value.idempotencyKey, venue_reference: value.venueReference, submitted_at: value.submittedAt, confirmed_at: value.confirmedAt, failed_at: value.failedAt, error: value.error } }
}



