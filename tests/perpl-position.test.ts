import { describe, expect, it } from 'vitest'
import { mapPerplPositionStatus, normalizePerplPosition } from '../packages/perpl/src/index.js'
import { buildTelemetryFreshness } from '../packages/domain/src/index.js'
import { assertPerplBookSetupReady, perplBookCreationReadiness } from '../server/src/infrastructure/perpl/runtime.js'

describe('Perpl position normalization', () => {
  it.each([
    [1, 'OPEN'], [2, 'CLOSED'], [3, 'LIQUIDATED'], [4, 'DELEVERAGED'], [5, 'UNWOUND'], [6, 'FAILED'], [0, 'FAILED'], [99, 'FAILED'],
  ] as const)('maps vendor status %s to %s', (vendor, expected) => expect(mapPerplPositionStatus(vendor)).toBe(expected))
  it('normalizes live wire collateral with token decimals', () => {
    const value = normalizePerplPosition({ acc: 642, mkt: 16, pid: 77, st: 1, sd: 1, c: '539809', ep: 805993, s: 10, lv: 1500, at: { t: Date.now() }, efs: 0, xfs: 0, fee: '0' }, {
      config: { price_decimals: 1, size_decimals: 5, maintenance_margin: 2000 },
      state: { mrk: 812352 },
    }, 6)
    expect(value.size).toBe(0.0001)
    expect(value.entryPrice).toBe(80599.3)
    expect(value.margin).toBeCloseTo(0.539809, 6)
    expect(value.leverage).toBe(15)
    expect(value.unrealizedPnl).toBeCloseTo(0.06359, 6)
    expect(value.liquidationEstimated).toBe(true)
  })

  it('rejects stale position telemetry before live Book creation', () => {
    const now = Date.now()
    const position = { bookId: '642:16', side: 'LONG' as const, size: 0.0001, entryPrice: 80599.3, markPrice: 81235.2, liquidationPrice: 78449.99, leverage: 15, unrealizedPnl: 0.06359, margin: 0.539809, status: 'OPEN' as const, timestamp: now - 1418_000 }
    const telemetry = { mark: 81235.2, oracle: 81235.2, bid: 81265.5, ask: 81275.5, mid: 81270.5, spreadBps: 1, fundingRate: 0, depthNotional: 3_317_230.81, volatility: 0.01, volume24h: 0, openInterest: 0, block: 1, timestamp: now - 400, source: 'perpl-rest' as const, freshnessMs: 400 }
    expect(() => assertPerplBookSetupReady(position, telemetry, now)).toThrow('POSITION_TELEMETRY_STALE')
    expect(() => assertPerplBookSetupReady({ ...position, timestamp: now - 400 }, telemetry, now)).not.toThrow()
  })
  it('blocks Book creation when market is stale even if position is fresh', () => {
    const now = Date.now()
    const position = { bookId: '642:16', side: 'LONG' as const, size: 0.0001, entryPrice: 80599.3, markPrice: 81235.2, liquidationPrice: 78449.99, leverage: 15, unrealizedPnl: 0.06359, margin: 0.539809, status: 'OPEN' as const, observedAt: now - 300 }
    const telemetry = { mark: 81235.2, oracle: 81235.2, bid: 81265.5, ask: 81275.5, mid: 81270.5, spreadBps: 1, fundingRate: 0, depthNotional: 3_317_230.81, volatility: 0.01, volume24h: 0, openInterest: 0, block: 1, timestamp: now - 12_000, marketTimestamp: now - 12_000, fundingTimestamp: now - 300, orderbookTimestamp: now - 300, freshness: buildTelemetryFreshness({ marketUpdatedAt: now - 12_000, positionUpdatedAt: now - 300, fundingUpdatedAt: now - 300, orderbookUpdatedAt: now - 300 }, now), source: 'perpl-rest' as const, freshnessMs: 12_000 }
    expect(telemetry.freshness.market.status).toBe('STALE')
    expect(telemetry.freshness.position.status).toBe('FRESH')
    expect(() => assertPerplBookSetupReady(position, telemetry, now)).toThrow('MARKET_TELEMETRY_STALE')
  })

  it('allows Book creation when market and position are fresh even if optional sources are stale', () => {
    const now = Date.now()
    const position = { bookId: '642:16', side: 'LONG' as const, size: 0.0001, entryPrice: 80599.3, markPrice: 81235.2, liquidationPrice: 78449.99, leverage: 15, unrealizedPnl: 0.06359, margin: 0.539809, status: 'OPEN' as const, observedAt: now - 300 }
    const telemetry = { mark: 81235.2, oracle: 81235.2, bid: 81235, ask: 81236, mid: 81235.5, spreadBps: 1, fundingRate: 0, depthNotional: 3_317_230.81, volatility: 0.01, volume24h: 0, openInterest: 0, block: 1, timestamp: now - 300, marketTimestamp: now - 300, positionTimestamp: now - 300, fundingTimestamp: now - 20_000, orderbookTimestamp: now - 20_000, freshness: buildTelemetryFreshness({ marketUpdatedAt: now - 300, positionUpdatedAt: now - 300, fundingUpdatedAt: now - 20_000, orderbookUpdatedAt: now - 20_000 }, now), source: 'perpl-rest' as const, freshnessMs: 300 }
    expect(perplBookCreationReadiness(position, telemetry, now)).toMatchObject({ allowed: true, code: 'READY' })
    expect(() => assertPerplBookSetupReady(position, telemetry, now)).not.toThrow()
  })

  it('blocks stale position while market is fresh', () => {
    const now = Date.now()
    const position = { bookId: '642:16', side: 'LONG' as const, size: 0.0001, entryPrice: 80599.3, markPrice: 81235.2, liquidationPrice: 78449.99, leverage: 15, unrealizedPnl: 0.06359, margin: 0.539809, status: 'OPEN' as const, observedAt: now - 20_000 }
    const telemetry = { mark: 81235.2, oracle: 81235.2, bid: 81235, ask: 81236, mid: 81235.5, spreadBps: 1, fundingRate: 0, depthNotional: 3_317_230.81, volatility: 0.01, volume24h: 0, openInterest: 0, block: 1, timestamp: now - 300, marketTimestamp: now - 300, positionTimestamp: now - 20_000, fundingTimestamp: now - 300, orderbookTimestamp: now - 300, freshness: buildTelemetryFreshness({ marketUpdatedAt: now - 300, positionUpdatedAt: now - 20_000, fundingUpdatedAt: now - 300, orderbookUpdatedAt: now - 300 }, now), source: 'perpl-rest' as const, freshnessMs: 300 }
    expect(() => assertPerplBookSetupReady(position, telemetry, now)).toThrow('POSITION_TELEMETRY_STALE')
  })

  it('blocks unknown market telemetry', () => {
    const now = Date.now()
    const position = { bookId: '642:16', side: 'LONG' as const, size: 0.0001, entryPrice: 80599.3, markPrice: 81235.2, liquidationPrice: 78449.99, leverage: 15, unrealizedPnl: 0.06359, margin: 0.539809, status: 'OPEN' as const, observedAt: now - 300 }
    const telemetry = { mark: 81235.2, oracle: 81235.2, bid: 81235, ask: 81236, mid: 81235.5, spreadBps: 1, fundingRate: 0, depthNotional: 3_317_230.81, volatility: 0.01, volume24h: 0, openInterest: 0, block: 1, timestamp: now - 300, freshness: buildTelemetryFreshness({ positionUpdatedAt: now - 300, fundingUpdatedAt: now - 300, orderbookUpdatedAt: now - 300 }, now), source: 'perpl-rest' as const, freshnessMs: 300 }
    expect(() => assertPerplBookSetupReady(position, telemetry, now)).toThrow('MARKET_TELEMETRY_UNKNOWN')
  })
})
