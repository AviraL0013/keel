import type { WireOrder } from '../../perpl/src/decoder.js'
import type { PerplOrder } from '../../perpl/src/trading.js'
import type { VerifiedStrategyOperation } from '../../perpl/src/strategy-receipts.js'
import { forwardedRequestProcessed } from '../../perpl/src/request-id.js'

export type StrategyOrderState = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN'
export type StrategyOrderIntent = {
  accountId: number
  marketId: number
  requestId: string
  venueOrderId?: number
  kind?: 'POST' | 'CHANGE' | 'CANCEL'
}
export type StrategyOrderEvidence = {
  snapshotReady: boolean
  snapshot: WireOrder[]
  history: WireOrder[]
  continuousExpiryProof?: boolean
  historyComplete?: boolean
  operations?: VerifiedStrategyOperation[]
  account?: { lfr: string; block: number }
}
export type StrategyOrderResolution = {
  status: StrategyOrderState
  venueOrderId?: number
  filledRaw?: number
  transactionHash?: string
  admission?: VerifiedStrategyOperation
  error?: string
}

export type StrategyCommandIntent = StrategyOrderIntent & {
  order: PerplOrder
  lastExecutionBlock: number
  submittedAt: number
  /** Set only by durable recovery after reading previously saved command proof. */
  hasPersistedAdmission?: boolean
  previousAdmission?: VerifiedStrategyOperation
}

const compareStamp = (a: WireOrder, b: WireOrder) => {
  for (const key of ['b', 'tx', 'l', 't'] as const) {
    const delta = (a.at[key] ?? 0) - (b.at[key] ?? 0)
    if (delta) return delta
  }
  return 0
}

/** Durable real-order recovery. No status, timestamp or lfr alone proves admission.
 * A resting order's command lb never expires its later maker fills.
 * Partial snapshot size is an observation, not a receipt-backed ledger entry.
 */
export function reconcileStrategyIntent(
  intent: StrategyCommandIntent,
  evidence: StrategyOrderEvidence,
  now = Date.now(),
): StrategyOrderResolution {
  const pending = (error: string, admission?: VerifiedStrategyOperation): StrategyOrderResolution => ({
    status: 'UNKNOWN',
    error:
      Number.isFinite(intent.submittedAt) && now >= intent.submittedAt && now - intent.submittedAt < 180_000
        ? 'STRATEGY_OUTCOME_VERIFYING'
        : error,
    ...(admission ? { admission, venueOrderId: admission.venueOrderId, transactionHash: admission.txHash } : {}),
  })
  const order = intent.order
  if (
    !order ||
    order.acc !== intent.accountId ||
    order.mkt !== intent.marketId ||
    !Number.isSafeInteger(intent.lastExecutionBlock) ||
    intent.lastExecutionBlock <= 0 ||
    !['POST', 'CHANGE', 'CANCEL'].includes(intent.kind ?? '') ||
    (intent.kind === 'POST'
      ? ![1, 2].includes(order.t) || order.fl !== 1
      : order.t !== (intent.kind === 'CANCEL' ? 5 : 7) || order.fl !== 0 || order.oid !== intent.venueOrderId)
  )
    return pending('STRATEGY_INTENT_UNVERIFIED')
  const operations = (evidence.operations ?? []).filter(
    (item) => item.accountId === intent.accountId && item.requestId === intent.requestId,
  )
  const matches = (item: VerifiedStrategyOperation) =>
    item.accountId === intent.accountId &&
    item.requestId === intent.requestId &&
    !(
      item.marketId !== intent.marketId ||
      item.type !== order.t ||
      item.orderId !== String(order.oid ?? 0) ||
      item.sizeRaw !== String(order.s) ||
      item.priceRaw !== String(order.p ?? 0) ||
      item.leverageHundredths !== order.lv ||
      item.postOnly !== (order.fl === 1) ||
      item.fillOrKill !== false ||
      item.immediateOrCancel !== false ||
      item.expiryBlock !== '0' ||
      item.amountRaw !== '0' ||
      item.maxNegPnlCollatBps !== '0' ||
      item.feePer100K !== '0' ||
      item.lastExecutionBlock !== intent.lastExecutionBlock ||
      !Number.isSafeInteger(item.block) ||
      item.block <= 0 ||
      item.block > intent.lastExecutionBlock
    )
  const prior = intent.previousAdmission
  if (prior) {
    const expectedOutcome = intent.kind === 'POST' ? 'PLACED' : intent.kind === 'CHANGE' ? 'CHANGED' : 'CANCELED'
    if (
      !matches(prior) ||
      prior.outcome !== expectedOutcome ||
      !/^0x[0-9a-f]{64}$/i.test(prior.txHash) ||
      !Number.isSafeInteger(prior.requestLogIndex) ||
      !Number.isSafeInteger(prior.outcomeLogIndex) ||
      prior.outcomeLogIndex! <= prior.requestLogIndex ||
      !Number.isSafeInteger(prior.venueOrderId) ||
      prior.venueOrderId! <= 0 ||
      (intent.venueOrderId !== undefined && prior.venueOrderId !== intent.venueOrderId)
    )
      return pending('STRATEGY_SAVED_PROOF_UNVERIFIED')
    if (
      operations.some(
        (item) =>
          !matches(item) ||
          item.outcome !== prior.outcome ||
          item.txHash.toLowerCase() !== prior.txHash.toLowerCase() ||
          item.block !== prior.block ||
          item.requestLogIndex !== prior.requestLogIndex ||
          item.outcomeLogIndex !== prior.outcomeLogIndex ||
          item.venueOrderId !== prior.venueOrderId,
      )
    )
      return pending('STRATEGY_ADMISSION_CONFLICT', prior)
  }
  if (operations.some((item) => !matches(item))) return { status: 'FAILED', error: 'PERPL_REQUEST_ID_SUPERSEDED' }
  const candidates = operations.filter((item) => item.outcome !== 'UNVERIFIED')
  if (candidates.length > 1) return pending('STRATEGY_COMMAND_PROOF_AMBIGUOUS')
  const admission = prior ?? candidates[0]
  if (intent.kind === 'POST' && intent.venueOrderId !== undefined && admission?.venueOrderId !== intent.venueOrderId)
    return pending('STRATEGY_ADMISSION_CONFLICT')
  if (admission?.outcome === 'REJECTED')
    return { status: 'FAILED', error: 'VENUE_POST_REJECTED', admission, transactionHash: admission.txHash }
  if (intent.kind === 'CANCEL' && admission?.outcome === 'CANCELED')
    return { status: 'CANCELED', venueOrderId: admission.venueOrderId, admission, transactionHash: admission.txHash }
  const expected = intent.kind === 'POST' ? 'PLACED' : 'CHANGED'
  if (admission?.outcome === expected && admission.venueOrderId) {
    const own = (row: WireOrder) =>
      row.acc === intent.accountId && row.mkt === intent.marketId && row.oid === admission.venueOrderId
    const current = evidence.snapshotReady
      ? newest(evidence.snapshot.filter((row) => own(row) && !row.r && [2, 3].includes(row.st)))
      : undefined
    const terminal = newest(evidence.history.filter((row) => own(row) && [4, 5, 6, 7, 10].includes(row.st)))
    if (
      current &&
      (!terminal || compareStamp(current, terminal) > 0) &&
      (current.at.b ?? 0) >= admission.block &&
      Number.isSafeInteger(current.fs) &&
      current.fs >= 0 &&
      Number.isSafeInteger(current.os) &&
      current.fs <= current.os
    )
      return {
        status: current.st === 3 ? 'PARTIAL' : 'OPEN',
        venueOrderId: admission.venueOrderId,
        filledRaw: current.fs,
        admission,
        transactionHash: admission.txHash,
      }
    return pending('STRATEGY_ORDER_LIFECYCLE_UNVERIFIED', admission)
  }
  const requestSeen = [...evidence.history, ...evidence.snapshot].some(
    (row) => row.acc === intent.accountId && String(row.rq) === intent.requestId,
  )
  if (
    !requestSeen &&
    !intent.hasPersistedAdmission &&
    !operations.length &&
    evidence.historyComplete &&
    evidence.account &&
    Number.isSafeInteger(evidence.account.block) &&
    evidence.account.block >= intent.lastExecutionBlock
  ) {
    try {
      if (!forwardedRequestProcessed(intent.requestId, evidence.account.lfr))
        return { status: 'FAILED', error: 'PERPL_ORDER_WINDOW_EXPIRED' }
    } catch {
      return pending('PERPL_LFR_UNVERIFIED')
    }
  }
  return pending('VENUE_RECEIPT_UNVERIFIED')
}

