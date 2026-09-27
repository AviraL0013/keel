import { describe, expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { KeelRuntime, type RuntimeVenue } from '../server/src/runtime.js'
import type { CreateBookInput } from '../server/src/infrastructure/database/postgres-store.js'

function bookInput(): CreateBookInput {
  const now = Date.now()
  return { market: 'BTC-PERP', marketId: 1, venueAccountId: 7, venuePositionId: 9,
    side: 'LONG', stance: 'DEFEND', liquidationFloor: 6, defenseCap: 5,
    timeLimitMs: 3600000, automationEnabled: false, status: 'SAFE_MODE', reserveAvailable: 10,
    initialPosition: { side: 'LONG', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90,
      leverage: 5, unrealizedPnl: 0, margin: 20, status: 'OPEN', timestamp: now },
    initialTelemetry: { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100,
      spreadBps: 20, fundingRate: 0.0001, depthNotional: 10000, volatility: 0.01,
      volume24h: 10, openInterest: 100, block: 1, timestamp: now, source: 'replay' } }
}

describe('manual-only Book recovery', () => {
  it('persists each repeated explicit manual decision before creating its action', async () => {
    const { db, store } = await databaseFixture()
    try {
      const user = await store.ensureUser('owner')
      const book = await store.createBook(user, { ...bookInput(), status: 'ACTIVE' })
      const submit = vi.fn(async () => ({ status: 'FAILED', venueReference: 'fake-venue-rejection', reason: 'TEST_REJECTED' }))
      const runtime = new KeelRuntime(store, { ready: () => true, refresh: async () => {}, submit } as unknown as RuntimeVenue)
      const first = await runtime.executeAction(user, book.id, 'REDUCE')
      const second = await runtime.executeAction(user, book.id, 'REDUCE')
      expect(first.status).toBe('FAILED')
      expect(second.status).toBe('FAILED')
      expect(first.actionId).not.toBe(second.actionId)
      const actions = await db.query<{ decision_id: string }>('SELECT decision_id FROM actions WHERE book_id=$1', [book.id])
      expect(actions.rows).toHaveLength(2)
      expect(new Set(actions.rows.map(row => row.decision_id)).size).toBe(2)
      expect(submit).toHaveBeenCalledTimes(2)
    } finally { await db.close() }
  }, 20000)

  it('recovers a safe-mode Book with fresh bound state without submitting or enabling automation', async () => {
    const { db, store } = await databaseFixture()
    try {
      const user = await store.ensureUser('owner')
      const book = await store.createBook(user, { ...bookInput(), status: 'SAFE_MODE' })
      const submit = vi.fn()
      const refresh = vi.fn(async () => {})
      const runtime = new KeelRuntime(store, { ready: () => true, refresh, submit } as unknown as RuntimeVenue)
      const recovered = await runtime.recoverBook(user, book.id)
      expect(recovered.status).toBe('ACTIVE')
      expect(recovered.automationEnabled).toBe(false)
      expect(refresh).toHaveBeenCalledOnce()
      expect(submit).not.toHaveBeenCalled()
      expect((await store.listAutopsy(user, book.id)).some(row => (row as { type: string }).type === 'BOOK_RECOVERED_MANUAL_ONLY')).toBe(true)
    } finally { await db.close() }
  }, 20000)

  it('fails closed for stale telemetry, closed position, unresolved execution, and unavailable venue', async () => {
    const { db, store } = await databaseFixture()
    try {
      const user = await store.ensureUser('owner')
      const book = await store.createBook(user, { ...bookInput(), status: 'SAFE_MODE' })
      const submit = vi.fn()
      const venue = { ready: () => true, refresh: async () => {}, submit } as unknown as RuntimeVenue
      const runtime = new KeelRuntime(store, venue)
      const assertBlocked = async (code: string) => {
        await expect(runtime.recoverBook(user, book.id)).rejects.toThrow(code)
        expect((await store.getBook(user, book.id))?.status).toBe('SAFE_MODE')
        expect(submit).not.toHaveBeenCalled()
      }
      await db.query("UPDATE risk_snapshots SET timestamp=now()-interval '1 hour' WHERE book_id=$1", [book.id])
      await assertBlocked('BOOK_RECOVERY_REJECTED')
      await db.query('UPDATE risk_snapshots SET timestamp=now() WHERE book_id=$1', [book.id])
      await db.query("UPDATE positions SET status='CLOSED' WHERE book_id=$1", [book.id])
      await assertBlocked('POSITION_NOT_OPEN')
      await db.query("UPDATE positions SET status='OPEN' WHERE book_id=$1", [book.id])
      await db.query("INSERT INTO decisions(id,book_id,state,action,reason_codes,human_readable_reasons,risk_features,created_at) VALUES(gen_random_uuid(),$1,'HOLD','HOLD','[]','[]','{}',now())", [book.id])
      await db.query("INSERT INTO actions(id,book_id,decision_id,kind,amount,status,idempotency_key) SELECT gen_random_uuid(),$1,id,'REDUCE',0,'UNKNOWN','recovery-test' FROM decisions WHERE book_id=$1 LIMIT 1", [book.id])
      await assertBlocked('POSITION_EXECUTION_UNRESOLVED')
      await expect(store.recoverBookManualOnly(user, book.id)).rejects.toThrow('POSITION_EXECUTION_UNRESOLVED')
      await db.query('DELETE FROM actions WHERE book_id=$1', [book.id])
      await db.query("UPDATE books SET stance='KILL' WHERE id=$1", [book.id])
      await assertBlocked('BOOK_RECOVERY_NOT_ALLOWED')
      await db.query("UPDATE books SET stance='DEFEND' WHERE id=$1", [book.id])
      const unavailable = new KeelRuntime(store, { ready: () => false, refresh: async () => {}, submit } as unknown as RuntimeVenue)
      await expect(unavailable.recoverBook(user, book.id)).rejects.toThrow('VENUE_UNAVAILABLE')
      expect(submit).not.toHaveBeenCalled()
    } finally { await db.close() }
  }, 20000)
})
