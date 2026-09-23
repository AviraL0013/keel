import { describe, expect, it, vi } from 'vitest'
import { buildTelemetryFreshness, freshnessPoint, type Action, type Book, type NormalizedTelemetry, type Position, type Reserve } from '../packages/domain/src/index.js'
import { evaluate } from '../packages/risk-engine/src/index.js'
import { KeelRuntime } from '../server/src/runtime.js'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { databaseFixture } from './helpers/database.js'

type SetupOptions = { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance']; defenseCap?: number; reserveAvailable?: number; mark?: number; stale?: boolean; marketStale?: boolean; positionStale?: boolean; marketUnknown?: boolean; venueReady?: boolean }

async function setup(options: SetupOptions = {}) {
  const { db, store } = await databaseFixture()
  const memory = new MemoryStore()
  const calls: string[] = []
  const submit = vi.fn(async () => { calls.push('submit'); return { venueReference: 'manual-defend', status: 'SUBMITTED' as const } })
  const reconcile = vi.fn(async (action: Action) => { calls.push('reconcile'); return { ...action, status: 'CONFIRMED' as const, confirmedAt: new Date().toISOString() } })
  const runtime = new KeelRuntime(store, { submit, reconcile, refresh: async () => undefined, ready: () => options.venueReady ?? true, close: async () => undefined })
  const app = createServer(memory, { executeAction: runtime.executeAction.bind(runtime) })
  const user = await store.ensureUser('test-policy-owner')
  await memory.createSession('test-policy-session', { userId: user, walletAddress: 'test-policy-owner', expiresAt: Date.now() + 60_000 })
  const now = Date.now()
  const telemetryAt = options.stale || options.marketStale ? now - 20_000 : now
  const positionAt = options.stale || options.positionStale ? now - 20_000 : now
  const mark = options.mark ?? 98
  const freshness = buildTelemetryFreshness({ marketUpdatedAt: telemetryAt, positionUpdatedAt: positionAt, fundingUpdatedAt: now, orderbookUpdatedAt: now }, now)
  if (options.marketUnknown) freshness.market = freshnessPoint(undefined, now)
  const book = await store.createBook(user, {
    market: 'BTC', marketId: 16, venueAccountId: 642, venuePositionId: 77, side: 'LONG', stance: options.stance ?? 'DEFEND', status: options.status ?? 'ACTIVE', liquidationFloor: 6, defenseCap: options.defenseCap ?? 5, reserveAvailable: options.reserveAvailable ?? 10, timeLimitMs: 86_400_000, automationEnabled: options.automationEnabled ?? false,
    initialPosition: { side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: mark, liquidationPrice: 95, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: positionAt, observedAt: positionAt },
    initialTelemetry: { mark, oracle: mark, bid: mark - .1, ask: mark + .1, mid: mark, spreadBps: 20, fundingRate: 0, depthNotional: 100_000, volatility: 0, volume24h: 1, openInterest: 1, block: 1, timestamp: telemetryAt, source: 'replay', freshnessMs: options.stale || options.marketStale ? 20_000 : 0, freshness },
  })
  const request = () => app.inject({ method: 'POST', url: `/books/${book.id}/actions`, headers: { authorization: 'Bearer test-policy-session' }, payload: { kind: 'DEFEND' } })
  return { app, calls, db, request, submit, reconcile }
}

async function close(value: Awaited<ReturnType<typeof setup>>) { await value.app.close(); await value.db.close() }

describe('manual action policy', () => {
  it('automation OFF holds the automated policy without submitting', () => {
    const now = Date.now()
    const book: Book = { id: 'book', userId: 'user', market: 'BTC', side: 'LONG', stance: 'DEFEND', status: 'ACTIVE', automationEnabled: false, liquidationFloor: 6, defenseCap: 5, timeLimitMs: 86_400_000, createdAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now).toISOString() }
    const position: Position = { bookId: book.id, side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 98, liquidationPrice: 95, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: now, observedAt: now }
    const reserve: Reserve = { bookId: book.id, available: 10, reserved: 0, deployed: 0, cap: 10, updatedAt: new Date(now).toISOString() }
    const telemetry: NormalizedTelemetry = { mark: 98, oracle: 98, bid: 97.9, ask: 98.1, mid: 98, spreadBps: 20, fundingRate: 0, depthNotional: 100_000, volatility: 0, volume24h: 1, openInterest: 1, block: 1, timestamp: now, source: 'replay', freshnessMs: 0 }
    expect(evaluate(book, position, reserve, telemetry, Infinity, now)).toMatchObject({ state: 'HOLD', action: 'HOLD', reasonCodes: ['AUTOMATION_PAUSED'] })
  })

  it('automation OFF plus a valid manual DEFEND reaches submit then reconciliation', async () => {
    const value = await setup({ automationEnabled: false, mark: 98 })
    try {
      const response = await value.request()
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'CONFIRMED' })
      expect(value.calls).toEqual(['submit', 'reconcile'])
      expect(value.submit).toHaveBeenCalledOnce()
      expect(value.reconcile).toHaveBeenCalledOnce()
    } finally { await close(value) }
  }, 15_000)

  it('does not report automation as the reason when a healthy manual DEFEND is rejected', async () => {
    const value = await setup({ automationEnabled: false, mark: 102 })
    try {
      const response = await value.request()
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'POLICY_REJECTED', details: { requestedAction: 'DEFEND', reasonCodes: ['DEFENSE_NOT_REQUIRED'] } })
      expect(value.submit).not.toHaveBeenCalled()
    } finally { await close(value) }
  }, 15_000)

  it('rejects a manual DEFEND that exceeds the defense cap without submitting', async () => {
    const value = await setup({ defenseCap: 1, reserveAvailable: 10, mark: 98 })
    try {
      const response = await value.request()
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'POLICY_REJECTED', details: { requestedAction: 'DEFEND', reasonCodes: ['CAP_EXCEEDED'] } })
      expect(value.submit).not.toHaveBeenCalled()
    } finally { await close(value) }
  }, 15_000)

  it.each([
    [{ status: 'PAUSED' as const }, 'BOOK_NOT_ACTIVE'],
    [{ stance: 'KILL' as const }, 'USER_KILL'],
    [{ marketStale: true }, 'MARKET_STALE'],
    [{ positionStale: true }, 'POSITION_STALE'],
    [{ stale: true }, 'BOTH_STALE'],
    [{ marketUnknown: true }, 'MARKET_UNKNOWN'],
    [{ venueReady: false }, 'VENUE_UNAVAILABLE'],
  ])('fails closed for manual authority or Book state: %s', async (options, code) => {
    const value = await setup(options)
    try {
      const response = await value.request()
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'POLICY_REJECTED', details: { requestedAction: 'DEFEND', reasonCodes: [code] } })
      expect(value.submit).not.toHaveBeenCalled()
    } finally { await close(value) }
  }, 15_000)

  it('fails closed on stale backend telemetry even if a client cache is fresh', async () => {
    const value = await setup({ marketStale: true })
    const clientCache = buildTelemetryFreshness({ marketUpdatedAt: Date.now(), positionUpdatedAt: Date.now(), fundingUpdatedAt: Date.now(), orderbookUpdatedAt: Date.now() })
    try {
      expect(clientCache.market.status).toBe('FRESH')
      const response = await value.request()
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'POLICY_REJECTED', details: { reasonCodes: ['MARKET_STALE'] } })
      expect(value.submit).not.toHaveBeenCalled()
    } finally { await close(value) }
  }, 15_000)
})
