import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { buildTelemetryFreshness, type Book, type NormalizedTelemetry, type Position } from '../packages/domain/src/index.js'
import { PerplAdapter } from '../packages/perpl/src/index.js'
import { evaluate } from '../packages/risk-engine/src/index.js'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { createPerplRuntime } from '../server/src/infrastructure/perpl/runtime.js'
import { PostgresExecutionRepository } from '../server/src/infrastructure/database/execution-repository.js'
import { toTelemetryDto } from '../server/src/interfaces/http/mappers.js'
import { databaseFixture } from './helpers/database.js'

const account = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const snapshot = (at: number, mark = 100): NormalizedTelemetry => ({
  mark, oracle: mark, bid: mark - .1, ask: mark + .1, mid: mark, spreadBps: 20,
  fundingRate: .0001, depthNotional: 10_000, volatility: .01, volume24h: 1, openInterest: 1,
  block: 1, timestamp: at, marketTimestamp: at, fundingTimestamp: at, orderbookTimestamp: at,
  source: 'perpl-ws', freshnessMs: 0,
  freshness: buildTelemetryFreshness({ marketUpdatedAt: at, positionUpdatedAt: at, fundingUpdatedAt: at, orderbookUpdatedAt: at }, at),
})
const position = (at: number): Position => ({ bookId: '', side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: at, observedAt: at })
const input = (at: number) => ({ market: 'BTC-PERP', marketId: 16, venueAccountId: 642, venuePositionId: 77, side: 'LONG' as const, stance: 'DEFEND' as const, liquidationFloor: 6, defenseCap: 5, reserveAvailable: 10, timeLimitMs: 86_400_000, automationEnabled: false, status: 'ACTIVE' as const, initialPosition: position(at), initialTelemetry: snapshot(at) })

describe('Book telemetry refresh', () => {
  it('serves current data for automation-off Books, ages failed reads, and recovers after reconnect without an action', async () => {
    vi.stubEnv('KEEL_ENV', 'test')
    const store = new MemoryStore()
    let current = snapshot(Date.now(), 101)
    let disconnected = false
    const refresh = vi.fn(async (book: Book) => {
      if (disconnected) throw new Error('PERPL_STATE_UNAVAILABLE')
      store.setTelemetry(book.id, current)
      store.setPosition(book.id, { ...position(current.marketTimestamp!), bookId: book.id })
    })
    const submit = vi.fn(async () => { throw new Error('READ_ONLY_TEST') })
    const app = createServer(store, { venue: { refresh, submit, reconcile: async action => action, close: async () => undefined, ready: () => !disconnected } })
    try {
      const challenge = (await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: account.address } })).json()
      const signature = await account.signMessage({ message: challenge.message })
      const auth = (await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: account.address, ...challenge, signature } })).json()
      const book = await store.createBook(auth.userId, input(Date.now() - 900_000))
      const read = () => app.inject({ url: `/books/${book.id}/state`, headers: { authorization: `Bearer ${auth.token}` } })
      const fresh = await read()
      expect(fresh.statusCode).toBe(200)
      expect(fresh.json().risk.state).toBe('HOLD')
      expect(fresh.json().risk.reasonCodes).toContain('AUTOMATION_PAUSED')
      expect(fresh.json()).toMatchObject({ book: { status: 'ACTIVE', automationEnabled: false }, telemetry: { mark: 101 }, execution: { status: 'NO_ACTIVE_EXECUTION' } })
      for (const key of ['market', 'position', 'funding', 'orderbook']) expect(fresh.json().telemetry.freshness[key].status).toBe('FRESH')

      // A persisted FRESH label must age even when the next venue read fails.
      current = snapshot(Date.now() - 20_000, 102)
      await read()
      disconnected = true
      const stale = (await read()).json()
      expect(stale.telemetry.mark).toBe(102)
      expect(stale.risk.state).toBe('SAFE_MODE')
      for (const key of ['market', 'position', 'funding', 'orderbook']) {
        expect(stale.telemetry.freshness[key].status).toBe('STALE')
        expect(stale.telemetry.freshness[key].ageMs).toBeGreaterThanOrEqual(20_000)
      }
      disconnected = false
      current = snapshot(Date.now(), 103)
      const recovered = (await read()).json()
      expect(recovered.telemetry.mark).toBe(103)
      expect(recovered.risk.state).toBe('HOLD')
      expect(recovered.telemetry.liquidationDistance).toBeCloseTo((103 - 90) / 103 * 100)
      for (const key of ['market', 'position', 'funding', 'orderbook']) expect(recovered.telemetry.freshness[key].status).toBe('FRESH')
      expect(recovered.execution.status).toBe('NO_ACTIVE_EXECUTION')
      expect(submit).not.toHaveBeenCalled()
    } finally { await app.close(); vi.unstubAllEnvs() }
  })

  it('persists all source timestamps and gives risk evaluation the same stale funding as the dashboard', async () => {
    vi.stubEnv('PERPL_API_KEY', 'test-read-only')
    vi.stubEnv('PERPL_API_KEY_SECRET', '11'.repeat(32))
    vi.stubEnv('PERPL_ACCOUNT_ID', '642')
    const { db, store } = await databaseFixture()
    let venue: ReturnType<typeof createPerplRuntime>
    try {
      const at = Date.now()
      const user = await store.ensureUser('test-owner')
      const book = await store.createBook(user, input(at - 900_000))
      const market = snapshot(at, 105)
      market.fundingTimestamp = at - 20_000
      vi.spyOn(PerplAdapter.prototype, 'getNormalizedMarket').mockResolvedValue(market)
      vi.spyOn(PerplAdapter.prototype, 'getPosition').mockResolvedValue(position(at))
      venue = createPerplRuntime(store)
      await venue!.refresh(book)
      const row = await store.getTelemetryRow(user, book.id)
      const dto = toTelemetryDto(row!)
      expect(dto.freshness?.position.status).toBe('FRESH')
      expect(dto.freshness?.position.updatedAt).toBe(new Date(at).toISOString())
      expect(dto.freshness?.funding.status).toBe('STALE')
      expect(dto.mark).toBe(105)
      const repository = new PostgresExecutionRepository(store)
      const risk = await repository.getBookContext(book.id)
      expect(risk.telemetry.mark).toBe(dto.mark)
      expect(risk.telemetry.bid).toBe(dto.bid)
      expect(risk.telemetry.fundingTimestamp).toBe(at - 20_000)
      expect(risk.position.unrealizedPnl).toBe(5)
      expect(evaluate(risk.book, risk.position, risk.reserve, risk.telemetry).state).toBe('SAFE_MODE')

      market.fundingTimestamp = Date.now()
      // Repeated market timestamp: the latest position observation breaks ties.
      vi.mocked(PerplAdapter.prototype.getPosition).mockResolvedValue(position(Date.now()))
      await venue!.refresh(book)
      const recovered = await repository.getBookContext(book.id)
      expect(recovered.telemetry.freshness?.funding.status).toBe('FRESH')
      expect(evaluate(recovered.book, recovered.position, recovered.reserve, recovered.telemetry).state).toBe('HOLD')
      expect((await store.getBook(user, book.id))?.status).toBe('ACTIVE')
      expect(await store.listActions(user, book.id)).toEqual([])
    } finally { await venue?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.close() }
  }, 20_000)
})
