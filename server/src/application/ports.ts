import type { Action, AutopsyEvent, Book, BookCreationReadiness, BookPositionSeed, BookStance, BookStatus, BookTelemetrySeed, CapitalSnapshot, Decision, NormalizedTelemetry, Position, Reserve } from '../../../packages/domain/src/index.js'
export type CreateBookInput = Omit<Book, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { reserveAvailable?: number; initialPosition?: BookPositionSeed; initialTelemetry?: BookTelemetrySeed }
export type BookControlPatch = { automationEnabled?: boolean; status?: BookStatus; stance?: BookStance }

export type BookRepository = {
  createBook(userId: string, input: CreateBookInput): Promise<Book>
  getBook(userId: string, bookId: string): Promise<Book | null>
  listBooks(userId: string): Promise<Book[]>
  updateBookControls(userId: string, bookId: string, changes: BookControlPatch): Promise<Book | null>
  listAutopsy(userId: string, bookId: string): Promise<unknown[]>
  listDecisions(userId: string, bookId: string): Promise<unknown[]>
  listActions(userId: string, bookId: string): Promise<unknown[]>
  getReserve(userId: string, bookId: string): Promise<unknown | null>
}

export type ExecutionContext = { book: Book; position: Position; reserve: Reserve; priorDefenseEfficiency: number; telemetry: NormalizedTelemetry }
export type ExecutionPort = {
  getActiveAction(bookId: string): Promise<Action | null>
  saveAction(action: Action): Promise<void>
  saveDecision(decision: Decision): Promise<void>
  addEvent(event: AutopsyEvent): Promise<void>
  getBookContext(bookId: string): Promise<ExecutionContext>
  finalize?(action: Action): Promise<void>
  updateReserve(bookId: string, amount: number, actionId?: string, decisionId?: string): Promise<void>
}

export type VenuePort = {
  validate?(): Promise<'VALID' | 'INVALID' | 'UNAVAILABLE'>
  listPositions?(): Promise<Array<{ marketId: number; market: string; accountId: number; positionId: number; position: Omit<Position, 'bookId'>; telemetry?: Omit<NormalizedTelemetry, 'source' | 'freshnessMs'> & { source?: NormalizedTelemetry['source']; freshnessMs?: number }; bookCreation: BookCreationReadiness }>>
  capital?(walletAddress?: string): Promise<CapitalSnapshot>
}
