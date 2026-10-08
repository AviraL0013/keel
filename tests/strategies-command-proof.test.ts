import { describe, expect, it } from 'vitest'
import {
  reconcileStrategyIntent,
  strategyHistoryLowerBound,
  type StrategyOrderEvidence,
} from '../packages/strategies/src/order-reconciliation.js'
import type { VerifiedStrategyOperation } from '../packages/perpl/src/strategy-receipts.js'

const hash = `0x${'a'.repeat(64)}`
const intent = {
  accountId: 642,
  marketId: 16,
  contractMarketId: 16,
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
  contractOrderId: 75,
  transactionIndex: 0,
  requestTransactionLogIndex: 0,
  outcomeTransactionLogIndex: 1,
  identity: {
    accountId: 642,
    marketId: 16,
    contractMarketId: 16,
    venueOrderId: 75,
    contractOrderId: 75,
    placementRequestId: '45',
    type: 1,
    creationBlock: 110,
    creationTransactionIndex: 0,
    creationTxHash: hash,
  },
}
const open = {
  acc: 642,
  mkt: 16,
  oid: 75,
  scid: 75,
  rq: '45',
  st: 2,
  sr: 0,
  t: 1,
  os: 100,
  fs: 0,
  c: { b: 110, tx: 0, txid: hash.slice(2) },
  at: { b: 110, tx: 0, l: 1 },
}
const evidence = (): StrategyOrderEvidence => ({
  snapshotReady: true,
  snapshot: [open],
  history: [open],
  historyComplete: true,
  operations: [operation],
  account: { lfr: '45', block: 120 },
})

describe('durable strategy command proof', () => {
  it('bounds history only by a fully validated durable admission, never by lb or an unproved target', () => {
    expect(strategyHistoryLowerBound(intent)).toBeUndefined()
    expect(strategyHistoryLowerBound({ ...intent, previousIdentity: operation.identity })).toBeUndefined()
    expect(strategyHistoryLowerBound({ ...intent, previousAdmission: operation })).toBe(110)
    for (const changed of [
      { priceRaw: '991' },
      { accountId: 643 },
      { lastExecutionBlock: 121 },
      { block: 121 },
      { identity: { ...operation.identity!, creationBlock: 119 } },
    ])
      expect(strategyHistoryLowerBound({ ...intent, previousAdmission: { ...operation, ...changed } })).toBeUndefined()
    for (const kind of ['CHANGE', 'CANCEL'] as const) {
      const order = {
        ...intent.order,
        oid: 75,
        t: kind === 'CHANGE' ? 7 : 5,
        fl: 0 as const,
        p: kind === 'CHANGE' ? 990 : 0,
        s: kind === 'CHANGE' ? 100 : 0,
      }
      const command = { ...intent, requestId: '46', kind, order, venueOrderId: 75, targetIdentity: operation.identity }
      expect(strategyHistoryLowerBound(command)).toBeUndefined()
      const prior = {
        ...operation,
        requestId: '46',
        type: order.t,
        orderId: '75',
        block: 119,
        txHash: `0x${'b'.repeat(64)}`,
        sizeRaw: String(order.s),
        priceRaw: String(order.p),
        postOnly: false,
        outcome: kind === 'CHANGE' ? ('CHANGED' as const) : ('CANCELED' as const),
      }
      expect(strategyHistoryLowerBound({ ...command, previousAdmission: prior })).toBe(110)
    }
  })
  it('never accepts an API order borrowing a reused contract slot from another placement lifetime', () => {
    const value = evidence()
    value.snapshot = [{ ...open, rq: '99', c: { b: 111, tx: 0, txid: 'b'.repeat(64) }, scid: 75 }]
    expect(reconcileStrategyIntent(intent, value, 200000)).toMatchObject({ status: 'UNKNOWN' })
  })
  it('never accepts malformed null builder observation as empty or saved admission', () => {
    const malformed = { ...operation, builderId: null, builderFeePer100K: '0' } as unknown as VerifiedStrategyOperation
    const value = evidence()
    value.operations = [malformed]
    expect(reconcileStrategyIntent(intent, value, 200000)).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_REQUEST_ID_SUPERSEDED',
    })
    value.operations = []
    expect(reconcileStrategyIntent({ ...intent, previousAdmission: malformed }, value, 200000)).toMatchObject({
      status: 'UNKNOWN',
      error: 'STRATEGY_SAVED_PROOF_UNVERIFIED',
    })
  })
  it('matches builder attribution to immutable terms and distinguishes empty from builder zero', () => {
    const attributedIntent = { ...intent, builderId: 25, builderFeePer100K: 0 }
    const value = evidence()
    value.operations = [{ ...operation, builderId: 25, builderFeePer100K: '0' }]
    expect(reconcileStrategyIntent(attributedIntent, value, 2000)).toMatchObject({ status: 'OPEN' })
    expect(reconcileStrategyIntent(intent, value, 2000)).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_REQUEST_ID_SUPERSEDED',
    })
    for (const observed of [
      operation,
      { ...operation, builderId: 26, builderFeePer100K: '0' },
      { ...operation, builderId: 25, builderFeePer100K: '1' },
      { ...operation, builderId: 25 },
    ]) {
      value.operations = [observed]
      expect(reconcileStrategyIntent(attributedIntent, value, 2000)).toMatchObject({
        status: 'FAILED',
        error: 'PERPL_REQUEST_ID_SUPERSEDED',
      })
    }
    value.operations = [{ ...operation, builderId: 0, builderFeePer100K: '0' }]
    expect(reconcileStrategyIntent(intent, value, 2000).status).toBe('FAILED')
  })
  it('does not treat partially present or malformed immutable builder terms as no-builder', () => {
    for (const terms of [
      { builderId: 25 },
      { builderFeePer100K: 0 },
      { builderId: 0, builderFeePer100K: 0 },
      { builderId: 25, builderFeePer100K: 1 },
    ]) {
      expect(reconcileStrategyIntent({ ...intent, ...terms }, evidence(), 200000)).toMatchObject({
        status: 'UNKNOWN',
        error: 'STRATEGY_INTENT_UNVERIFIED',
      })
    }
  })
  it('retains saved admission when later builder attribution conflicts', () => {
    const attributedIntent = {
      ...intent,
      builderId: 25,
      builderFeePer100K: 0,
      previousAdmission: { ...operation, builderId: 25, builderFeePer100K: '0' },
    }
    const value = evidence()
    value.operations = [{ ...operation, builderId: 26, builderFeePer100K: '0' }]
    expect(reconcileStrategyIntent(attributedIntent, value, 200000)).toMatchObject({
      status: 'UNKNOWN',
      error: 'STRATEGY_ADMISSION_CONFLICT',
      admission: { builderId: 25 },
    })
  })
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
        targetIdentity: operation.identity,
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
