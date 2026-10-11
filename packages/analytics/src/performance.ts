import type { WalletPerformance } from './contract.js'
import { signedMoney } from './aggregate.js'

export interface PositionEpisodeEvent {
  eventId?: string // block:transactionHash:logIndex when sourced from Exchange logs
  accountId: string
  marketId: number
  action: 'open' | 'increase' | 'reduce' | 'close' | 'liquidation' | 'invert'
  realizedPnlMicros: bigint | null
  remainingSizeRaw?: bigint | null // required to distinguish partial from full liquidation
  at: number
}
const decimal = (raw: bigint, scale: number) => {
  const divisor = 10n ** BigInt(scale)
  return `${raw / divisor}.${(raw % divisor).toString().padStart(scale, '0')}`
}
const ratio = (numerator: bigint, denominator: bigint, scale: number) =>
  denominator === 0n ? null : decimal((numerator * 10n ** BigInt(scale) + denominator / 2n) / denominator, scale)

/** Complete-history closed episodes. Missing opening evidence invalidates performance. */
export function calculateWalletPerformance(
  address: string,
  events: PositionEpisodeEvent[],
  startingEquityMicros?: bigint,
  windowStart?: number,
): WalletPerformance {
  const open = new Map<string, { at: number; pnl: bigint }>()
  const closed: Array<{ marketId: number; at: number; holdSeconds: number; pnl: bigint }> = []
  const seen = new Set<string>()
  let realized = 0n
  let previousAt = -Infinity
  let equity = startingEquityMicros ?? 0n
  let peak = equity
  let maxDrawdownHundredths = 0n
  const equityCurve: WalletPerformance['equityCurve'] =
    startingEquityMicros !== undefined && windowStart !== undefined
      ? [{ time: new Date(windowStart).toISOString(), value: signedMoney(equity) }]
      : []
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.at) ||
      event.at < 0 ||
      event.at < previousAt ||
      !/^\d+$/.test(event.accountId) ||
      BigInt(event.accountId) <= 0n ||
      !Number.isSafeInteger(event.marketId) ||
      event.marketId <= 0
    )
      throw new Error('ANALYTICS_EPISODE_ORDER_INVALID')
    previousAt = event.at
    if (event.eventId) {
      if (seen.has(event.eventId)) throw new Error('ANALYTICS_EPISODE_DUPLICATE')
      seen.add(event.eventId)
    }
    const key = `${event.accountId}:${event.marketId}`
    const current = open.get(key)
    if (event.realizedPnlMicros !== null) {
      realized += event.realizedPnlMicros
      if (startingEquityMicros !== undefined) {
        equity += event.realizedPnlMicros
        if (equity > peak) peak = equity
        if (peak > 0n) {
          const drawdown = ((peak - equity) * 10_000n + peak / 2n) / peak
          if (drawdown > maxDrawdownHundredths) maxDrawdownHundredths = drawdown
        }
        equityCurve.push({ time: new Date(event.at).toISOString(), value: signedMoney(equity) })
      }
    }
    if (event.action === 'open') {
      if (current || event.realizedPnlMicros !== null) throw new Error('ANALYTICS_EPISODE_INCOMPLETE')
      open.set(key, { at: event.at, pnl: 0n })
    } else if (event.action === 'increase') {
      if (!current || event.realizedPnlMicros !== null) throw new Error('ANALYTICS_EPISODE_INCOMPLETE')
    } else if (event.action === 'reduce') {
      if (!current || event.realizedPnlMicros === null) throw new Error('ANALYTICS_EPISODE_INCOMPLETE')
      current.pnl += event.realizedPnlMicros
    } else {
      if (!current || event.realizedPnlMicros === null) throw new Error('ANALYTICS_EPISODE_INCOMPLETE')
      if (event.action === 'liquidation') {
        if (event.remainingSizeRaw === undefined || event.remainingSizeRaw === null || event.remainingSizeRaw < 0n)
          throw new Error('ANALYTICS_LIQUIDATION_REMAINDER_UNVERIFIED')
        if (event.remainingSizeRaw > 0n) {
          current.pnl += event.realizedPnlMicros
          continue
        }
      }
      current.pnl += event.realizedPnlMicros
      closed.push({
        marketId: event.marketId,
        at: event.at,
        holdSeconds: Math.max(0, Math.floor((event.at - current.at) / 1000)),
        pnl: current.pnl,
      })
      open.delete(key)
      if (event.action === 'invert') open.set(key, { at: event.at, pnl: 0n })
    }
  }
  let wins = 0
  let winStreak = 0
  let lossStreak = 0
  let longestWinStreak = 0
  let longestLossStreak = 0
  let gains = 0n
  let losses = 0n
  const byMarket = new Map<number, bigint>()
  for (const episode of closed) {
    byMarket.set(episode.marketId, (byMarket.get(episode.marketId) ?? 0n) + episode.pnl)
    if (episode.pnl > 0n) {
      wins++
      gains += episode.pnl
      winStreak++
      lossStreak = 0
      longestWinStreak = Math.max(longestWinStreak, winStreak)
    } else if (episode.pnl < 0n) {
      losses += -episode.pnl
      lossStreak++
      winStreak = 0
      longestLossStreak = Math.max(longestLossStreak, lossStreak)
    } else {
      winStreak = 0
      lossStreak = 0
    }
  }
  const ranked = [...byMarket].sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : a[1] > b[1] ? -1 : 1))
  const hold = closed.reduce((sum, episode) => sum + episode.holdSeconds, 0)
  return {
    address,
    realizedPnl: signedMoney(realized),
    winRatePct: closed.length ? ratio(BigInt(wins * 100), BigInt(closed.length), 2) : null,
    profitFactor: ratio(gains, losses, 2),
    maxDrawdownPct:
      startingEquityMicros !== undefined && startingEquityMicros > 0n ? decimal(maxDrawdownHundredths, 2) : null,
    currentStreak: winStreak || -lossStreak,
    longestWinStreak,
    longestLossStreak,
    averageHoldSeconds: closed.length ? Math.round(hold / closed.length) : null,
    bestMarketId: ranked[0]?.[0] ?? null,
    worstMarketId: ranked.at(-1)?.[0] ?? null,
    closedTrades: closed.length,
    equityCurve,
  }
}
