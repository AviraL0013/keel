import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { evaluate } from '../packages/risk-engine/src/index.js'
import type { Action, Book, NormalizedTelemetry, Position, Reserve } from '../packages/domain/src/index.js'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { KeelRuntime, type RuntimeVenue } from '../server/src/runtime.js'
import { databaseFixture } from './helpers/database.js'

const now = Date.now()
const book: Book = { id: 'kill-book', userId: 'owner', market: 'BTC-PERP', side: 'LONG', stance: 'KILL', status: 'ACTIVE', automationEnabled: true, liquidationFloor: 6, defenseCap: 5, timeLimitMs: 3_600_000, createdAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now).toISOString() }
const position: Position = { bookId: book.id, side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 94, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: now, observedAt: now }
const reserve: Reserve = { bookId: book.id, available: 10, reserved: 0, deployed: 0, cap: 10, updatedAt: new Date(now).toISOString() }
const telemetry = (mark = 100, timestamp = now): NormalizedTelemetry => ({ mark, oracle: mark, bid: mark - .1, ask: mark + .1, mid: mark, spreadBps: 20, fundingRate: 0, depthNotional: 10_000, volatility: 0, volume24h: 1, openInterest: 1, block: 1, timestamp, source: 'replay', freshnessMs: 0 })

