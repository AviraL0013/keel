import type { Stamp, WireOrder } from './decoder.js'

/** API identity is bound to one placement, never to a reusable contract slot alone. */
export type StrategyOrderIdentity = {
  accountId: number
  marketId: number
  contractMarketId: number
  venueOrderId: number
  contractOrderId: number
  placementRequestId: string
  type: number
  creationBlock: number
  creationTransactionIndex: number
  creationTxHash: string
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const strategyReceiptHash = (value: unknown): string | undefined =>
  typeof value === 'string' && /^(?:0x)?[0-9a-f]{64}$/i.test(value)
    ? `0x${value.replace(/^0x/i, '').toLowerCase()}`
    : undefined

export function validStrategyOrderIdentity(value: unknown): value is StrategyOrderIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as StrategyOrderIdentity
  return (
    [
      identity.accountId,
      identity.marketId,
      identity.contractMarketId,
      identity.venueOrderId,
      identity.contractOrderId,
      identity.creationBlock,
    ].every(positive) &&
    identity.contractOrderId <= 65535 &&
    nonnegative(identity.creationTransactionIndex) &&
    typeof identity.placementRequestId === 'string' &&
    /^[1-9][0-9]*$/.test(identity.placementRequestId) &&
    [1, 2].includes(identity.type) &&
    strategyReceiptHash(identity.creationTxHash) === identity.creationTxHash
  )
}

/** A string inside hashed market_terms avoids JSONB object-key ordering changes. */
export function encodeStrategyOrderIdentity(identity: StrategyOrderIdentity): string {
  if (!validStrategyOrderIdentity(identity)) throw new Error('STRATEGY_ORDER_IDENTITY_INVALID')
  return JSON.stringify({
    accountId: identity.accountId,
    marketId: identity.marketId,
    contractMarketId: identity.contractMarketId,
    venueOrderId: identity.venueOrderId,
    contractOrderId: identity.contractOrderId,
    placementRequestId: identity.placementRequestId,
    type: identity.type,
    creationBlock: identity.creationBlock,
    creationTransactionIndex: identity.creationTransactionIndex,
    creationTxHash: identity.creationTxHash,
  })
}

export function decodeStrategyOrderIdentity(value: unknown): StrategyOrderIdentity | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const identity: unknown = JSON.parse(value)
    return validStrategyOrderIdentity(identity) && encodeStrategyOrderIdentity(identity) === value
      ? identity
      : undefined
  } catch {
    return undefined
  }
}

export function matchesStrategyOrderIdentity(row: WireOrder, identity: StrategyOrderIdentity): boolean {
  return (
    validStrategyOrderIdentity(identity) &&
    row.acc === identity.accountId &&
    row.mkt === identity.marketId &&
    row.oid === identity.venueOrderId &&
    row.scid === identity.contractOrderId &&
    row.t === identity.type &&
    row.c?.b === identity.creationBlock &&
    row.c?.tx === identity.creationTransactionIndex &&
    strategyReceiptHash(row.c?.txid) === identity.creationTxHash
  )
}

export function matchesStrategyReceiptStamp(
  stamp: Stamp | undefined,
  block: number,
  tx: number,
  hash: string,
  localLog?: number,
) {
  return (
    !!stamp &&
    stamp.b === block &&
    stamp.tx === tx &&
    strategyReceiptHash(stamp.txid) === hash &&
    (localLog === undefined || stamp.l === localLog)
  )
}
