import { describe, expect, it, vi } from 'vitest'
import type { Action } from '../packages/domain/src/index.js'
import { KeelRuntime, classifySafeModeCause, type RuntimeVenue } from '../server/src/runtime.js'
import { loadConfig } from '../packages/shared/src/index.js'
import { databaseFixture } from './helpers/database.js'

async function fixture() {
  const { db, store } = await databaseFixture()
  const clock = { at: Date.now() }
  const userId = await store.ensureUser('safe-mode-owner')
  const book = await store.createBook(userId, { market: 'ETH-PERP', marketId: 2, venueAccountId: 7, venuePositionId: 10, side: 'LONG', stance: 'DEFEND', status: 'ACTIVE', automationEnabled: true, liquidationFloor: 6, defenseCap: 5, reserveAvailable: 10, timeLimitMs: 3_600_000,
    initialPosition: { side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 95, liquidationPrice: 90, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: clock.at, observedAt: clock.at },
    initialTelemetry: { mark: 95, oracle: 95, bid: 94.9, ask: 95.1, mid: 95, spreadBps: 20, fundingRate: 0, depthNotional: 10_000, volatility: 0, volume24h: 1, openInterest: 1, block: 1, timestamp: clock.at, source: 'replay' } })
  const state = { stale: false, ready: true, failure: '', outcome: 'FAILED' as 'FAILED' | 'UNKNOWN' | 'PARTIAL' }
  const submit = vi.fn(async (_action: Action) => ({ venueReference: 'safe-mode-test', status: state.outcome === 'FAILED' ? 'FAILED' as const : 'SUBMITTED' as const, reason: 'TEST_FAILURE' }))
  const venue: RuntimeVenue = { ready: () => state.ready, refresh: async () => {
    if (state.failure) throw new Error(state.failure)
    const at = new Date(clock.at - (state.stale ? 60_000 : 0)).toISOString()
    await db.query('UPDATE positions SET observed_at=$2 WHERE book_id=$1', [book.id, at])
    await db.query('UPDATE risk_snapshots SET timestamp=$2,freshness_detail=NULL WHERE book_id=$1', [book.id, at])
  }, submit, reconcile: async action => ({ ...action, status: state.outcome }), close: async () => undefined }
  const runtime = () => { const value = new KeelRuntime(store, venue, () => clock.at); Object.assign(value, { lease: { query: async () => ({ rows: [] }) } }); return { tick: () => (value as unknown as { tick(): Promise<void> }).tick(), closeBook: () => value.closeBook(userId, book.id) } }
  const bookState = () => store.getBook(userId, book.id)
  const events = async (type: string) => (await db.query('SELECT id FROM autopsy_events WHERE book_id=$1 AND type=$2', [book.id, type])).rows
  const notices = async (kind: string) => (await db.query('SELECT id FROM notifications WHERE user_id=$1 AND kind=$2', [userId, kind])).rows
  return { db, store, book, clock, state, submit, runtime, bookState, events, notices, close: () => db.close() }
}

