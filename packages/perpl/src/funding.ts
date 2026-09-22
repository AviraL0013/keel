import { decodeTimestamp } from './units.js'

type FundingMarket = { funding?: Record<string, unknown>; funding_interval_blocks?: number }
type ChainHead = { gas?: { h?: number; at?: { t?: number } } }

/** Funding at.t is the effective time, not a feed observation. Certify the
 * context's latest rate against its own chain head and venue funding interval.
 * Never use a newer market stream or local receipt alone to freshen old context.
 */
export function normalizeContextFunding(market: FundingMarket, chain: unknown, now = Date.now()) {
  const event = market.funding ?? {}
  const effectiveAt = decodeTimestamp((event.at as { t?: unknown } | undefined)?.t)
  const rate = typeof event.rate === 'number' && Number.isSafeInteger(event.rate) ? event.rate / 1_000_000 : Number.NaN
  const head = (chain as ChainHead | null)?.gas
  const headAt = decodeTimestamp(head?.at?.t)
  const headBlock = head?.h
  const eventBlock = event.feb
  const interval = market.funding_interval_blocks
  let verifiedAt: number | undefined
  if (Number.isFinite(rate) && effectiveAt !== undefined && headAt !== undefined && headAt <= now &&
      typeof headBlock === 'number' && Number.isSafeInteger(headBlock) && headBlock > 0 &&
      typeof eventBlock === 'number' && Number.isSafeInteger(eventBlock) && eventBlock > 0 &&
      typeof interval === 'number' && Number.isSafeInteger(interval) && interval > 0) {
    // The latest event may be scheduled ahead of the head. A missed full
    // interval must remain stale even when the context endpoint is reachable.
    if (Math.abs(headBlock - eventBlock) < interval) verifiedAt = headAt
    else if (headBlock >= eventBlock + interval && effectiveAt <= headAt) verifiedAt = effectiveAt
  }
  return { rate, effectiveAt, verifiedAt }
}
