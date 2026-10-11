import { formatMoney } from '../../../../packages/ausd/src/money.js'
import type { WindowValue } from '../../../../packages/analytics/src/contract.js'
import { PerplPublicAnalytics, publicProtocolTotals } from './perpl-public.js'

type ContextObservation = Awaited<ReturnType<PerplPublicAnalytics['context']>>

export interface PublicProtocolCompletion {
  asOf: string | null
  block: number | null
  stale: boolean
  /** Current venue observations. `previous` stays null without a historical boundary. */
  live: {
    openInterest: WindowValue
    tvl: WindowValue
  }
  /** No public protocol-wide history exists for these metrics. Complete indexed Exchange history may supersede these gaps. */
  publicHistoryGaps: {
    volume: WindowValue
    fees: WindowValue
    revenue: WindowValue
    activeUsers: WindowValue
    netFlows: WindowValue
    liquidations: WindowValue
    marketSkew: WindowValue
    funding: WindowValue
  }
}

const unavailable = (reason: string): WindowValue => ({
  value: null,
  previous: null,
  changePct: null,
  note: reason,
})

const publicHistoryGaps = (): PublicProtocolCompletion['publicHistoryGaps'] => ({
  volume: unavailable(
    'No complete validated public volume window; Perpl candles cover currently listed markets only and upstream fill-side counting is unverified.',
  ),
  fees: unavailable(
    'Public Perpl context contains fee rates, not actual fees paid; complete fill-side history required.',
  ),
  revenue: unavailable(
    'Public Perpl API has no protocol revenue series; verified protocol-fee settlement history required.',
  ),
  activeUsers: unavailable(
    'Public Perpl API has no protocol-wide distinct trader history or historical owner mapping.',
  ),
  netFlows: unavailable('Public Perpl API has no protocol-wide deposit and withdrawal history.'),
  liquidations: unavailable('Public Perpl API has no protocol-wide liquidation history.'),
  marketSkew: unavailable('Perpl context open interest has no long/short split; complete position history required.'),
  funding: unavailable('Perpl publishes per-market funding rates, not one meaningful protocol-wide funding rate.'),
})

const liveNote = {
  openInterest: 'Current Perpl context: one-side open interest at each listed market mark. No historical boundary.',
  tvl: 'Current Perpl context: sum of listed-market reported collateral. No historical boundary.',
}

export function completePublicProtocol(observation: ContextObservation): PublicProtocolCompletion {
  const totals = publicProtocolTotals(observation.value.markets)
  const live = (amount: typeof totals.openInterest, note: string): WindowValue => ({
    value: amount.micros === null ? null : formatMoney(amount.micros),
    previous: null,
    changePct: null,
    note: amount.reason ?? note,
  })
  return {
    asOf: observation.asOf,
    block: observation.block,
    stale: observation.stale,
    live: {
      openInterest: live(totals.openInterest, liveNote.openInterest),
      tvl: live(totals.tvl, liveNote.tvl),
    },
    publicHistoryGaps: publicHistoryGaps(),
  }
}

/** Reuses PerplPublicAnalytics' 15-second context cache and stale fallback. Never fails the caller's other metrics. */
export async function readPublicProtocolCompletion(
  publicData: PerplPublicAnalytics,
): Promise<PublicProtocolCompletion> {
  try {
    return completePublicProtocol(await publicData.context())
  } catch {
    const missing = unavailable('PERPL_CONTEXT_UNAVAILABLE')
    return {
      asOf: null,
      block: null,
      stale: true,
      live: { openInterest: missing, tvl: missing },
      publicHistoryGaps: publicHistoryGaps(),
    }
  }
}
