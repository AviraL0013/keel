import { describe, expect, it, vi } from 'vitest'
import { ExecutionWorker } from '../server/src/workers/execution-worker.js'
import { PerplPreSubmissionError } from '../packages/perpl/src/trading.js'
import { evaluateManualAction } from '../packages/risk-engine/src/index.js'
import type { Action, Book, Decision, NormalizedTelemetry, Position, Reserve } from '../packages/domain/src/index.js'
const book: Book = {
  id: 'b',
  userId: 'u',
  market: 'BTC',
  side: 'LONG',
  stance: 'DEFEND',
  liquidationFloor: 6,
  defenseCap: 100,
  timeLimitMs: 3600000,
  automationEnabled: true,
  status: 'ACTIVE',
  createdAt: new Date(Date.now() - 1000).toISOString(),
  updatedAt: new Date().toISOString(),
}
const position: Position = {
  bookId: 'b',
  side: 'LONG',
  size: 1,
  entryPrice: 100,
  markPrice: 98,
  liquidationPrice: 94,
  leverage: 6,
  unrealizedPnl: -2,
  margin: 16,
  status: 'OPEN',
  timestamp: Date.now(),
}
const reserve: Reserve = {
  bookId: 'b',
  available: 100,
  reserved: 0,
  deployed: 0,
  cap: 100,
  updatedAt: new Date().toISOString(),
}
const telemetry: NormalizedTelemetry = {
  mark: 98,
  oracle: 98,
  bid: 97.9,
  ask: 98.1,
  mid: 98,
  spreadBps: 20,
  fundingRate: 0,
  depthNotional: 10000,
  volatility: 0.01,
  volume24h: 100,
  openInterest: 100,
  block: 1,
  timestamp: Date.now(),
  source: 'replay',
  freshnessMs: 1,
}
function repo() {
  const actions: Action[] = []
  const events: unknown[] = []
  const decisions: Decision[] = []
  return {
    actions,
    events,
    decisions,
    getActionByIdempotency: async (key: string) => actions.find((a) => a.idempotencyKey === key) ?? null,
    getActiveAction: async (bookId: string) =>
      actions.find(
        (a) =>
          a.bookId === bookId &&
          ['QUEUED', 'VALIDATING', 'SUBMITTING', 'SUBMITTED', 'VERIFYING', 'UNKNOWN'].includes(a.status),
      ) ?? null,
    saveAction: async (a: Action) => {
      const i = actions.findIndex((x) => x.id === a.id)
      if (i < 0) actions.push({ ...a })
      else actions[i] = { ...a }
    },
    saveDecision: async (d: Decision) => {
      decisions.push(d)
    },
    addEvent: async (e: unknown) => {
      events.push(e)
    },
    getBookContext: async () => ({ book, position, reserve, priorDefenseEfficiency: Infinity, telemetry }),
    updateReserve: async () => undefined,
  }
}
describe('execution worker safety', () => {
  it.each([false, true])('blocks new submission before creating an action (manual=%s)', async (manual) => {
    const r = repo()
    const submit = vi.fn(async () => ({ venueReference: 'venue-1', status: 'SUBMITTED' as const }))
    const venue = {
      submit,
      reconcile: async (a: Action) => ({ ...a, status: 'CONFIRMED' as const }),
    }
    let disabled = true
    const worker = new ExecutionWorker(r, venue, undefined, Date.now, () => disabled)
    const decision = manual
      ? evaluateManualAction(book, position, reserve, telemetry, 'DEFEND', Infinity, Date.now())
      : await worker.evaluate('b')
    await expect(worker.execute(decision, false, manual)).rejects.toThrow('EXECUTION_DISABLED')
    expect(r.actions).toHaveLength(0)
    expect(submit).not.toHaveBeenCalled()
    disabled = false
    const result = await worker.execute(decision, false, manual)
    expect(result.status).toBe('CONFIRMED')
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('does not duplicate an idempotent action and records confirmed audit', async () => {
    const r = repo()
    const venue = {
      submit: async (_a: Action) => ({ venueReference: 'venue-1', status: 'SUBMITTED' as const }),
      reconcile: async (a: Action) => ({ ...a, status: 'CONFIRMED' as const, confirmedAt: new Date().toISOString() }),
    }
    const worker = new ExecutionWorker(r, venue)
    const decision = await worker.evaluate('b')
    expect(decision.action).toBe('DEFEND')
    const first = await worker.execute(decision)
    expect(first.status).toBe('CONFIRMED')
    expect(r.actions).toHaveLength(1)
    expect((await worker.execute(decision)).id).toBe(first.id)
    expect(r.actions).toHaveLength(1)
    expect(r.events).toHaveLength(3)
  })
  it('keeps timeout unknown and does not treat it as failure', async () => {
    const r = repo()
    const venue = {
      submit: async () => ({ venueReference: 'unknown', status: 'UNKNOWN' as const }),
      reconcile: async (a: Action) => a,
    }
    const worker = new ExecutionWorker(r, venue)
    const decision = await worker.evaluate('b')
    const action = await worker.execute(decision)
    expect(action.status).toBe('UNKNOWN')
    expect(action.error).toBe('VENUE_OUTCOME_UNKNOWN')
  })
})

describe('execution submission boundary', () => {
  it('keeps a reconciled close CONFIRMED when the subsequent refresh is rate limited', async () => {
    const r = repo()
    const worker = new ExecutionWorker(
      r,
      {
        submit: async () => ({ venueReference: '642:51:77', status: 'SUBMITTED' as const }),
        reconcile: async (action) => ({
          ...action,
          status: 'CONFIRMED' as const,
          confirmedAt: new Date().toISOString(),
        }),
      },
      async () => {
        throw new Error('VENUE_HTTP_429')
      },
    )
    const action = await worker.execute(await worker.evaluate('b'))
    expect(action.status).toBe('CONFIRMED')
    expect(r.actions[0].status).toBe('CONFIRMED')
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'POST_CONFIRMATION_REFRESH_DEFERRED' }))
  })
  it('records a failure before venue adapter invocation as FAILED', async () => {
    const r = repo()
    const original = r.saveAction
    r.saveAction = async (action) => {
      if (action.status === 'SUBMITTING') throw new Error('ACTION_PERSIST_FAILED')
      await original(action)
    }
    let submitted = false
    const worker = new ExecutionWorker(r, {
      submit: async () => {
        submitted = true
        throw new Error('MUST_NOT_SUBMIT')
      },
      reconcile: async (action) => action,
    })
    const action = await worker.execute(await worker.evaluate('b'))
    expect(submitted).toBe(false)
    expect(action).toMatchObject({ status: 'FAILED', error: 'ACTION_PERSIST_FAILED' })
  })
  it('records pre-venue refusal as FAILED and never calls reconciliation', async () => {
    const r = repo()
    const reconcile = async (_action: Action) => {
      throw new Error('RECONCILIATION_MUST_NOT_RUN')
    }
    const worker = new ExecutionWorker(r, {
      submit: async (action) => {
        action.venueReference = '642:1791001362441'
        throw new PerplPreSubmissionError('MARKET_TELEMETRY_STALE')
      },
      reconcile,
    })
    const decision = await worker.evaluate('b')
    const action = await worker.execute(decision)
    expect(action).toMatchObject({ status: 'FAILED', error: 'MARKET_TELEMETRY_STALE' })
    expect(action.venueReference).toBeUndefined()
    expect(r.actions[0].venueReference).toBeUndefined()
  })
  it('keeps ambiguous transport errors UNKNOWN after submission attempt', async () => {
    const r = repo()
    const worker = new ExecutionWorker(r, {
      submit: async (action) => {
        action.venueReference = '642:45'
        throw new Error('TRANSPORT_CLOSED')
      },
      reconcile: async (action) => action,
    })
    const action = await worker.execute(await worker.evaluate('b'))
    expect(action).toMatchObject({ status: 'UNKNOWN', venueReference: '642:45', error: 'TRANSPORT_CLOSED' })
  })
})
