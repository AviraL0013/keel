import { describe, expect, it, vi } from 'vitest'
import { KeelRuntime } from '../server/src/runtime.js'
import type { Action, Book } from '../packages/domain/src/index.js'

const book: Book = {
  id: 'book-1', userId: 'owner', market: 'BTC', side: 'LONG', stance: 'DEFEND',
  liquidationFloor: 6, defenseCap: 5, timeLimitMs: 86_400_000,
  automationEnabled: false, status: 'SAFE_MODE',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}
const action: Action = {
  id: 'action-1', bookId: book.id, decisionId: 'decision-1', kind: 'DEFEND',
  amount: 0.169106, status: 'UNKNOWN', idempotencyKey: 'decision-1:DEFEND',
  venueReference: '642:1', error: 'VENUE_OUTCOME_PENDING',
}

function runtimeFor(result: Action, active: Action = action) {
  const submit = vi.fn(async () => { throw new Error('MUST_NOT_RESUBMIT') })
  const reconcile = vi.fn(async () => result)
  const refresh = vi.fn(async () => undefined)
  const finalize = vi.fn(async () => undefined)
  const saveAction = vi.fn(async () => undefined)
  const store = { pool: { query: vi.fn(async () => ({ rows: [{ id: book.id, user_id: book.userId }] })) }, getBook: vi.fn(async () => book) }
  const runtime = new KeelRuntime(store as never, { submit, reconcile, refresh, ready: () => false, close: async () => undefined })
  Object.assign(runtime, {
    lease: { query: vi.fn(async () => ({ rows: [] })) },
    repository: { getActiveAction: vi.fn(async () => active), finalize, saveAction },
  })
  return { tick: () => (runtime as unknown as { tick(): Promise<void> }).tick(), submit, reconcile, refresh, finalize, saveAction }
}

describe('existing execution recovery', () => {
  it('backs off repeated REST 429 responses without changing existing execution', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const value = runtimeFor(action)
      value.reconcile.mockRejectedValueOnce(new Error('VENUE_HTTP_429')).mockRejectedValueOnce(new Error('VENUE_HTTP_429'))
      await value.tick()
      expect(value.reconcile).toHaveBeenCalledTimes(1)
      await value.tick()
      expect(value.reconcile).toHaveBeenCalledTimes(1)
      now.mockReturnValue(1_060_000)
      await value.tick()
      expect(value.reconcile).toHaveBeenCalledTimes(2)
      now.mockReturnValue(1_120_000)
      await value.tick()
      expect(value.reconcile).toHaveBeenCalledTimes(2)
      now.mockReturnValue(1_180_000)
      await value.tick()
      expect(value.reconcile).toHaveBeenCalledTimes(3)
      expect(value.finalize).not.toHaveBeenCalled()
      expect(value.submit).not.toHaveBeenCalled()
    } finally { now.mockRestore() }
  })

  it('waits between inconclusive history scans', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    try {
      const value = runtimeFor(action)
      await value.tick()
      await value.tick()
      expect(value.reconcile).toHaveBeenCalledTimes(1)
      now.mockReturnValue(2_030_000)
      await value.tick()
      expect(value.reconcile).toHaveBeenCalledTimes(2)
      expect(value.finalize).not.toHaveBeenCalled()
    } finally { now.mockRestore() }
  })

  it('does not reconcile or resubmit an action whose reference is not yet durable', async () => {
    const interrupted = { ...action, status: 'SUBMITTING' as const, venueReference: undefined }
    const value = runtimeFor(interrupted, interrupted)
    await value.tick()
    expect(value.finalize).not.toHaveBeenCalled()
    expect(value.reconcile).not.toHaveBeenCalled()
    expect(value.submit).not.toHaveBeenCalled()
  })

  it('reconciles UNKNOWN action with automation OFF, SAFE_MODE, and venue not ready', async () => {
    const value = runtimeFor(action)
    await value.tick()
    expect(value.reconcile).toHaveBeenCalledWith(action)
    expect(value.submit).not.toHaveBeenCalled()
    expect(value.finalize).not.toHaveBeenCalled()
  })

  it('records a duplicate venue reference as UNKNOWN without submitting or finalizing', async () => {
    const collision = { ...action, status: 'UNKNOWN' as const, error: 'VENUE_REFERENCE_COLLISION' }
    const value = runtimeFor(collision)
    await value.tick()
    expect(value.saveAction).toHaveBeenCalledWith(collision)
    expect(value.finalize).not.toHaveBeenCalled()
    expect(value.submit).not.toHaveBeenCalled()
  })

  it('finalizes only a conclusive venue outcome, without resubmitting', async () => {
    const resolved = { ...action, status: 'FAILED' as const, failedAt: new Date().toISOString(), error: 'PERPL_ORDER_REJECTED_403' }
    const value = runtimeFor(resolved)
    await value.tick()
    expect(value.finalize).toHaveBeenCalledWith(resolved)
    expect(value.submit).not.toHaveBeenCalled()
  })
})
