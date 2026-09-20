import { describe, expect, it } from 'vitest'
import { replay } from '../packages/risk-engine/src/replay.js'
import { ReserveLedger } from '../packages/chain/src/ledger.js'
import type { Book, NormalizedTelemetry, Position, Reserve } from '../packages/domain/src/index.js'
const book: Book = { id: 'b', userId: 'u', market: 'BTC-PERP', side: 'LONG', stance: 'DEFEND', liquidationFloor: 6, defenseCap: 100, timeLimitMs: 100000, automationEnabled: true, status: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
const position: Position = { bookId: 'b', side: 'LONG', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 94, leverage: 6, unrealizedPnl: 0, margin: 16 }
const reserve: Reserve = { bookId: 'b', available: 100, reserved: 0, deployed: 0, cap: 100, updatedAt: new Date().toISOString() }
const frame = (mark: number, freshnessMs = 1): NormalizedTelemetry => ({ mark, oracle: mark, bid: mark - .01, ask: mark + .01, mid: mark, spreadBps: 2, fundingRate: .0001, depthNotional: 5000, volatility: .01, volume24h: 1, openInterest: 1, block: 1, timestamp: Date.now(), source: 'replay', freshnessMs })
describe('replay and ledger invariants', () => {
  it('replays a floor breach and stale transition deterministically', () => { const result = replay(book, position, reserve, [{ at: Date.now() + 1000, telemetry: frame(100), label: 'healthy' }, { at: Date.now() + 1000, telemetry: frame(98), label: 'breach' }, { at: Date.now() + 1000, telemetry: frame(98, 20_000), label: 'stale' }]); expect(result.map(item => item.state)).toEqual(['HOLD', 'DEFEND', 'SAFE_MODE']) })
  it('rejects deployment above cap', () => { const ledger = new ReserveLedger(); ledger.append({ bookId: 'b', type: 'RESERVE_CREATED', amount: 10 }); ledger.append({ bookId: 'b', type: 'RESERVE_DEPLOYED', amount: 10 }); expect(() => ledger.append({ bookId: 'b', type: 'RESERVE_DEPLOYED', amount: 1 })).toThrow('RESERVE_CAP_EXCEEDED') })
})

