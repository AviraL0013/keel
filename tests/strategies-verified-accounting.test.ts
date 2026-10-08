import { describe, expect, it } from 'vitest'
import {
  applyVerifiedAccountingEvent,
  emptyVerifiedAccounting,
  type VerifiedAccountingEvent,
} from '../packages/strategies/src/verified-accounting.js'

const proof = { receipt: '0xreceipt', history: 'history:1', order: 'order:1' }
const fill = (overrides: Partial<Extract<VerifiedAccountingEvent, { kind: 'FILL' }>> = {}) => ({
  kind: 'FILL' as const,
  identity: 'fill-1',
  sequence: { block: 10, transaction: 0, log: 0 },
  side: 'BUY' as const,
  size: '2.5',
  price: '10.00',
  fee: '0.01',
  proof,
  ...overrides,
})

describe('verified strategy accounting projection', () => {
  it('credits duplicate-safe average entry, partial close, fees and signed funding exactly', () => {
    let state = emptyVerifiedAccounting()
    state = applyVerifiedAccountingEvent(state, fill()).state
    state = applyVerifiedAccountingEvent(
      state,
      fill({
        identity: 'fill-2',
        sequence: { block: 11, transaction: 0, log: 0 },
        size: '1.5',
        price: '12.00',
        fee: '0.006',
      }),
    ).state
    state = applyVerifiedAccountingEvent(
      state,
      fill({
        identity: 'fill-3',
        sequence: { block: 12, transaction: 0, log: 0 },
        side: 'SELL',
        size: '2',
        price: '13.00',
        fee: '0.008',
      }),
    ).state
    const funding: VerifiedAccountingEvent = {
      kind: 'FUNDING',
      identity: 'fund-1',
      sequence: { block: 13, transaction: 0, log: 0 },
      amount: '0.25',
      proof,
    }
    state = applyVerifiedAccountingEvent(state, funding).state
    expect(state.positionSize).toBe('2')
    expect(state.averageEntry).toBe('10.75')
    expect(state.realizedPnl).toBe('4.5')
    expect(state.feesPaid).toBe('0.024')
    expect(state.fundingPaid).toBe('0.25')
    expect(applyVerifiedAccountingEvent(state, fill()).applied).toBe(false)
    expect(applyVerifiedAccountingEvent(state, funding).state).toEqual(state)
  })

  it('accepts exact partial fills across restart, but rejects an unseen out-of-order event', () => {
    let state = emptyVerifiedAccounting()
    state = applyVerifiedAccountingEvent(state, fill({ size: '0.333333', price: '7.123456' })).state
    state = JSON.parse(JSON.stringify(state))
    expect(() =>
      applyVerifiedAccountingEvent(state, fill({ identity: 'older', sequence: { block: 9, transaction: 0, log: 0 } })),
    ).toThrow('VERIFIED_ACCOUNTING_OUT_OF_ORDER')
    expect(state.positionSize).toBe('0.333333')
  })

  it('rejects missing or changed evidence and never mutates state', () => {
    const state = emptyVerifiedAccounting()
    expect(() => applyVerifiedAccountingEvent(state, fill({ proof: undefined }))).toThrow(
      'VERIFIED_ACCOUNTING_EVIDENCE_REQUIRED',
    )
    const applied = applyVerifiedAccountingEvent(state, fill()).state
    expect(() => applyVerifiedAccountingEvent(applied, fill({ size: '3' }))).toThrow(
      'VERIFIED_ACCOUNTING_IDENTITY_CONFLICT',
    )
    expect(applied.positionSize).toBe('2.5')
  })
})
