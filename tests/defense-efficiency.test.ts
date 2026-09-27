import { describe, expect, it } from 'vitest'
import { evaluate, liquidationDistance } from '../packages/risk-engine/src/index.js'
import { measureDefense } from '../packages/risk-engine/src/sizing.js'
import type { Book, NormalizedTelemetry, Position, Reserve } from '../packages/domain/src/index.js'
import { PostgresExecutionRepository } from '../server/src/infrastructure/database/execution-repository.js'
import { databaseFixture } from './helpers/database.js'

const mark = 96_400
function setup(notional: number) {
  const at = Date.now()
  const size = notional / mark
  const book: Book = { id: 'efficiency-book', userId: 'owner', market: 'BTC-PERP', side: 'LONG', stance: 'DEFEND', status: 'ACTIVE', automationEnabled: true, liquidationFloor: 6, defenseCap: 1_000, timeLimitMs: 3_600_000, createdAt: new Date(at - 1_000).toISOString(), updatedAt: new Date(at).toISOString() }
  const position: Position = { bookId: book.id, side: 'LONG', status: 'OPEN', size, entryPrice: mark, markPrice: mark, liquidationPrice: mark * .95, margin: notional / 5, leverage: 5, unrealizedPnl: 0, timestamp: at, observedAt: at }
  const reserve: Reserve = { bookId: book.id, available: 1_000, reserved: 0, deployed: 0, cap: 1_000, updatedAt: new Date(at).toISOString() }
  const telemetry: NormalizedTelemetry = { mark, oracle: mark, bid: mark - 1, ask: mark + 1, mid: mark, spreadBps: 2, fundingRate: 0, depthNotional: 1_000_000, volatility: 0, volume24h: 1, openInterest: 1, block: 1, timestamp: at, source: 'replay', freshnessMs: 0 }
  const observation = (liquidationPrice: number, timestamp: number) => ({ liquidationDistance: liquidationDistance({ ...position, liquidationPrice }, mark), funding: 0, depth: telemetry.depthNotional, volatility: 0, timestamp })
  return { book, position, reserve, telemetry, observation, at }
}

describe('defense efficiency is measured against predicted improvement', () => {
  it.each([100, 1_000, 4_820, 20_000])('accepts a perfect defense at %i AUSD notional', notional => {
    const value = setup(notional)
    const sized = evaluate(value.book, value.position, value.reserve, value.telemetry, Infinity, value.at)
    expect(sized.action).toBe('DEFEND')
    const sensitivity = notional / 100
    const afterLiquidation = value.position.liquidationPrice - sized.amount / value.position.size
    const measured = measureDefense(value.observation(value.position.liquidationPrice, value.at), value.observation(afterLiquidation, value.at + 1), sized.amount, sensitivity)
    expect(measured.basis).toBe('PREDICTED_RATIO')
    expect(measured.predictedImprovement).toBeCloseTo(sized.amount / sensitivity, 6)
    expect(measured.efficiency).toBeCloseTo(1, 6)
    expect(measured.efficiencyPerAusd).toBeCloseTo(measured.improvement / sized.amount, 6)
    const next = evaluate(value.book, value.position, value.reserve, value.telemetry, measured.efficiency, value.at)
    expect(next.action).toBe('DEFEND')
    expect(next.reasonCodes).not.toContain('DEFENSE_REFUSED')
  })

  it('refuses rescue when only 23 percent of predicted improvement materializes', () => {
    const value = setup(1_000)
    const sized = evaluate(value.book, value.position, value.reserve, value.telemetry, Infinity, value.at)
    const afterLiquidation = value.position.liquidationPrice - sized.amount / value.position.size * .23
    const measured = measureDefense(value.observation(value.position.liquidationPrice, value.at), value.observation(afterLiquidation, value.at + 1), sized.amount, 10)
    expect(measured.efficiency).toBeCloseTo(.23, 6)
    const next = evaluate(value.book, value.position, value.reserve, value.telemetry, measured.efficiency, value.at)
    expect(['REDUCE', 'EXIT']).toContain(next.action)
    expect(next.reasonCodes).toContain('DEFENSE_REFUSED')
  })

  it.each([0, -1, NaN])('rejects invalid sensitivity %s', sensitivity => {
    const value = setup(1_000)
    expect(() => measureDefense(value.observation(value.position.liquidationPrice, value.at), value.observation(value.position.liquidationPrice - 10, value.at + 1), 1, sensitivity)).toThrow('INVALID_DEFENSE_MEASUREMENT')
  })

  it('ignores legacy per-AUSD rows and uses only predicted-ratio rows', async () => {
    const { db, store } = await databaseFixture()
    try {
      const userId = await store.ensureUser('efficiency-owner')
      const at = Date.now()
      const book = await store.createBook(userId, { market: 'BTC-PERP', marketId: 1, venueAccountId: 7, venuePositionId: 9, side: 'LONG', stance: 'DEFEND', status: 'ACTIVE', automationEnabled: true, liquidationFloor: 6, defenseCap: 5, reserveAvailable: 10, timeLimitMs: 3_600_000,
        initialPosition: { side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 94, margin: 20, leverage: 5, unrealizedPnl: 0, timestamp: at, observedAt: at },
        initialTelemetry: { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, spreadBps: 20, fundingRate: 0, depthNotional: 10_000, volatility: 0, volume24h: 1, openInterest: 1, block: 1, timestamp: at, source: 'replay' } })
      const repo = new PostgresExecutionRepository(store)
      const addRow = async (efficiency: number, measurement: object) => {
        const decision = await db.query<{ id: string }>("INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features) VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id", [book.id])
        const action = await db.query<{ id: string }>("INSERT INTO actions(book_id,decision_id,kind,amount,status,idempotency_key) VALUES($1,$2,'DEFEND',1,'CONFIRMED',$3) RETURNING id", [book.id, decision.rows[0].id, crypto.randomUUID()])
        await db.query('INSERT INTO defense_performance(action_id,book_id,amount,efficiency,measurement) VALUES($1,$2,1,$3,$4)', [action.rows[0].id, book.id, efficiency, JSON.stringify(measurement)])
      }
      await addRow(.02, {})
      expect(await repo.priorEfficiency(book.id)).toBe(Infinity)
      await addRow(.8, { basis: 'PREDICTED_RATIO' })
      expect(await repo.priorEfficiency(book.id)).toBe(.8)
    } finally { await db.close() }
  }, 20_000)
})
