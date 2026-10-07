import { describe, expect, it } from 'vitest'
import { reconcileStrategyIntent, type StrategyOrderEvidence } from '../packages/strategies/src/order-reconciliation.js'
import type { VerifiedStrategyOperation } from '../packages/perpl/src/strategy-receipts.js'

const hash = `0x${'a'.repeat(64)}`
const intent = {
  accountId: 642,
  marketId: 16,
  requestId: '45',
  kind: 'POST' as const,
  lastExecutionBlock: 120,
  submittedAt: 1000,
  order: { acc: 642, mkt: 16, t: 1, p: 990, s: 100, lv: 100, fl: 1 as const, orderTtlBlocks: 20 },
}
const operation: VerifiedStrategyOperation = {
  accountId: 642,
  requestId: '45',
  marketId: 16,
  type: 1,
  orderId: '0',
  sizeRaw: '100',
  priceRaw: '990',
  leverageHundredths: 100,
  postOnly: true,
  fillOrKill: false,
  immediateOrCancel: false,
  expiryBlock: '0',
  amountRaw: '0',
  maxNegPnlCollatBps: '0',
  feePer100K: '0',
  lastExecutionBlock: 120,
  block: 110,
  txHash: hash,
  requestLogIndex: 0,
  outcomeLogIndex: 1,
  outcome: 'PLACED',
  venueOrderId: 75,
}
const open = { acc: 642, mkt: 16, oid: 75, rq: '45', st: 2, sr: 0, t: 1, os: 100, fs: 0, at: { b: 110, tx: 0, l: 1 } }
const evidence = (): StrategyOrderEvidence => ({
  snapshotReady: true,
  snapshot: [open],
  history: [open],
  historyComplete: true,
  operations: [operation],
  account: { lfr: '45', block: 120 },
})

describe('durable strategy command proof', () => {
  it('requires receipt-backed placement before trusting an OPEN or PARTIAL snapshot', () => {
    expect(reconcileStrategyIntent(intent, evidence(), 2000)).toMatchObject({
      status: 'OPEN',
      venueOrderId: 75,
      admission: { outcome: 'PLACED', block: 110, txHash: hash },
    })
    const partial = evidence()
    partial.snapshot[0] = { ...open, st: 3, fs: 40, at: { b: 500 } }
    expect(reconcileStrategyIntent(intent, partial, 300000)).toMatchObject({ status: 'PARTIAL', filledRaw: 40 })
    const unproved = evidence()
    unproved.operations = []
    expect(reconcileStrategyIntent(intent, unproved, 2000)).toMatchObject({
      status: 'UNKNOWN',
      error: 'STRATEGY_OUTCOME_VERIFYING',
    })
    expect(reconcileStrategyIntent(intent, unproved, 181000)).toMatchObject({
      status: 'UNKNOWN',
      error: 'VENUE_RECEIPT_UNVERIFIED',
    })
  })
  it('never calls executed command status 10 a fill, nor trusts a raw history hash', () => {
    const value = evidence()
    value.snapshot = []
    value.history = [{ ...open, st: 10, at: { b: 110, txid: hash.slice(2) } }]
    expect(reconcileStrategyIntent(intent, value, 200000)).toMatchObject({ status: 'UNKNOWN' })
    value.operations = []
    expect(reconcileStrategyIntent(intent, value, 200000).transactionHash).toBeUndefined()
  })
  it('refuses changed type, size, price, flags, market, target and execution after lb', () => {
    const changes: Partial<VerifiedStrategyOperation>[] = [
      { type: 2 },
      { sizeRaw: '101' },
      { priceRaw: '991' },
      { postOnly: false },
      { fillOrKill: true },
      { immediateOrCancel: true },
      { expiryBlock: '999' },
      { amountRaw: '1' },
      { maxNegPnlCollatBps: '100' },
      { feePer100K: '1' },
      { marketId: 17 },
      { orderId: '76' },
      { lastExecutionBlock: 121 },
      { block: 121 },
    ]
    for (const change of changes) {
      const value = evidence()
      value.operations = [{ ...operation, ...change }]
      expect(reconcileStrategyIntent(intent, value, 2000)).toMatchObject({
        status: 'FAILED',
        error: 'PERPL_REQUEST_ID_SUPERSEDED',
      })
    }
  })
  it('proves CANCEL and CHANGE only through their own command and exact owned target', () => {
    for (const kind of ['CANCEL', 'CHANGE'] as const) {
      const changed = {
        ...intent,
        kind,
        venueOrderId: 75,
        order: {
          ...intent.order,
          t: kind === 'CANCEL' ? 5 : 7,
          oid: 75,
          s: kind === 'CANCEL' ? 0 : 100,
          p: kind === 'CANCEL' ? undefined : 990,
          lv: 0,
          fl: 0 as const,
        },
      }
      const value = evidence()
      value.history = [{ ...open, rq: '44', st: kind === 'CANCEL' ? 5 : 2 }]
      value.operations = [
        {
          ...operation,
          type: changed.order.t,
          orderId: '75',
          sizeRaw: String(changed.order.s),
          priceRaw: String(changed.order.p ?? 0),
          leverageHundredths: 0,
          postOnly: false,
          outcome: kind === 'CANCEL' ? 'CANCELED' : 'CHANGED',
        },
      ]
      expect(reconcileStrategyIntent(changed, value, 2000).status).toBe(kind === 'CANCEL' ? 'CANCELED' : 'OPEN')
      value.operations = []
      expect(reconcileStrategyIntent(changed, value, 200000).status).toBe('UNKNOWN')
    }
  })
  it('requires complete history and signed low-word lfr proof for never executed', () => {
    const empty: StrategyOrderEvidence = {
      snapshotReady: false,
      snapshot: [],
      history: [],
      operations: [],
      historyComplete: true,
      account: { lfr: '44', block: 120 },
    }
    expect(reconcileStrategyIntent(intent, empty, 2000)).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_ORDER_WINDOW_EXPIRED',
    })
    expect(reconcileStrategyIntent(intent, { ...empty, historyComplete: false }, 200000).status).toBe('UNKNOWN')
    expect(reconcileStrategyIntent(intent, { ...empty, account: { lfr: '45', block: 120 } }, 200000).status).toBe(
      'UNKNOWN',
    )
    const wrapped = { ...intent, requestId: '4294967301' }
    expect(
      reconcileStrategyIntent(wrapped, { ...empty, account: { lfr: '4294967295', block: 120 } }, 2000).status,
    ).toBe('FAILED')
    expect(
      reconcileStrategyIntent(wrapped, { ...empty, account: { lfr: '4294967302', block: 120 } }, 200000).status,
    ).toBe('UNKNOWN')
  })
  it('does not declare a resting order expired because its command lb or three minutes passed', () => {
    expect(reconcileStrategyIntent(intent, evidence(), 200000).status).toBe('OPEN')
    const absent = evidence()
    absent.snapshot = []
    absent.history = []
    expect(reconcileStrategyIntent(intent, absent, 200000)).toMatchObject({
      status: 'UNKNOWN',
      admission: { outcome: 'PLACED' },
    })
  })
  it('does not let a stale same-block snapshot undo a later terminal observation', () => {
    const value = evidence()
    value.history = [{ ...open, st: 5, at: { b: 110, tx: 0, l: 2 } }]
    expect(reconcileStrategyIntent(intent, value, 200000).status).toBe('UNKNOWN')
    value.snapshot[0] = { ...open, at: { b: 110, tx: 0, l: 3 } }
    expect(reconcileStrategyIntent(intent, value, 200000).status).toBe('OPEN')
  })
})
