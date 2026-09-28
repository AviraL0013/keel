import { describe, expect, it } from 'vitest'
import { toExecutionSummaryDto } from '../server/src/interfaces/http/mappers.js'

describe('Book execution summary', () => {
  it('explains stale pre-submission failure without implying an order was sent', () => {
    expect(
      toExecutionSummaryDto({
        status: 'FAILED',
        id: 'action-1',
        error: 'MARKET_TELEMETRY_STALE',
        submitted_at: null,
        venue_reference: null,
      }).reason,
    ).toBe('Market telemetry became stale before submission. No Perpl order was sent.')
  })
  it('does not label a submitted failure as pre-submission', () => {
    expect(
      toExecutionSummaryDto({
        status: 'FAILED',
        id: 'action-2',
        error: 'MARKET_TELEMETRY_STALE',
        submitted_at: new Date().toISOString(),
      }).reason,
    ).toBe('MARKET_TELEMETRY_STALE')
  })
})
