import { describe, expect, it } from 'vitest'
import { toBookRiskDto, toExecutionSummaryDto, toTelemetryDto } from '../server/src/interfaces/http/mappers.js'
import { buildTelemetryFreshness } from '../packages/domain/src/index.js'
import { evaluateBookSnapshot } from '../server/src/application/book-risk.js'

const telemetryRow = (freshness_detail: unknown, timestamp = new Date().toISOString()) => ({
  mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, spread: 20,
  funding: 0.001, depth: 10_000, volatility: 0.01, block: 1, timestamp,
  source: 'perpl-ws', freshness: 250, freshness_detail,
})

describe('Book dashboard state mapping', () => {
  it('preserves independent fresh source status', () => {
    const now = Date.now()
    const detail = buildTelemetryFreshness({
      marketUpdatedAt: now - 100,
      positionUpdatedAt: now - 200,
      fundingUpdatedAt: now - 300,
      orderbookUpdatedAt: now - 400,
    }, now)
    const result = toTelemetryDto(telemetryRow(detail, new Date(now - 100).toISOString()))
    expect(result.freshness?.market.status).toBe('FRESH')
    expect(result.freshness?.position.status).toBe('FRESH')
    expect(result.freshness?.funding.status).toBe('FRESH')
    expect(result.freshness?.orderbook.status).toBe('FRESH')
  })

  it('keeps mixed freshness instead of collapsing it', () => {
    const now = Date.now()
    const detail = buildTelemetryFreshness({
      marketUpdatedAt: now - 100,
      positionUpdatedAt: now - 200,
      fundingUpdatedAt: now - 20_000,
      orderbookUpdatedAt: undefined,
    }, now)
    const result = toTelemetryDto(telemetryRow(detail, new Date(now - 100).toISOString()))
    expect(result.freshness?.market.status).toBe('FRESH')
    expect(result.freshness?.position.status).toBe('FRESH')
    expect(result.freshness?.funding.status).toBe('STALE')
    expect(result.freshness?.orderbook.status).toBe('UNKNOWN')
  })

  it('labels missing risk decision explicitly', () => {
    const result = toBookRiskDto(null)
    expect(result.status).toBe('NO_DECISION')
    expect(result.state).toBeNull()
    expect(result.reasonCode).toBe('NO_AUTHORITATIVE_DECISION')
  })

  it('labels a new Book with no action separately from unknown execution', () => {
    const result = toExecutionSummaryDto(null)
    expect(result.status).toBe('NO_ACTIVE_EXECUTION')
    expect(result.actionId).toBeNull()
    expect(toExecutionSummaryDto({ id: 'a1', status: 'UNKNOWN', kind: 'DEFEND' }).status).toBe('UNKNOWN')
  })

  it('explains the actual stale source when market and position are live', () => {
    const now = Date.now()
    const book = { id: 'book', userId: 'user', market: 'BTC-PERP', side: 'LONG' as const, stance: 'DEFEND' as const, liquidationFloor: 6, defenseCap: 5, timeLimitMs: 86_400_000, automationEnabled: true, status: 'ACTIVE' as const, createdAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now).toISOString() }
    const sources = buildTelemetryFreshness({ marketUpdatedAt: now - 100, positionUpdatedAt: now - 100, fundingUpdatedAt: now - 20_000, orderbookUpdatedAt: now - 100 }, now)
    const decision = evaluateBookSnapshot(book, { size: 1, entryPrice: 100, liquidationPrice: 94, leverage: 6, unrealizedPnl: 0, margin: 16, status: 'OPEN' }, { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, spreadBps: 20, fundingRate: 0.001, depthNotional: 5_000, volatility: 0.01, block: 1, freshness: sources }, { available: 10, reserved: 0, deployed: 0, cap: 10 }, Infinity, true, now)
    expect(decision?.state).toBe('SAFE_MODE')
    expect(decision?.reasonCodes).toEqual(['FUNDING_STALE'])
    expect(decision?.humanReadableReasons).toEqual(['Funding telemetry is stale.'])
  })
})
