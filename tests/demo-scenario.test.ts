import { expect, it } from 'vitest'
import { evaluate } from '../packages/risk-engine/src/index.js'
import type { Book, Position, Reserve, NormalizedTelemetry } from '../packages/domain/src/index.js'

it('matches the published demo numbers and refusal path', () => {
  const now = Date.parse('2026-09-29T00:00:00Z')
  const book: Book = {
    id: 'demo',
    userId: 'demo',
    market: 'BTC-PERP',
    side: 'LONG',
    stance: 'DEFEND',
    liquidationFloor: 6,
    defenseCap: 2,
    timeLimitMs: 3_600_000,
    automationEnabled: true,
    status: 'ACTIVE',
    createdAt: new Date(now - 1000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }
  const position: Position = {
    bookId: 'demo',
    side: 'LONG',
    size: 1,
    entryPrice: 100,
    markPrice: 100,
    liquidationPrice: 94,
    leverage: 6,
    unrealizedPnl: 0,
    margin: 16,
    status: 'OPEN',
    timestamp: now,
  }
  const reserve: Reserve = {
    bookId: 'demo',
    available: 5,
    reserved: 0,
    deployed: 0,
    cap: 5,
    updatedAt: new Date(now).toISOString(),
  }
  const telemetry: NormalizedTelemetry = {
    mark: 100,
    oracle: 100,
    bid: 99.99,
    ask: 100.01,
    mid: 100,
    spreadBps: 2,
    fundingRate: 0.0001,
    depthNotional: 5000,
    volatility: 0.01,
    volume24h: 10000,
    openInterest: 10000,
    block: 1,
    timestamp: now,
    source: 'replay',
    freshnessMs: 10,
  }
  expect(evaluate(book, position, reserve, telemetry, Infinity, now).state).toBe('HOLD')
  const breach = { ...telemetry, mark: 98, oracle: 98, bid: 97.99, ask: 98.01, mid: 98 }
  const defend = evaluate(book, position, reserve, breach, Infinity, now)
  expect(defend.state).toBe('DEFEND')
  expect(defend.amount).toBe(1.88)
  expect(evaluate({ ...book, defenseCap: 1 }, position, reserve, breach, Infinity, now).state).toBe('REDUCE')
  expect(evaluate(book, position, reserve, { ...breach, freshnessMs: 20_000 }, Infinity, now).state).toBe('SAFE_MODE')
})
