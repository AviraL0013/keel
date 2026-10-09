import { afterEach, expect, it, vi } from 'vitest'
import { EyelerRuntime, type RuntimeVenue } from '../server/src/runtime.js'
import type { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'
import { StrategyWorker, PerplPaperFeed } from '../server/src/workers/strategy-worker.js'
import { StrategyOrderRecovery } from '../server/src/infrastructure/strategies/order-recovery.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([undefined, 'false', 'TRUE', '1'])('does not create or run strategy services with flag %s', async (flag) => {
  vi.stubEnv('EYELER_STRATEGIES_ENABLED', flag)
  vi.useFakeTimers()
  const feed = vi.spyOn(PerplPaperFeed.prototype, 'sample')
  const worker = vi.spyOn(StrategyWorker.prototype, 'tick')
  const cleanup = vi.spyOn(StrategyWorker.prototype, 'close')
  const recovery = vi.spyOn(StrategyOrderRecovery.prototype, 'recover')
  const query = vi.fn(async () => ({ rows: [] }))
  const lease = {
    query: vi.fn(async (sql: string) => ({ rows: sql.includes('pg_try_advisory_lock') ? [{ owned: true }] : [] })),
    release: vi.fn(),
    on: vi.fn(),
  }
  const store = { pool: { query, connect: async () => lease } } as unknown as PostgresStore
  const runtime = new EyelerRuntime(store, undefined, Date.now, 5, 'testnet')
  await runtime.start()
  await vi.advanceTimersByTimeAsync(6_000)
  await runtime.stop()
  expect(query).toHaveBeenCalled() // Existing Book monitoring still runs.
  expect(query.mock.calls.some(([sql]) => /strateg/i.test(sql))).toBe(false)
  expect(worker).not.toHaveBeenCalled()
  expect(recovery).not.toHaveBeenCalled()
  expect(cleanup).not.toHaveBeenCalled()
  expect(feed).not.toHaveBeenCalled()
})

it('creates strategy services only with explicit true and runs them only while holding the lease', async () => {
  vi.stubEnv('EYELER_STRATEGIES_ENABLED', 'true')
  vi.useFakeTimers()
  const worker = vi.spyOn(StrategyWorker.prototype, 'tick').mockResolvedValue()
  const recovery = vi.spyOn(StrategyOrderRecovery.prototype, 'recover').mockResolvedValue()
  const cleanup = vi.spyOn(StrategyWorker.prototype, 'close').mockResolvedValue()
  let owned = false
  const lease = {
    query: vi.fn(async (sql: string) => ({ rows: sql.includes('pg_try_advisory_lock') ? [{ owned }] : [] })),
    release: vi.fn(),
    on: vi.fn(),
  }
  const store = {
    pool: { query: vi.fn(async () => ({ rows: [] })), connect: async () => lease },
  } as unknown as PostgresStore
  const venue = { ready: () => true, start: vi.fn(), close: vi.fn() } as unknown as RuntimeVenue
  const runtime = new EyelerRuntime(store, venue, Date.now, 5, 'testnet')
  await runtime.start()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(worker).not.toHaveBeenCalled()
  expect(recovery).not.toHaveBeenCalled()
  owned = true
  await vi.advanceTimersByTimeAsync(2_000)
  expect(worker).toHaveBeenCalled()
  expect(recovery).toHaveBeenCalled()
  await runtime.stop()
  const calls = worker.mock.calls.length
  await vi.advanceTimersByTimeAsync(6_000)
  expect(worker).toHaveBeenCalledTimes(calls)
  expect(cleanup).toHaveBeenCalledOnce()
})