describe('safe mode causes', () => {
  it.each([
    ['MARKET_STALE', 'DATA_UNAVAILABLE'], ['POSITION_UNKNOWN', 'DATA_UNAVAILABLE'], ['BOTH_STALE', 'DATA_UNAVAILABLE'], ['STALE_STATE', 'DATA_UNAVAILABLE'], ['TELEMETRY_INVALID', 'DATA_UNAVAILABLE'],
    ['TELEMETRY_NOT_AVAILABLE', 'DATA_UNAVAILABLE'], ['VENUE_NOT_CONNECTED', 'VENUE_UNAVAILABLE'], ['PERPL_STATE_UNAVAILABLE', 'VENUE_UNAVAILABLE'], ['PERPL_TRADING_STATE_UNTRUSTED', 'VENUE_UNAVAILABLE'], ['VENUE_HTTP_429', 'VENUE_UNAVAILABLE'], ['VENUE_NOT_CONFIGURED', 'RUNTIME_FAILURE'], ['UNEXPECTED', 'RUNTIME_FAILURE'],
  ])('classifies %s as %s', (code, cause) => { expect(classifySafeModeCause(code)).toBe(cause) })
  it('defaults to five recovery ticks and rejects an invalid setting', () => { expect(loadConfig({}).safeModeResumeTicks).toBe(5); expect(() => loadConfig({ KEEL_SAFE_MODE_RESUME_TICKS: '0' })).toThrow('INVALID_KEEL_SAFE_MODE_RESUME_TICKS') })

  it('keeps automation armed on stale data and resumes only after five fresh ticks', async () => {
    const value = await fixture()
    try {
      const runtime = value.runtime(); value.state.stale = true
      await runtime.tick()
      expect(await value.bookState()).toMatchObject({ status: 'SAFE_MODE', automationEnabled: true, safeModeReason: 'DATA_UNAVAILABLE' })
      expect(value.submit).not.toHaveBeenCalled()
      expect(await value.events('SAFE_MODE_ENTERED')).toHaveLength(1)
      value.state.stale = false
      for (let i = 0; i < 4; i++) { value.clock.at += 1000; await runtime.tick() }
      expect((await value.bookState())?.status).toBe('SAFE_MODE')
      value.clock.at += 1000; await runtime.tick()
      expect(await value.bookState()).toMatchObject({ status: 'ACTIVE', automationEnabled: true, safeModeReason: null })
      expect(value.submit).not.toHaveBeenCalled()
      expect(await value.events('SAFE_MODE_EXITED')).toHaveLength(1)
      expect(await value.notices('SAFE_MODE_EXITED')).toHaveLength(1)
    } finally { await value.close() }
  }, 20_000)

  it('resets the resume count on a stale tick and across runtime restart', async () => {
    const value = await fixture()
    try {
      value.state.stale = true; await value.runtime().tick()
      value.state.stale = false; const runtime = value.runtime()
      for (let i = 0; i < 3; i++) { value.clock.at += 1000; await runtime.tick() }
      value.state.stale = true; value.clock.at += 1000; await runtime.tick()
      value.state.stale = false
      for (let i = 0; i < 3; i++) { value.clock.at += 1000; await runtime.tick() }
      expect((await value.bookState())?.status).toBe('SAFE_MODE')
      const restarted = value.runtime()
      for (let i = 0; i < 4; i++) { value.clock.at += 1000; await restarted.tick() }
      expect((await value.bookState())?.status).toBe('SAFE_MODE')
      value.clock.at += 1000; await restarted.tick()
      expect((await value.bookState())?.status).toBe('ACTIVE')
    } finally { await value.close() }
  }, 20_000)

  it('treats venue disconnect as transient, with one entry notification', async () => {
    const value = await fixture()
    try {
      const runtime = value.runtime(); value.state.ready = false
      await runtime.tick(); await runtime.tick()
      expect(await value.bookState()).toMatchObject({ status: 'SAFE_MODE', automationEnabled: true, safeModeReason: 'VENUE_UNAVAILABLE' })
      expect(await value.events('SAFE_MODE_ENTERED')).toHaveLength(1)
      expect(await value.notices('SAFE_MODE')).toHaveLength(1)
      value.state.ready = true
      for (let i = 0; i < 5; i++) { value.clock.at += 1000; await runtime.tick() }
      expect((await value.bookState())?.status).toBe('ACTIVE')
      expect(value.submit).not.toHaveBeenCalled()
    } finally { await value.close() }
  }, 20_000)

  it('turns automation off for unknown runtime errors and does not resume after kill', async () => {
    const value = await fixture()
    try {
      const runtime = value.runtime(); value.state.failure = 'UNEXPECTED'
      await runtime.tick()
      expect(await value.bookState()).toMatchObject({ status: 'SAFE_MODE', automationEnabled: false, safeModeReason: 'RUNTIME_FAILURE' })
      value.state.failure = ''; value.clock.at += 1000; await runtime.tick()
      expect((await value.bookState())?.status).toBe('SAFE_MODE')
    } finally { await value.close() }
  }, 20_000)

  it('ends a transient episode when killed', async () => {
    const value = await fixture()
    try {
      const runtime = value.runtime(); value.state.ready = false; await runtime.tick()
      await value.store.updateBookControls(value.book.userId, value.book.id, { automationEnabled: false, stance: 'KILL' })
      value.state.ready = true
      for (let i = 0; i < 6; i++) { value.clock.at += 1000; await runtime.tick() }
      expect(await value.bookState()).toMatchObject({ status: 'PAUSED', automationEnabled: false, safeModeReason: null })
      expect(value.submit).not.toHaveBeenCalled()
    } finally { await value.close() }
  }, 20_000)

  it('ends a transient episode when paused', async () => {
    const value = await fixture()
    try {
      const runtime = value.runtime(); value.state.ready = false; await runtime.tick()
      await value.store.updateBookControls(value.book.userId, value.book.id, { automationEnabled: false, status: 'PAUSED' })
      value.state.ready = true
      for (let i = 0; i < 6; i++) { value.clock.at += 1000; await runtime.tick() }
      expect(await value.bookState()).toMatchObject({ status: 'PAUSED', automationEnabled: false, safeModeReason: null })
      expect(value.submit).not.toHaveBeenCalled()
    } finally { await value.close() }
  }, 20_000)

  it('allows a user close during transient safe mode', async () => {
    const value = await fixture()
    try {
      const runtime = value.runtime(); value.state.ready = false; await runtime.tick()
      value.state.ready = true
      const result = await runtime.closeBook()
      expect(result.status).toBe('FAILED')
      expect(value.submit).toHaveBeenCalledTimes(1)
    } finally { await value.close() }
  }, 20_000)

  it.each(['UNKNOWN', 'PARTIAL'] as const)('keeps %s actions unresolved with automation off', async outcome => {
    const value = await fixture()
    try {
      value.state.outcome = outcome
      const runtime = value.runtime(); await runtime.tick()
      expect(await value.bookState()).toMatchObject({ status: 'SAFE_MODE', automationEnabled: false, safeModeReason: 'UNRESOLVED_ACTION' })
      for (let i = 0; i < 6; i++) { value.clock.at += 1000; await runtime.tick() }
      expect(value.submit).toHaveBeenCalledTimes(1)
      expect((await value.bookState())?.status).toBe('SAFE_MODE')
    } finally { await value.close() }
  }, 20_000)
})
