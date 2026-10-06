import Decimal from 'decimal.js'
import type { WireFill, WireOrder, WirePosition } from './decoder.js'
import { forwardedRequestProcessed } from './request-id.js'

type VerifiedOperation = {
  requestId: string
  type: number
  marketId: number
  block: number
  txHash: string
  sizeRaw?: string
  positionId?: number
  priceRaw?: string
  leverageHundredths?: number
  immediateOrCancel?: boolean
  lastExecutionBlock?: number
}
export type OpeningEvidence = {
  account?: { lfr: string; block: number }
  orders: WireOrder[]
  fills: WireFill[]
  positions: WirePosition[]
  /** Decoded forwarded order from a successful on-chain receipt. */
  operations: VerifiedOperation[]
}
export type OpeningReconciliation = {
  status: 'VERIFYING' | 'CONFIRMED' | 'PARTIAL' | 'FAILED' | 'UNKNOWN'
  error?: string
  filledSize?: string
  averagePrice?: string
  positionId?: number
  txHash?: string
  evidence?: OpeningEvidence
}

export function reconcileOpening(
  intent: {
    accountId: number
    marketId: number
    requestId: string
    lastExecutionBlock: number
    side: 'LONG' | 'SHORT'
    sizeRaw: number
    priceLimitRaw: number
    leverageHundredths: number
    sizeDecimals: number
    priceDecimals: number
    submittedAt: number
  },
  evidence: OpeningEvidence,
  now = Date.now(),
): OpeningReconciliation {
  const pending = (error: string): OpeningReconciliation =>
    Number.isFinite(intent.submittedAt) && now - intent.submittedAt < 180_000
      ? { status: 'VERIFYING' }
      : { status: 'UNKNOWN', error }
  const type = intent.side === 'LONG' ? 1 : 2
  const operations = evidence.operations.filter((item) => item.requestId === intent.requestId)
  if (
    operations.some(
      (item) =>
        item.type !== type ||
        item.marketId !== intent.marketId ||
        item.block > intent.lastExecutionBlock ||
        item.sizeRaw !== String(intent.sizeRaw) ||
        item.priceRaw !== String(intent.priceLimitRaw) ||
        item.leverageHundredths !== intent.leverageHundredths ||
        item.immediateOrCancel !== true ||
        item.lastExecutionBlock !== intent.lastExecutionBlock,
    )
  )
    return { status: 'FAILED', error: 'PERPL_REQUEST_ID_SUPERSEDED', evidence }
  const matching = evidence.orders.filter(
    (order) =>
      order.acc === intent.accountId &&
      String(order.rq) === intent.requestId &&
      order.mkt === intent.marketId &&
      order.t === type &&
      order.os === intent.sizeRaw,
  )
  if (evidence.orders.some((order) => String(order.rq) === intent.requestId && !matching.includes(order)))
    return { status: 'FAILED', error: 'PERPL_REQUEST_ID_SUPERSEDED', evidence }
  const order = matching.sort((a, b) => (b.at.b ?? 0) - (a.at.b ?? 0))[0]
  if (order?.st === 7 && !evidence.fills.length && !evidence.positions.length)
    return { status: 'FAILED', error: order.sr === 32 ? 'ORDER_REQUEST_ID_TOO_LOW' : 'VENUE_REJECTED', evidence }
  if (
    !order &&
    !evidence.orders.length &&
    !evidence.fills.length &&
    !evidence.positions.length &&
    evidence.account &&
    evidence.account.block >= intent.lastExecutionBlock &&
    !forwardedRequestProcessed(intent.requestId, evidence.account.lfr)
  )
    return { status: 'FAILED', error: 'PERPL_ORDER_WINDOW_EXPIRED', evidence }
  if (!order || ![3, 4, 10].includes(order.st) || !operations.length) return pending('VENUE_OUTCOME_UNVERIFIED')
  const verified = operations.find(
    (item) => item.block === order.at.b && item.type === type && item.marketId === intent.marketId,
  )
  if (!verified) return pending('VENUE_RECEIPT_UNVERIFIED')
  const fills = evidence.fills.filter(
    (item) =>
      item.acc === intent.accountId && item.mkt === intent.marketId && item.oid === order.oid && item.t === type,
  )
  if (
    !fills.length ||
    fills.some((item) => !Number.isSafeInteger(item.s) || item.s <= 0 || !Number.isSafeInteger(item.p) || item.p! <= 0)
  )
    return pending('OPENING_FILL_UNVERIFIED')
  const filled = fills.reduce((sum, item) => sum + BigInt(item.s), 0n)
  if (filled <= 0n || filled > BigInt(intent.sizeRaw) || filled !== BigInt(order.fs))
    return pending('OPENING_FILL_MISMATCH')
  const lastFillBlock = Math.max(...fills.map((item) => item.at.b ?? 0))
  const position = evidence.positions
    .filter(
      (item) =>
        item.acc === intent.accountId &&
        item.mkt === intent.marketId &&
        item.oid === order.oid &&
        String(item.rq) === intent.requestId &&
        item.sd === type &&
        item.st === 1 &&
        BigInt(item.s) === filled &&
        (item.at.b ?? 0) >= lastFillBlock &&
        // Opening forwards triggerPositionId=0; the fill assigns the new pid.
        (!verified.positionId || verified.positionId === item.pid),
    )
    .sort((a, b) => (b.at.b ?? 0) - (a.at.b ?? 0))[0]
  if (!position) return pending('OPENING_POSITION_UNVERIFIED')
  const weighted = fills.reduce((sum, item) => sum.plus(new Decimal(item.p!).mul(item.s)), new Decimal(0))
  const averagePrice = weighted
    .div(filled.toString())
    .div(new Decimal(10).pow(intent.priceDecimals))
    .toFixed(intent.priceDecimals)
  return {
    status: filled === BigInt(intent.sizeRaw) ? 'CONFIRMED' : 'PARTIAL',
    filledSize: new Decimal(filled.toString())
      .div(new Decimal(10).pow(intent.sizeDecimals))
      .toFixed(intent.sizeDecimals),
    averagePrice,
    positionId: position.pid,
    txHash: verified.txHash,
    evidence,
  }
}
