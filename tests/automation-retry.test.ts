import { describe, expect, it, vi } from 'vitest'
import type { Action } from '../packages/domain/src/index.js'
import { EyelerRuntime, type RuntimeVenue } from '../server/src/runtime.js'
import { databaseFixture } from './helpers/database.js'

async function fixture(first: 'FAILED' | 'CANCELED' | 'UNKNOWN' | 'PARTIAL' = 'FAILED', alwaysFail = false) {
  const { db, store } = await databaseFixture()
  const clock = { at: Date.now() }
  const userId = await store.ensureUser('retry-owner')
  const book = await store.createBook(userId, { market: 'BTC-PERP', marketId: 1, venueAccountId: 7, venuePositionId: 9, side: 'LONG', stance: 'DEFEND', status: 'ACTIVE', automationEnabled: true, liquidationFloor: 6, defenseCap: 5, reserveAvailable: 10, timeLimitMs: 1_000,
    initialPosition: { side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: clock.at, observedAt: clock.at },
    initialTelemetry: { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, spreadBps: 20, fundingRate: 0, depthNotional: 10_000, volatility: 0, volume24h: 1, openInterest: 1, block: 1, timestamp: clock.at, source: 'replay' } })
  await db.query('UPDATE books SET created_at=$2 WHERE id=$1', [book.id, new Date(clock.at - 60_000).toISOString()])
  let attempt = 0
  const submit = vi.fn(async (_action: Action) => {
    attempt++
    return { venueReference: `retry-${attempt}`, status: first === 'FAILED' && (attempt === 1 || alwaysFail) ? 'FAILED' as const : 'SUBMITTED' as const, reason: 'TEST_DEFINITE_FAILURE' }
  })
  const reconcile = vi.fn(async (action: Action): Promise<Action> => {
    if (attempt === 1 || alwaysFail) return { ...action, status: first === 'FAILED' ? 'FAILED' : first }
    await db.query("UPDATE positions SET status='CLOSED', observed_at=$2 WHERE book_id=$1", [book.id, new Date(clock.at).toISOString()])
    return { ...action, status: 'CONFIRMED', confirmedAt: new Date(clock.at).toISOString() }
  })
  const venue: RuntimeVenue = { ready: () => true, refresh: async () => {
    const at = new Date(clock.at).toISOString()
    await db.query('UPDATE positions SET observed_at=$2 WHERE book_id=$1', [book.id, at])
    await db.query('UPDATE risk_snapshots SET timestamp=$2,freshness_detail=NULL WHERE book_id=$1', [book.id, at])
  }, submit, reconcile, close: async () => undefined }
  const runtime = () => {
    const value = new EyelerRuntime(store, venue, () => clock.at)
    Object.assign(value, { lease: { query: async () => ({ rows: [] }) } })
    return { tick: () => (value as unknown as { tick(): Promise<void> }).tick() }
  }
  return { db, store, book, clock, submit, reconcile, runtime, close: () => db.close() }
}

describe('definite automated failures', () => {
  it.each(['FAILED', 'CANCELED'] as const)('retries %s after bounded backoff and closes on success', async first => {
    const value = await fixture(first)
    try {
      const runtime = value.runtime()
      await runtime.tick()
      expect(value.submit).toHaveBeenCalledTimes(1)
      const decisions = async () => (await value.db.query('SELECT id FROM decisions WHERE book_id=$1', [value.book.id])).rows.length
      const notifications = async () => (await value.db.query('SELECT id FROM notifications WHERE user_id=$1', [value.book.userId])).rows.length
      const initialDecisions = await decisions()
      const initialNotifications = await notifications()
      value.clock.at += 29_999
      await runtime.tick()
      expect(value.submit).toHaveBeenCalledTimes(1)
      expect(await decisions()).toBe(initialDecisions)
      expect(await notifications()).toBe(initialNotifications)
      value.clock.at++
      await runtime.tick()
      expect(value.submit).toHaveBeenCalledTimes(2)
      expect((await value.store.getBook(value.book.userId, value.book.id))?.status).toBe('CLOSED')
    } finally { await value.close() }
  }, 20_000)

  it('survives restart and stops after three definite failures with one exhaustion alert', async () => {
    const value = await fixture('FAILED', true)
    try {
      await value.runtime().tick()
      expect(value.submit).toHaveBeenCalledTimes(1)
      const restarted = value.runtime()
      value.clock.at += 30_000; await restarted.tick()
      expect(value.submit).toHaveBeenCalledTimes(2)
      value.clock.at += 60_000; await restarted.tick()
      expect(value.submit).toHaveBeenCalledTimes(3)
      const events = await value.db.query("SELECT id FROM autopsy_events WHERE book_id=$1 AND type='AUTOMATION_RETRY_EXHAUSTED'", [value.book.id])
      const notifications = await value.db.query("SELECT id FROM notifications WHERE user_id=$1 AND kind='AUTOMATION_RETRY_EXHAUSTED'", [value.book.userId])
      expect(events.rows).toHaveLength(1)
      expect(notifications.rows).toHaveLength(1)
      value.clock.at += 120_000; await restarted.tick(); await restarted.tick()
      expect(value.submit).toHaveBeenCalledTimes(3)
      expect((await value.db.query("SELECT id FROM notifications WHERE user_id=$1 AND kind='AUTOMATION_RETRY_EXHAUSTED'", [value.book.userId])).rows).toHaveLength(1)
    } finally { await value.close() }
  }, 20_000)

  it.each(['UNKNOWN', 'PARTIAL'] as const)('never retries %s outcomes', async outcome => {
    const value = await fixture(outcome)
    try {
      const runtime = value.runtime()
      await runtime.tick()
      expect(value.submit).toHaveBeenCalledTimes(1)
      value.clock.at += 120_000
      await runtime.tick()
      expect(value.submit).toHaveBeenCalledTimes(1)
    } finally { await value.close() }
  }, 20_000)
})
