import { describe, expect, it } from 'vitest'
import { BookMonitor } from '../server/src/monitor.js'
import type { Book, NormalizedTelemetry, Position, Reserve, Decision } from '../packages/domain/src/index.js'
const book: Book = { id: 'b', userId: 'u', market: 'BTC', side: 'LONG', stance: 'DEFEND', liquidationFloor: 5, defenseCap: 10, timeLimitMs: 3600000, automationEnabled: true, status: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
const position: Position = { bookId: 'b', side: 'LONG', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90, leverage: 5, unrealizedPnl: 0, margin: 20, timestamp: Date.now() }
const reserve: Reserve = { bookId: 'b', available: 10, reserved: 0, deployed: 0, cap: 10, updatedAt: new Date().toISOString() }
const telemetry: NormalizedTelemetry = { mark: 100, oracle: 100, bid: 99, ask: 101, mid: 100, spreadBps: 200, fundingRate: 0, depthNotional: 10000, volatility: 0, volume24h: 0, openInterest: 0, block: 1, timestamp: Date.now(), source: 'replay', freshnessMs: 1 }
describe('Book monitor', () => { it('deduplicates identical decisions', async () => { const saved: Decision[] = []; const monitor = new BookMonitor({ getArmedBooks: async () => [{ book, position, reserve, telemetry, priorDefenseEfficiency: Infinity }], saveDecision: async d => { saved.push(d) } }); expect((await monitor.tick()).length).toBe(1); expect((await monitor.tick()).length).toBe(0); expect(saved).toHaveLength(1) }) })
