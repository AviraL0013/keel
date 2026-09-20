import { it, expect } from 'vitest'
import { evaluate } from '../packages/risk-engine/src/index.js'
import type { Book, Position, Reserve, NormalizedTelemetry } from '../packages/domain/src/index.js'

it('risk engine blocks stale state', () => {
  const now = Date.now()
  const book: Book = { id: 'fixture', userId: 'fixture', market: 'BTC-PERP', side: 'LONG', stance: 'DEFEND', liquidationFloor: 6, defenseCap: 100, timeLimitMs: 8 * 3600000, automationEnabled: true, status: 'ACTIVE', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }
  const position: Position = { bookId: book.id, side: 'LONG', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90, leverage: 1, unrealizedPnl: 0, margin: 100, status: 'OPEN' }
  const reserve: Reserve = { bookId: book.id, available: 100, reserved: 0, deployed: 0, cap: 100, updatedAt: new Date(now).toISOString() }
  const telemetry: NormalizedTelemetry = { mark: 100, oracle: 100, bid: 99.98, ask: 100.02, mid: 100, spreadBps: 10, fundingRate: .0001, depthNotional: 900, volatility: 0, volume24h: 0, openInterest: 0, block: 1, timestamp: now, source: 'replay', freshnessMs: 999999 }
  expect(evaluate(book, position, reserve, telemetry, 1, now).state).toBe('SAFE_MODE')
})
