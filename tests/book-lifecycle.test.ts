import { describe, expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { PostgresExecutionRepository } from '../server/src/infrastructure/database/execution-repository.js'
import { evaluate } from '../packages/risk-engine/src/index.js'
import type { CreateBookInput } from '../server/src/infrastructure/database/postgres-store.js'

export function bookInput(): CreateBookInput {
  return { market: 'BTC-PERP', marketId: 1, venueAccountId: 7, venuePositionId: 9,
    side: 'LONG', stance: 'DEFEND', liquidationFloor: 6, defenseCap: 100,
    timeLimitMs: 3600000, automationEnabled: false, status: 'PAUSED', reserveAvailable: 50,
    initialPosition: { side: 'LONG', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90,
      leverage: 5, unrealizedPnl: 0, margin: 20, status: 'OPEN', timestamp: Date.now() },
    initialTelemetry: { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100,
      spreadBps: 20, fundingRate: 0.0001, depthNotional: 10000, volatility: 0.01,
      volume24h: 10, openInterest: 100, block: 1, timestamp: Date.now(), source: 'replay' } }
}

describe('production Book repository', () => {
  it('persists bound state, arms, evaluates and enforces ownership', async () => {
    const { db, store } = await databaseFixture()
    try {
      const user = await store.ensureUser('owner')
      const other = await store.ensureUser('other')
      const book = await store.createBook(user, bookInput())
      expect(book.status).toBe('PAUSED')
      expect(await store.getBook(other, book.id)).toBeNull()
      expect(await store.updateBookControls(other, book.id, { automationEnabled: true })).toBeNull()
      const armed = await store.updateBookControls(user, book.id, { automationEnabled: true, status: 'ACTIVE' })
      expect(armed?.automationEnabled).toBe(true)
      const context = await new PostgresExecutionRepository(store).getBookContext(book.id)
      expect(context.reserve.available).toBe(50)
      expect(evaluate(context.book, context.position, context.reserve, context.telemetry).state).toBe('HOLD')
      expect((await db.query('SELECT * FROM reserve_ledger_entries')).rows).toHaveLength(1)
      expect((await store.listAutopsy(user, book.id)).length).toBeGreaterThan(0)
    } finally { await db.close() }
  }, 20000)

  it('rolls back invalid reserve and refuses arming an unbound Book', async () => {
    const { db, store } = await databaseFixture()
    try {
      const user = await store.ensureUser('owner')
      await expect(store.createBook(user, { ...bookInput(), reserveAvailable: 101 })).rejects.toThrow('INVALID_BOOK_RESERVE')
      expect(await store.listBooks(user)).toHaveLength(0)
      const book = await store.createBook(user, { ...bookInput(), initialPosition: undefined, initialTelemetry: undefined, reserveAvailable: 0 })
      await expect(store.updateBookControls(user, book.id, { status: 'ACTIVE' })).rejects.toThrow('BOOK_NOT_ARMABLE')
      expect((await store.getBook(user, book.id))?.status).toBe('PAUSED')
    } finally { await db.close() }
  }, 20000)

  it('cannot reactivate closed or unresolved safe-mode Books', async () => {
    const { db, store } = await databaseFixture()
    try {
      const user = await store.ensureUser('owner')
      const book = await store.createBook(user, bookInput())
      for (const status of ['SAFE_MODE', 'CLOSED']) {
        await db.query('UPDATE books SET status=$2 WHERE id=$1', [book.id, status])
        await expect(store.updateBookControls(user, book.id, { automationEnabled: true })).rejects.toThrow('INVALID_BOOK_STATUS_TRANSITION')
        await expect(store.updateBookControls(user, book.id, { status: 'ACTIVE' })).rejects.toThrow('INVALID_BOOK_STATUS_TRANSITION')
      }
    } finally { await db.close() }
  }, 20000)
})

