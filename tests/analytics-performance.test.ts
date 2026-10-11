import { describe, expect, it } from 'vitest'
import { calculateWalletPerformance, type PositionEpisodeEvent } from '../packages/analytics/src/performance.js'

const at = (seconds: number) => seconds * 1000
const event = (
  accountId: string,
  marketId: number,
  action: PositionEpisodeEvent['action'],
  seconds: number,
  realizedPnlMicros: bigint | null = null,
): PositionEpisodeEvent => ({ accountId, marketId, action, at: at(seconds), realizedPnlMicros })

describe('wallet episode performance', () => {
  it('counts closed episodes, partial reductions, profit factor and streaks exactly', () => {
    const result = calculateWalletPerformance('0xwallet', [
      event('1', 1, 'open', 0),
      event('1', 1, 'reduce', 60, 1_000_000n),
      event('1', 1, 'close', 120, 2_000_000n),
      event('1', 20, 'open', 130),
      event('1', 20, 'close', 190, -1_000_000n),
      event('1', 1, 'open', 200),
      event('1', 1, 'close', 260, 2_000_000n),
    ])
    expect(result.realizedPnl).toBe('4.000000')
    expect(result.winRatePct).toBe('66.67')
    expect(result.profitFactor).toBe('5.00')
    expect(result.currentStreak).toBe(1)
    expect(result.longestWinStreak).toBe(1)
    expect(result.longestLossStreak).toBe(1)
    expect(result.averageHoldSeconds).toBe(80)
    expect(result.bestMarketId).toBe(1)
    expect(result.worstMarketId).toBe(20)
    expect(result.closedTrades).toBe(3)
  })

  it('treats inversion as closing one episode and opening another', () => {
    const result = calculateWalletPerformance('0xwallet', [
      event('1', 1, 'open', 0),
      event('1', 1, 'invert', 60, -500_000n),
      event('1', 1, 'close', 120, 1_000_000n),
    ])
    expect(result.closedTrades).toBe(2)
    expect(result.realizedPnl).toBe('0.500000')
    expect(result.winRatePct).toBe('50.00')
  })

  it('rejects missing opening evidence', () => {
    expect(() => calculateWalletPerformance('0xwallet', [event('1', 1, 'close', 120, 1n)])).toThrow(
      'ANALYTICS_EPISODE_INCOMPLETE',
    )
  })

  it('keeps a partially liquidated episode open and requires explicit remaining size', () => {
    const opening = event('1', 1, 'open', 0)
    const partial = { ...event('1', 1, 'liquidation', 60, -1n), remainingSizeRaw: 1n }
    const closing = event('1', 1, 'close', 120, 2n)
    expect(calculateWalletPerformance('0xwallet', [opening, partial, closing])).toMatchObject({
      realizedPnl: '0.000001',
      closedTrades: 1,
      winRatePct: '100.00',
    })
    expect(() => calculateWalletPerformance('0xwallet', [opening, event('1', 1, 'liquidation', 60, -1n)])).toThrow(
      'ANALYTICS_LIQUIDATION_REMAINDER_UNVERIFIED',
    )
    expect(calculateWalletPerformance('0xwallet', [opening, { ...partial, remainingSizeRaw: 0n }]).closedTrades).toBe(1)
  })

  it('rejects duplicate, unordered and unsupported opening realized amounts', () => {
    const opening = { ...event('1', 1, 'open', 0), eventId: '1:0x01:0' }
    expect(() => calculateWalletPerformance('0xwallet', [opening, opening])).toThrow('ANALYTICS_EPISODE_DUPLICATE')
    expect(() =>
      calculateWalletPerformance('0xwallet', [event('1', 1, 'open', 60), event('1', 1, 'close', 0, 1n)]),
    ).toThrow('ANALYTICS_EPISODE_ORDER_INVALID')
    expect(() => calculateWalletPerformance('0xwallet', [event('1', 1, 'open', 0, 1n)])).toThrow(
      'ANALYTICS_EPISODE_INCOMPLETE',
    )
  })
})
