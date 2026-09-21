import { describe, expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { PostgresExecutionRepository } from '../server/src/infrastructure/database/execution-repository.js'
import { ExecutionWorker } from '../server/src/workers/execution-worker.js'
import type { Action } from '../packages/domain/src/index.js'

function input() {
  return { market: 'BTC-PERP', marketId: 1, venueAccountId: 7, venuePositionId: 9,
    side: 'LONG' as const, stance: 'DEFEND' as const, liquidationFloor: 6, defenseCap: 50,
    timeLimitMs: 3600000, automationEnabled: false, status: 'PAUSED' as const, reserveAvailable: 50,
    initialPosition: { side: 'LONG' as const, size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90,
      leverage: 5, unrealizedPnl: 0, margin: 20, status: 'OPEN' as const, timestamp: Date.now() },
    initialTelemetry: { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100,
      spreadBps: 20, fundingRate: 0.0001, depthNotional: 10000, volatility: 0.01,
      volume24h: 10, openInterest: 100, block: 1, timestamp: Date.now(), source: 'replay' as const } }
}

describe('stateful Book control loop', () => {
  it('settles a confirmed DEFEND from post-state and refuses later rescue', async () => {
    const { db, store } = await databaseFixture()
    try {
      const user = await store.ensureUser('loop-owner')
      const now = Date.now()
      const setup = { ...input(), automationEnabled: true, status: 'ACTIVE' as const,
        initialPosition: { ...input().initialPosition!, markPrice: 100, liquidationPrice: 90, timestamp: now },
        initialTelemetry: { ...input().initialTelemetry!, mark: 100, mid: 100, bid: 99.9, ask: 100.1, timestamp: now } }
      const book = await store.createBook(user, setup)
      const repo = new PostgresExecutionRepository(store)
      await db.query('UPDATE positions SET mark_price=95, observed_at=now() WHERE book_id=$1', [book.id])
      await db.query("INSERT INTO risk_snapshots(book_id,block,timestamp,mark,oracle,liquidation,funding,spread,depth,volatility,reserve,freshness,source,bid,ask,mid) SELECT book_id,2,now(),95,95,90,0.0001,20,10000,0.01,50,1,'perpl-rest',94.9,95.1,95 FROM positions WHERE book_id=$1", [book.id])
      const venue = {
        submit: async (_action: Action) => ({ venueReference: 'loop-1', status: 'SUBMITTED' as const }),
        reconcile: async (action: Action) => {
          await db.query('UPDATE positions SET mark_price=95.1, observed_at=now() WHERE book_id=$1', [action.bookId])
          await db.query("INSERT INTO risk_snapshots(book_id,block,timestamp,mark,oracle,liquidation,funding,spread,depth,volatility,reserve,freshness,source,bid,ask,mid) SELECT book_id,3,now(),95.1,95.1,90,0.0001,20,10000,0.01,50,1,'perpl-rest',95,95.2,95.1 FROM positions WHERE book_id=$1", [action.bookId])
          return { ...action, status: 'CONFIRMED' as const, confirmedAt: new Date().toISOString() }
        },
      }
      const worker = new ExecutionWorker(repo, venue)
      const decision = await worker.evaluate(book.id)
      expect(decision.action).toBe('DEFEND')
      const confirmed = await worker.execute(decision)
      expect(confirmed.status).toBe('CONFIRMED')
      expect((await db.query('SELECT * FROM defense_performance WHERE book_id=$1', [book.id])).rows).toHaveLength(1)
      await db.query('UPDATE positions SET mark_price=91, observed_at=now() WHERE book_id=$1', [book.id])
      await db.query("INSERT INTO risk_snapshots(book_id,block,timestamp,mark,oracle,liquidation,funding,spread,depth,volatility,reserve,freshness,source,bid,ask,mid) SELECT book_id,4,now(),91,91,90,0.002,120,100,0.2,50,1,'perpl-ws',90.9,91.1,91 FROM positions WHERE book_id=$1", [book.id])
      const refused = await worker.evaluate(book.id)
      expect(['REDUCE', 'EXIT']).toContain(refused.action)
      expect(refused.reasonCodes).toContain('DEFENSE_REFUSED')
      expect((await db.query("SELECT type FROM autopsy_events WHERE book_id=$1 AND type='DEFENSE_EFFICIENCY_UPDATED'", [book.id])).rows).toHaveLength(1)
    } finally { await db.close() }
  }, 20000)
})

