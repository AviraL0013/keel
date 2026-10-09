import Decimal from 'decimal.js'

const Exact = Decimal.clone({ precision: 160 })
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/

export type VerifiedSequence = { block: number; transaction: number; log: number }
export type VerifiedProof = { receipt: string; history: string; order: string }
export type VerifiedAccountingEvent =
  | {
      kind: 'FILL'
      identity: string
      sequence: VerifiedSequence
      side: 'BUY' | 'SELL'
      size: string
      price: string
      fee: string
      proof: VerifiedProof
    }
  | {
      kind: 'FUNDING'
      identity: string
      sequence: VerifiedSequence
      amount: string
      proof: VerifiedProof
    }
export type VerifiedAccountingState = {
  positionSize: string
  averageEntry: string | null
  realizedPnl: string
  feesPaid: string
  fundingPaid: string
  lastSequence: VerifiedSequence | null
  applied: Record<string, string>
}

export const emptyVerifiedAccounting = (): VerifiedAccountingState => ({
  positionSize: '0',
  averageEntry: null,
  realizedPnl: '0',
  feesPaid: '0',
  fundingPaid: '0',
  lastSequence: null,
  applied: {},
})

const fixed = (value: Decimal.Value) => new Exact(value).toFixed()
const decimal = (value: string, code: string, positive = false) => {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw Error(code)
  const parsed = new Exact(value)
  if (!parsed.isFinite() || (positive && !parsed.isPositive())) throw Error(code)
  return parsed
}
const sequence = (value: VerifiedSequence) => {
  if (
    !value ||
    ![value.block, value.transaction, value.log].every(Number.isSafeInteger) ||
    value.block < 0 ||
    value.transaction < 0 ||
    value.log < 0
  )
    throw Error('VERIFIED_ACCOUNTING_SEQUENCE_INVALID')
}
const compare = (a: VerifiedSequence, b: VerifiedSequence) =>
  a.block - b.block || a.transaction - b.transaction || a.log - b.log
const proof = (value: VerifiedProof) => {
  if (
    !value ||
    typeof value.receipt !== 'string' ||
    !value.receipt ||
    typeof value.history !== 'string' ||
    !value.history ||
    typeof value.order !== 'string' ||
    !value.order
  )
    throw Error('VERIFIED_ACCOUNTING_EVIDENCE_REQUIRED')
}
const fingerprint = (event: VerifiedAccountingEvent) => JSON.stringify(event)

/**
 * Exact, duplicate-safe projection of independently verified fills.
 * This is an accounting seam only. It does not verify venue evidence, submit orders,
 * release capital, or authorize LIVE. Callers must pass receipt + signed-history +
 * immutable-order proof and deterministic block/log ordering.
 */
export function applyVerifiedAccountingEvent(
  state: VerifiedAccountingState,
  event: VerifiedAccountingEvent,
): { state: VerifiedAccountingState; applied: boolean } {
  if (!state || !event || (event.kind !== 'FILL' && event.kind !== 'FUNDING'))
    throw Error('VERIFIED_ACCOUNTING_EVENT_INVALID')
  sequence(event.sequence)
  proof(event.proof)
  if (typeof event.identity !== 'string' || !/^[^\s]{1,200}$/.test(event.identity))
    throw Error('VERIFIED_ACCOUNTING_IDENTITY_INVALID')
  const digest = fingerprint(event)
  const prior = state.applied[event.identity]
  if (prior) {
    if (prior !== digest) throw Error('VERIFIED_ACCOUNTING_IDENTITY_CONFLICT')
    return { state, applied: false }
  }
  if (state.lastSequence && compare(event.sequence, state.lastSequence) <= 0)
    throw Error('VERIFIED_ACCOUNTING_OUT_OF_ORDER')

  const next: VerifiedAccountingState = {
    ...state,
    applied: { ...state.applied, [event.identity]: digest },
    lastSequence: { ...event.sequence },
  }
  if (event.kind === 'FUNDING') {
    next.fundingPaid = fixed(
      new Exact(state.fundingPaid).plus(decimal(event.amount, 'VERIFIED_ACCOUNTING_AMOUNT_INVALID')),
    )
    return { state: next, applied: true }
  }
  const size = decimal(event.size, 'VERIFIED_ACCOUNTING_SIZE_INVALID', true)
  const price = decimal(event.price, 'VERIFIED_ACCOUNTING_PRICE_INVALID', true)
  const fee = decimal(event.fee, 'VERIFIED_ACCOUNTING_FEE_INVALID')
  if (fee.isNegative()) throw Error('VERIFIED_ACCOUNTING_FEE_INVALID')
  const priorSize = new Exact(state.positionSize)
  const signed = event.side === 'BUY' ? size : size.negated()
  const priorAverage =
    state.averageEntry === null ? null : decimal(state.averageEntry, 'VERIFIED_ACCOUNTING_STATE_INVALID', true)
  if (priorSize.isZero()) {
    next.positionSize = fixed(signed)
    next.averageEntry = fixed(price)
  } else if (priorSize.isPositive() === signed.isPositive()) {
    const total = priorSize.abs().plus(signed.abs())
    next.positionSize = fixed(priorSize.plus(signed))
    next.averageEntry = fixed(priorAverage!.mul(priorSize.abs()).plus(price.mul(signed.abs())).div(total))
  } else {
    const closed = Exact.min(priorSize.abs(), signed.abs())
    const delta = priorSize.isPositive() ? price.minus(priorAverage!) : priorAverage!.minus(price)
    next.realizedPnl = fixed(new Exact(state.realizedPnl).plus(delta.mul(closed)))
    const remaining = priorSize.plus(signed)
    next.positionSize = fixed(remaining)
    next.averageEntry = remaining.isZero()
      ? null
      : fixed(remaining.isPositive() === signed.isPositive() ? price : priorAverage!)
  }
  next.feesPaid = fixed(new Exact(state.feesPaid).plus(fee))
  return { state: next, applied: true }
}
