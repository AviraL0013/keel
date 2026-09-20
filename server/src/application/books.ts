import type { BookPositionSeed, BookStatus, BookStance, BookTelemetrySeed, PositionSide } from '../../../packages/domain/src/index.js'
import { NotFoundError, ValidationError } from './errors.js'
import type { BookRepository, VenuePort } from './ports.js'

export type CreateBookCommand = {
  market: string; marketId?: number; venueAccountId?: number; venuePositionId?: number
  side: PositionSide; stance: BookStance; liquidationFloor: number; defenseCap: number
  timeLimitMs: number; automationEnabled: boolean; reserveAvailable?: number
}
export type BookSetup = { market: string; position: BookPositionSeed; telemetry: BookTelemetrySeed; reserveAvailable: number }
export type BookSetupLoader = (marketId: number, accountId: number, positionId: number) => Promise<BookSetup>

export class BooksApplication {
  constructor(private readonly books: BookRepository, private readonly venue?: VenuePort & { loadBookSetup?: BookSetupLoader }) {}

  list(userId: string) { return this.books.listBooks(userId) }
  async get(userId: string, bookId: string) { const book = await this.books.getBook(userId, bookId); if (!book) throw new NotFoundError('BOOK_NOT_FOUND'); return book }
  async create(userId: string, command: CreateBookCommand) {
    validateCreateBook(command)
    if (this.venue?.loadBookSetup && command.marketId && command.venueAccountId && command.venuePositionId) {
      const setup = await this.venue.loadBookSetup(command.marketId, command.venueAccountId, command.venuePositionId)
      return this.books.createBook(userId, { ...command, market: setup.market, side: setup.position.side, initialPosition: setup.position, initialTelemetry: setup.telemetry, reserveAvailable: command.reserveAvailable ?? Math.min(setup.reserveAvailable, command.defenseCap), status: 'ACTIVE' })
    }
    return this.books.createBook(userId, { ...command, automationEnabled: false, reserveAvailable: 0, status: 'PAUSED' })
  }
  async controls(userId: string, bookId: string, changes: { automationEnabled?: boolean; status?: BookStatus; stance?: BookStance }) {
    const book = await this.books.updateBookControls(userId, bookId, changes)
    if (!book) throw new NotFoundError('BOOK_NOT_FOUND')
    return book
  }
  async close(userId: string, bookId: string, closeBook?: (userId: string, bookId: string) => Promise<{ actionId: string; status: string }>) {
    await this.get(userId, bookId)
    if (!closeBook) throw new ValidationError('LIVE_EXECUTION_NOT_CONFIGURED')
    const result = await closeBook(userId, bookId)
    return { positionClosed: result.status === 'CONFIRMED', ...result }
  }
}

function validateCreateBook(command: CreateBookCommand) {
  if (!command || typeof command.market !== 'string' || command.market.length === 0 || command.market.length > 80 || !['LONG', 'SHORT'].includes(command.side) || !['DEFEND', 'HARVEST', 'KILL'].includes(command.stance) || !Number.isFinite(command.liquidationFloor) || command.liquidationFloor < 0 || command.liquidationFloor > 100 || !Number.isFinite(command.defenseCap) || command.defenseCap < 0 || !Number.isFinite(command.timeLimitMs) || command.timeLimitMs <= 0 || typeof command.automationEnabled !== 'boolean' || (command.marketId !== undefined && (!Number.isSafeInteger(command.marketId) || command.marketId <= 0)) || (command.venueAccountId !== undefined && (!Number.isSafeInteger(command.venueAccountId) || command.venueAccountId <= 0)) || (command.venuePositionId !== undefined && (!Number.isSafeInteger(command.venuePositionId) || command.venuePositionId <= 0)) || (command.reserveAvailable !== undefined && (!Number.isFinite(command.reserveAvailable) || command.reserveAvailable < 0 || command.reserveAvailable > command.defenseCap))) throw new ValidationError('INVALID_BOOK_CONFIGURATION')
}
