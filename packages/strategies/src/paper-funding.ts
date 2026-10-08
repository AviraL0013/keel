import Decimal from 'decimal.js'
import type { StrategyState } from './index.js'

export type PaperFundingEvent = {
  at: { b: number; t: number }
  feb: number
  rate: number
  idx: number
  ppl: number
  sum: number
  div: number
}
export type PaperFundingObservation = {
  marketId: number
  events: PaperFundingEvent[]
  head: { block: number; at: number }
  intervalBlocks: number
  priceDecimals: number
}
const Exact = Decimal.clone({ precision: 80 })
const financial = ['rate', 'idx', 'ppl', 'sum', 'div'] as const

/** Simulated funding only. Never infer a payment from mark * rate or an observation timestamp.
 * A gap/late interval halts instead of attributing uncertain historical exposure.
 * The saved cursor and paper projection are committed together by StrategyStore's version CAS.
 */
export function applyPaperFunding(
  state: StrategyState,
  observation: PaperFundingObservation | undefined,
  now: number,
  maxAgeMs: number,
): { state: StrategyState; funding?: { at: number; amount: number } } {
  if (!observation || !Array.isArray(observation.events) || !observation.events.length)
    throw Error('STRATEGY_PAPER_FUNDING_UNAVAILABLE')
  const { head, intervalBlocks, priceDecimals, marketId } = observation
  if (
    !head ||
    ![now, maxAgeMs, head.block, head.at, intervalBlocks, priceDecimals, marketId].every(Number.isSafeInteger) ||
    now < 0 ||
    maxAgeMs <= 0 ||
    head.block <= 0 ||
    head.at > now ||
    now - head.at > maxAgeMs ||
    intervalBlocks <= 0 ||
    priceDecimals < 0 ||
    priceDecimals > 12 ||
    marketId <= 0 ||
    !Number.isFinite(state.inventory) ||
    !Number.isFinite(state.fundingPaid) ||
    (state.lastPaperObservedAt !== undefined &&
      (!Number.isSafeInteger(state.lastPaperObservedAt) || state.lastPaperObservedAt > now))
  )
    throw Error('STRATEGY_PAPER_FUNDING_OBSERVATION_INVALID')
  const unique = new Map<number, PaperFundingEvent>()
  for (const event of observation.events) {
    if (
      !event?.at ||
      ![event.at.b, event.at.t, event.feb, event.rate, event.idx, event.ppl, event.sum, event.div].every(
        Number.isSafeInteger,
      ) ||
      event.feb <= 0 ||
      event.at.b !== event.feb ||
      event.at.t < 0 ||
      event.idx <= 0 ||
      event.div !== 1
    )
      throw Error('STRATEGY_PAPER_FUNDING_EVENT_UNVERIFIED')
    const prior = unique.get(event.feb)
    if (prior && financial.some((key) => prior[key] !== event[key])) throw Error('STRATEGY_PAPER_FUNDING_CONFLICT')
    // A scheduled timestamp can be corrected at its effective block. Retain the latest observation, not two charges.
    unique.set(event.feb, event)
  }
  const due = [...unique.values()]
    .filter((event) => event.feb <= head.block && event.at.t <= head.at)
    .sort((a, b) => a.feb - b.feb)
  let cursor = state.paperFundingCursor
  if (cursor) {
    if (
      cursor.marketId !== marketId ||
      cursor.intervalBlocks !== intervalBlocks ||
      cursor.priceDecimals !== priceDecimals
    )
      throw Error('STRATEGY_PAPER_FUNDING_TERMS_CHANGED')
    if (
      ![cursor.feb, cursor.at, ...financial.map((key) => cursor![key])].every(Number.isSafeInteger) ||
      cursor.feb <= 0 ||
      cursor.feb > head.block ||
      cursor.at > now ||
      cursor.div !== 1 ||
      !Number.isSafeInteger(state.lastPaperObservedAt)
    )
      throw Error('STRATEGY_PAPER_FUNDING_CURSOR_INVALID')
    const repeated = unique.get(cursor.feb)
    if (repeated && financial.some((key) => repeated[key] !== cursor![key]))
      throw Error('STRATEGY_PAPER_FUNDING_CONFLICT')
  } else {
    if (state.inventory !== 0 || state.cashFlow !== 0 || state.feesPaid !== 0 || state.fundingPaid !== 0)
      throw Error('STRATEGY_PAPER_FUNDING_BASELINE_REQUIRED')
    const latest = due.at(-1)
    if (!latest) throw Error('STRATEGY_PAPER_FUNDING_UNAVAILABLE')
    cursor = { ...latest, at: latest.at.t, marketId, intervalBlocks, priceDecimals }
  }
  let amount = new Exact(0),
    applied = false
  for (const event of due.filter((event) => event.feb > cursor!.feb)) {
    if (event.feb - cursor.feb !== intervalBlocks) throw Error('STRATEGY_PAPER_FUNDING_GAP')
    if (event.at.t <= (state.lastPaperObservedAt ?? now) || event.at.t <= cursor.at)
      throw Error('STRATEGY_PAPER_FUNDING_LATE')
    amount = amount.plus(new Exact(state.inventory).mul(event.ppl).div(new Exact(10).pow(priceDecimals)))
    cursor = { ...event, at: event.at.t, marketId, intervalBlocks, priceDecimals }
    applied = true
  }
  if (head.block - cursor.feb >= intervalBlocks) throw Error('STRATEGY_PAPER_FUNDING_GAP')
  return {
    state: {
      ...state,
      fundingPaid: new Exact(state.fundingPaid).plus(amount).toNumber(),
      paperFundingCursor: cursor,
      lastFundingAt: cursor.at,
      lastPaperObservedAt: now,
    },
    ...(applied ? { funding: { at: cursor.at, amount: amount.toNumber() } } : {}),
  }
}
