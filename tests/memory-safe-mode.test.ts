import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../server/src/memoryStore.js'
import type { SafeModeReason } from '../packages/domain/src/index.js'

async function safeModeBook(reason: SafeModeReason) {
  const store = new MemoryStore()
  const at = Date.now()
  const since = new Date(at).toISOString()
  const book = await store.createBook('owner', {
    market: 'ETH-PERP',
    marketId: 2,
    venueAccountId: 7,
    venuePositionId: 10,
    side: 'LONG',
    stance: 'DEFEND',
    status: 'SAFE_MODE',
    safeModeReason: reason,
    safeModeSince: since,
    automationEnabled: true,
    liquidationFloor: 6,
    defenseCap: 5,
    reserveAvailable: 10,
    timeLimitMs: 3_600_000,
    initialPosition: {
      side: 'LONG',
      status: 'OPEN',
      size: 1,
      entryPrice: 100,
      markPrice: 95,
      liquidationPrice: 90,
      margin: 20,
      leverage: 5,
      unrealizedPnl: 0,
      timestamp: at,
      observedAt: at,
    },
    initialTelemetry: {
      mark: 95,
      oracle: 95,
      bid: 94.9,
      ask: 95.1,
      mid: 95,
      spreadBps: 20,
      fundingRate: 0,
      depthNotional: 10_000,
      volatility: 0,
      volume24h: 1,
      openInterest: 1,
      block: 1,
      timestamp: at,
      source: 'replay',
    },
  })
  return { store, book, since }
}

describe('test-store SAFE_MODE controls', () => {
  it.each(['DATA_UNAVAILABLE', 'VENUE_UNAVAILABLE'] as const)(
    'pauses and clears a transient %s episode',
    async (reason) => {
      const { store, book, since } = await safeModeBook(reason)
      expect(await store.getBook('owner', book.id)).toMatchObject({
        status: 'SAFE_MODE',
        automationEnabled: true,
        safeModeReason: reason,
        safeModeSince: since,
      })
      const paused = await store.updateBookControls('owner', book.id, { automationEnabled: false })
      expect(paused).toMatchObject({
        status: 'PAUSED',
        automationEnabled: false,
        safeModeReason: null,
        safeModeSince: null,
      })
    },
  )

  it('keeps unresolved-action SAFE_MODE when automation is turned off', async () => {
    const { store, book, since } = await safeModeBook('UNRESOLVED_ACTION')
    const paused = await store.updateBookControls('owner', book.id, { automationEnabled: false })
    expect(paused).toMatchObject({
      status: 'SAFE_MODE',
      automationEnabled: false,
      safeModeReason: 'UNRESOLVED_ACTION',
      safeModeSince: since,
    })
  })
})
