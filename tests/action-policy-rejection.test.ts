import { describe, expect, it, vi } from 'vitest'
import { buildTelemetryFreshness, type Action } from '../packages/domain/src/index.js'
import { KeelRuntime } from '../server/src/runtime.js'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { databaseFixture } from './helpers/database.js'

describe('manual action policy refusal', () => {
  it.each([
    [false, 'AUTOMATION_PAUSED', 'Automation is paused; no automated action is authorized.'],
    [true, 'WITHIN_LIMITS', 'All Book constraints remain inside configured limits.'],
  ] as const)('returns the engine reason with automation=%s, without submitting', async (automationEnabled, code, reason) => {
    const { db, store } = await databaseFixture()
    const memory = new MemoryStore()
    const submit = vi.fn(async () => ({ venueReference: 'must-not-submit', status: 'UNKNOWN' as const }))
    const runtime = new KeelRuntime(store, { submit, reconcile: async (action: Action) => action, refresh: async () => undefined, ready: () => true, close: async () => undefined })
    const app = createServer(memory, { executeAction: runtime.executeAction.bind(runtime) })
    try {
      const user = await store.ensureUser('test-policy-owner')
      await memory.createSession('test-policy-session', { userId: user, walletAddress: 'test-policy-owner', expiresAt: Date.now() + 60_000 })
      const now = Date.now()
      const book = await store.createBook(user, {
        market: 'BTC', marketId: 16, venueAccountId: 642, venuePositionId: 77, side: 'LONG', stance: 'DEFEND', status: 'ACTIVE', liquidationFloor: 6, defenseCap: 5, reserveAvailable: 10, timeLimitMs: 86_400_000, automationEnabled,
        initialPosition: { side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: now, observedAt: now },
        initialTelemetry: { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, spreadBps: 20, fundingRate: 0, depthNotional: 100_000, volatility: 0, volume24h: 1, openInterest: 1, block: 1, timestamp: now, source: 'replay', freshnessMs: 0, freshness: buildTelemetryFreshness({ marketUpdatedAt: now, positionUpdatedAt: now, fundingUpdatedAt: now, orderbookUpdatedAt: now }, now) },
      })
      const response = await app.inject({ method: 'POST', url: `/books/${book.id}/actions`, headers: { authorization: 'Bearer test-policy-session' }, payload: { kind: 'DEFEND' } })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'POLICY_REJECTED', details: { requestedAction: 'DEFEND', state: 'HOLD', action: 'HOLD', reasonCodes: [code], reasons: [reason] } })
      expect(submit).not.toHaveBeenCalled()
      expect(await store.listActions(user, book.id)).toEqual([])
    } finally { await app.close(); await db.close() }
  }, 15_000)
})