function newest(rows: WireOrder[]): WireOrder | undefined {
  return [...rows].sort(
    (a, b) =>
      (b.at.b ?? 0) - (a.at.b ?? 0) ||
      (b.at.tx ?? 0) - (a.at.tx ?? 0) ||
      (b.at.l ?? 0) - (a.at.l ?? 0) ||
      (b.at.t ?? 0) - (a.at.t ?? 0),
  )[0]
}

/** Legacy synthetic-fixture helper. Never use for durable real-order recovery. */
export function reconcileStrategyOrder(
  intent: StrategyOrderIntent,
  evidence: StrategyOrderEvidence,
): StrategyOrderResolution {
  const own = (row: WireOrder) =>
    row.acc === intent.accountId &&
    row.mkt === intent.marketId &&
    (String(row.rq) === intent.requestId ||
      (intent.kind === 'CANCEL' && intent.venueOrderId !== undefined && row.oid === intent.venueOrderId))
  const open = evidence.snapshotReady
    ? newest(evidence.snapshot.filter((row) => own(row) && !row.r && [2, 3].includes(row.st)))
    : undefined
  const terminal = newest(evidence.history.filter((row) => own(row) && [4, 5, 6, 7, 10].includes(row.st)))
  if (open && terminal && (terminal.at.b ?? 0) >= (open.at.b ?? 0)) return { status: 'UNKNOWN' }
  if (open) return { status: open.st === 3 ? 'PARTIAL' : 'OPEN', venueOrderId: open.oid, filledRaw: open.fs }
  if (terminal) {
    const status =
      terminal.st === 4
        ? 'FILLED'
        : terminal.st === 5
          ? 'CANCELED'
          : terminal.st === 6
            ? 'EXPIRED'
            : terminal.st === 7
              ? 'FAILED'
              : intent.kind === 'CANCEL'
                ? 'CANCELED'
                : 'FILLED'
    return {
      status,
      venueOrderId: terminal.oid,
      filledRaw: terminal.fs,
      ...(terminal.at.txid && /^(?:0x)?[0-9a-fA-F]{64}$/.test(terminal.at.txid)
        ? { transactionHash: terminal.at.txid.startsWith('0x') ? terminal.at.txid : `0x${terminal.at.txid}` }
        : {}),
    }
  }
  if (evidence.snapshotReady && evidence.continuousExpiryProof) return { status: 'EXPIRED' }
  return { status: 'UNKNOWN' }
}
