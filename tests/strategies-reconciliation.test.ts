import { describe, expect, it } from 'vitest'
import { reconcileStrategyOrder } from '../packages/strategies/src/order-reconciliation.js'
import type { WireOrder } from '../packages/perpl/src/decoder.js'

const order = (st: number, rq = '45', oid = 75): WireOrder => ({
  acc: 642,
  mkt: 16,
  oid,
  rq,
  st,
  sr: 0,
  t: 1,
  os: 10,
  fs: st === 3 ? 4 : 0,
  at: { b: 101, t: 1000 },
})
const intent = { accountId: 642, marketId: 16, requestId: '45', venueOrderId: 75 }

describe('resting strategy order recovery', () => {
  it('rebuilds an open or partial order only from the current venue snapshot', () => {
    expect(reconcileStrategyOrder(intent, { snapshotReady: true, snapshot: [order(2)], history: [] }).status).toBe(
      'OPEN',
    )
    expect(reconcileStrategyOrder(intent, { snapshotReady: true, snapshot: [order(3)], history: [] }).status).toBe(
      'PARTIAL',
    )
    expect(reconcileStrategyOrder(intent, { snapshotReady: true, snapshot: [], history: [order(2)] }).status).toBe(
      'UNKNOWN',
    )
  })
  it('uses terminal history and never infers cancellation from absence alone', () => {
    expect(reconcileStrategyOrder(intent, { snapshotReady: true, snapshot: [], history: [order(5)] }).status).toBe(
      'CANCELED',
    )
    expect(reconcileStrategyOrder(intent, { snapshotReady: true, snapshot: [], history: [order(7)] }).status).toBe(
      'FAILED',
    )
    expect(reconcileStrategyOrder(intent, { snapshotReady: true, snapshot: [], history: [] }).status).toBe('UNKNOWN')
    expect(
      reconcileStrategyOrder(intent, { snapshotReady: true, snapshot: [], history: [], continuousExpiryProof: true })
        .status,
    ).toBe('EXPIRED')
  })
  it('ignores other accounts and other request IDs', () => {
    const result = reconcileStrategyOrder(intent, {
      snapshotReady: true,
      snapshot: [{ ...order(2), acc: 643 }],
      history: [order(4, '46')],
    })
    expect(result.status).toBe('UNKNOWN')
  })
})
