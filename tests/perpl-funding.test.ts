import { describe, expect, it } from 'vitest'
import { normalizeContextFunding } from '../packages/perpl/src/funding.js'
import { storedTelemetryFreshness } from '../server/src/infrastructure/database/telemetry-freshness.js'
import { toTelemetryDto } from '../server/src/interfaces/http/mappers.js'

const now = 1_790_009_496_000
const eventAt = now - 720_000
const market = (overrides: Record<string, unknown> = {}) => ({
  funding: { at: { t: eventAt }, feb: 64496775, rate: -40, ...overrides },
  funding_interval_blocks: 8571,
})
const chain = (block = 64499119, timestamp = now) => ({ gas: { h: block, at: { t: timestamp } } })

describe('Perpl funding observation freshness', () => {
  it('uses the current chain observation while retaining the effective funding time', () => {
    const result = normalizeContextFunding(market(), chain(), now)
    expect(result.rate).toBe(-0.00004)
    expect(result.effectiveAt).toBe(eventAt)
    expect(result.verifiedAt).toBe(now)
  })

  it('does not mark an expired funding event fresh just because REST responds', () => {
    expect(normalizeContextFunding(market(), chain(64496775 + 8571), now).verifiedAt).toBe(eventAt)
  })

  it('rejects missing, future, and malformed observations without inventing zero', () => {
    expect(normalizeContextFunding({ funding: undefined, funding_interval_blocks: 8571 }, chain(), now).rate).toBeNaN()
    expect(normalizeContextFunding(market(), chain(64499119, now + 1), now).verifiedAt).toBeUndefined()
    expect(normalizeContextFunding(market({ rate: '0' }), chain(), now).rate).toBeNaN()
  })

  it('preserves effective time across persistence and DTO mapping without aging from it', () => {
    const detail = {
      market: { status: 'FRESH', updatedAt: now },
      position: { status: 'FRESH', updatedAt: now },
      funding: { status: 'FRESH', updatedAt: now, effectiveAt: eventAt },
      orderbook: { status: 'FRESH', updatedAt: now },
      thresholdsMs: { marketMs: 10_000, positionMs: 10_000, fundingMs: 10_000, orderbookMs: 10_000 },
    }
    const freshness = storedTelemetryFreshness(detail, now + 9_000)
    expect(freshness?.funding.status).toBe('FRESH')
    expect(freshness?.funding.updatedAt).toBe(now)
    expect(freshness?.funding.effectiveAt).toBe(eventAt)
    const dto = toTelemetryDto({ timestamp: new Date(now), source: 'perpl-rest', freshness_detail: detail })
    expect(dto.freshness?.funding.updatedAt).toBe(new Date(now).toISOString())
    expect(dto.freshness?.funding.effectiveAt).toBe(new Date(eventAt).toISOString())
  })
})
