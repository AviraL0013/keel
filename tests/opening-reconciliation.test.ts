import { describe, expect, it } from 'vitest'
import { reconcileOpening, type OpeningEvidence } from '../packages/perpl/src/opening-reconciliation.js'

const openedAt = new Date('2026-01-01T00:00:00.000Z').getTime()
const input = {
  accountId: 12,
  marketId: 7,
  requestId: '45',
  lastExecutionBlock: 111,
  side: 'LONG' as const,
  sizeRaw: 100,
  priceLimitRaw: 1000001,
  leverageHundredths: 500,
  sizeDecimals: 5,
  priceDecimals: 1,
  submittedAt: openedAt,
}
const empty: OpeningEvidence = {
  account: { lfr: '44', block: 110 },
  orders: [],
  fills: [],
  positions: [],
  operations: [],
}

describe('IOC opening reconciliation', () => {
  it('fails only after signed lfr and block prove that the request never executed', () => {
    expect(reconcileOpening(input, empty, openedAt + 1_000).status).toBe('VERIFYING')
    expect(reconcileOpening(input, { ...empty, account: { lfr: '44', block: 111 } }, openedAt + 1_000)).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_ORDER_WINDOW_EXPIRED',
    })
    expect(reconcileOpening(input, empty, openedAt + 180_001).status).toBe('UNKNOWN')
  })

  it('requires receipt-backed operation, exact fills, and matching position before confirming', () => {
    const evidence: OpeningEvidence = {
      account: { lfr: '45', block: 111 },
      operations: [
        {
          requestId: '45',
          type: 1,
          marketId: 7,
          block: 110,
          txHash: `0x${'a'.repeat(64)}`,
          sizeRaw: '100',
          positionId: 0,
          priceRaw: '1000001',
          leverageHundredths: 500,
          immediateOrCancel: true,
          lastExecutionBlock: 111,
        },
      ],
      orders: [{ acc: 12, mkt: 7, rq: '45', oid: 9, t: 1, os: 100, fs: 100, st: 4, sr: 0, at: { b: 110 } }],
      fills: [{ acc: 12, mkt: 7, oid: 9, t: 1, s: 100, p: 1000000, f: '0', at: { b: 110 } }],
      positions: [
        {
          acc: 12,
          mkt: 7,
          pid: 98,
          rq: '45',
          oid: 9,
          st: 1,
          sd: 1,
          s: 100,
          ep: 1000000,
          c: '1000000',
          lv: 500,
          at: { b: 110 },
          efs: 0,
          xfs: 0,
          fee: '0',
        },
      ],
    }
    expect(reconcileOpening(input, { ...evidence, operations: [] }, openedAt + 1_000).status).toBe('VERIFYING')
    expect(reconcileOpening(input, evidence, openedAt + 1_000)).toMatchObject({
      status: 'CONFIRMED',
      filledSize: '0.00100',
      positionId: 98,
      txHash: `0x${'a'.repeat(64)}`,
    })
    expect(
      reconcileOpening(
        input,
        { ...evidence, operations: [{ ...evidence.operations[0], priceRaw: '1000002' }] },
        openedAt + 1_000,
      ),
    ).toMatchObject({ status: 'FAILED', error: 'PERPL_REQUEST_ID_SUPERSEDED' })
    for (const changed of [{ leverageHundredths: 600 }, { immediateOrCancel: false }, { lastExecutionBlock: 112 }]) {
      expect(
        reconcileOpening(
          input,
          { ...evidence, operations: [{ ...evidence.operations[0], ...changed }] },
          openedAt + 1_000,
        ),
      ).toMatchObject({ status: 'FAILED', error: 'PERPL_REQUEST_ID_SUPERSEDED' })
    }
    const partial = {
      ...evidence,
      orders: [{ ...evidence.orders[0], fs: 40, st: 3 }],
      fills: [{ ...evidence.fills[0], s: 40 }],
      positions: [{ ...evidence.positions[0], s: 40 }],
    }
    expect(reconcileOpening(input, partial, openedAt + 1_000)).toMatchObject({
      status: 'PARTIAL',
      filledSize: '0.00040',
      positionId: 98,
    })
  })

  it('rejects a superseded request, including execution after lb', () => {
    const evidence: OpeningEvidence = {
      ...empty,
      account: { lfr: '45', block: 112 },
      operations: [
        { requestId: '45', type: 2, marketId: 7, block: 112, txHash: `0x${'b'.repeat(64)}`, sizeRaw: '100' },
      ],
    }
    expect(reconcileOpening(input, evidence, openedAt + 1_000)).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_REQUEST_ID_SUPERSEDED',
    })
  })
})
