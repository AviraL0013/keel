import type { WireOrder } from '../../perpl/src/decoder.js'

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
}
export type StrategyOrderResolution = {
  status: StrategyOrderState
  venueOrderId?: number
  filledRaw?: number
  transactionHash?: string
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

/** Absence in an open-order snapshot never proves a fill or cancel. */
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