describe('KILL stance', () => {
  it('holds healthy state, exits danger without rescue, and preserves stale/time-limit safety', () => {
    const healthy = evaluate(book, position, reserve, telemetry(), Infinity, now)
    expect(healthy).toMatchObject({ state: 'HOLD', action: 'HOLD', reasonCodes: ['WITHIN_LIMITS'] })
    const breached = evaluate(book, position, reserve, telemetry(98, now), Infinity, now)
    expect(breached).toMatchObject({ state: 'EXIT', action: 'EXIT', amount: 0 })
    expect(breached.reasonCodes).toEqual(expect.arrayContaining(['USER_KILL', 'LIQ_FLOOR']))
    expect(evaluate(book, position, reserve, telemetry(98, now - 20_000), Infinity, now).state).toBe('SAFE_MODE')
    expect(evaluate({ ...book, timeLimitMs: 1 }, position, reserve, telemetry(100, now), Infinity, now).reasonCodes).toContain('TIME_LIMIT')
    for (const mark of [100, 98, 95]) expect(evaluate(book, position, reserve, telemetry(mark, now), Infinity, now).action).not.toBe('DEFEND')
  })

  it('rejects re-arming a killed Book, but permits an explicit stance change', async () => {
    const previous = { environment: process.env.KEEL_ENV, allowlist: process.env.KEEL_ALLOWED_WALLETS }
    const wallet = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
    process.env.KEEL_ENV = 'test'; process.env.KEEL_ALLOWED_WALLETS = wallet.address
    const at = Date.now()
    const venue = {
      loadBookSetup: async () => ({ market: 'BTC-PERP', position: { side: 'LONG' as const, status: 'OPEN' as const, size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 94, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: at }, telemetry: telemetry(100, at), reserveAvailable: 10 }),
      ready: () => true, refresh: async () => undefined, submit: async () => ({ venueReference: 'unused', status: 'FAILED' as const }), reconcile: async (action: Action) => action, close: async () => undefined,
    } satisfies RuntimeVenue
    const store = new MemoryStore()
    const app = createServer(store, { venue })
    try {
      const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: wallet.address } })
      const body = challenge.json() as { message: string; nonce: string }
      const signature = await wallet.signMessage({ message: body.message })
      const signed = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: wallet.address, nonce: body.nonce, message: body.message, signature } })
      const headers = { authorization: `Bearer ${signed.json().token}` }
      const created = await app.inject({ method: 'POST', url: '/books', headers, payload: { market: 'BTC-PERP', marketId: 1, venueAccountId: 7, venuePositionId: 9, side: 'LONG', stance: 'DEFEND', liquidationFloor: 6, defenseCap: 5, reserveAvailable: 10, timeLimitMs: 3_600_000, automationEnabled: false } })
      expect(created.statusCode).toBe(200)
      const id = created.json().id as string
      const invalid = await app.inject({ method: 'PATCH', url: `/books/${id}`, headers, payload: { unknownControl: true } })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json()).toEqual({ error: 'INVALID_BOOK_CONTROLS' })
      expect((await app.inject({ method: 'POST', url: `/books/${id}/kill`, headers })).statusCode).toBe(200)
      const arm = await app.inject({ method: 'POST', url: `/books/${id}/arm`, headers })
      expect(arm.statusCode).toBe(409)
      expect(arm.json()).toEqual({ error: 'KILL_SWITCH_ENGAGED' })
      expect((await app.inject({ method: 'GET', url: `/books/${id}`, headers })).json()).toMatchObject({ automationEnabled: false, stance: 'KILL' })
      const changed = await app.inject({ method: 'PATCH', url: `/books/${id}`, headers, payload: { automationEnabled: true, stance: 'DEFEND' } })
      expect(changed.statusCode).toBe(200)
      expect(changed.json()).toMatchObject({ automationEnabled: true, stance: 'DEFEND' })
      Object.assign(store.getAnyBook(id)!, { status: 'CLOSED', automationEnabled: false })
      const armClosed = await app.inject({ method: 'POST', url: `/books/${id}/arm`, headers })
      expect(armClosed.statusCode).toBe(409)
      expect(armClosed.json()).toEqual({ error: 'INVALID_BOOK_STATUS_TRANSITION' })
    } finally {
      await app.close()
      if (previous.environment === undefined) delete process.env.KEEL_ENV; else process.env.KEEL_ENV = previous.environment
      if (previous.allowlist === undefined) delete process.env.KEEL_ALLOWED_WALLETS; else process.env.KEEL_ALLOWED_WALLETS = previous.allowlist
    }
  })

  it('submits no order when healthy and one EXIT after a floor breach', async () => {
    const { db, store } = await databaseFixture()
    try {
      const userId = await store.ensureUser('kill-owner')
      const at = Date.now()
      const created = await store.createBook(userId, { market: 'BTC-PERP', marketId: 1, venueAccountId: 7, venuePositionId: 9, side: 'LONG', stance: 'KILL', status: 'ACTIVE', automationEnabled: true, liquidationFloor: 6, defenseCap: 5, reserveAvailable: 10, timeLimitMs: 3_600_000,
        initialPosition: { side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 94, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: at, observedAt: at },
        initialTelemetry: { ...telemetry(100, at), block: 1 } })
      const submit = vi.fn(async (_action: Action) => ({ venueReference: 'definite-test-failure', status: 'FAILED' as const, reason: 'TEST_REJECTED' }))
      const venue = { ready: () => true, refresh: async () => undefined, submit, reconcile: async (action: Action) => action, close: async () => undefined } satisfies RuntimeVenue
      const runtime = new KeelRuntime(store, venue)
      Object.assign(runtime, { lease: { query: async () => ({ rows: [] }) } })
      const tick = () => (runtime as unknown as { tick(): Promise<void> }).tick()
      await tick()
      expect(submit).not.toHaveBeenCalled()
      await db.query('UPDATE positions SET mark_price=98, observed_at=now() WHERE book_id=$1', [created.id])
      await db.query("INSERT INTO risk_snapshots(book_id,block,timestamp,mark,oracle,liquidation,funding,spread,depth,volatility,reserve,freshness,source,bid,ask,mid) SELECT book_id,2,now(),98,98,94,0,20,10000,0,10,0,'replay',97.9,98.1,98 FROM positions WHERE book_id=$1", [created.id])
      await tick()
      expect(submit).toHaveBeenCalledTimes(1)
      const actions = await db.query<{ kind: string; amount: string }>('SELECT kind,amount FROM actions WHERE book_id=$1', [created.id])
      expect(actions.rows).toMatchObject([{ kind: 'EXIT', amount: '0' }])
    } finally { await db.close() }
  }, 20_000)

  it('still submits exactly one explicit close while the healthy KILL policy holds', async () => {
    const { db, store } = await databaseFixture()
    try {
      const userId = await store.ensureUser('manual-kill-owner')
      const at = Date.now()
      const created = await store.createBook(userId, { market: 'BTC-PERP', marketId: 1, venueAccountId: 7, venuePositionId: 10, side: 'LONG', stance: 'KILL', status: 'ACTIVE', automationEnabled: false, liquidationFloor: 6, defenseCap: 5, reserveAvailable: 10, timeLimitMs: 3_600_000,
        initialPosition: { side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 94, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: at, observedAt: at },
        initialTelemetry: telemetry(100, at) })
      const submit = vi.fn(async (_action: Action) => ({ venueReference: 'definite-test-failure', status: 'FAILED' as const, reason: 'TEST_REJECTED' }))
      const runtime = new KeelRuntime(store, { ready: () => true, refresh: async () => undefined, submit, reconcile: async (action: Action) => action, close: async () => undefined })
      const result = await runtime.closeBook(userId, created.id)
      expect(result.status).toBe('FAILED')
      expect(submit).toHaveBeenCalledOnce()
      expect(submit.mock.calls[0][0]).toMatchObject({ kind: 'EXIT', amount: 0 })
    } finally { await db.close() }
  }, 20_000)
})
