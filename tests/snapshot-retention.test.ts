import { describe, expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { SnapshotRetention, snapshotRetentionConfig } from '../server/src/infrastructure/database/snapshot-retention.js'

const hour = 3_600_000
const day = 24 * hour

describe('snapshot retention', () => {
  it('validates configurable windows and accepts the prior setting prefix', () => {
    expect(snapshotRetentionConfig({ KEEL_SNAPSHOT_FULL_HOURS: '24' }).fullMs).toBe(day)
    expect(() => snapshotRetentionConfig({ EYELER_SNAPSHOT_FULL_HOURS: '720' })).toThrow(
      'INVALID_EYELER_SNAPSHOT_RETENTION_WINDOWS',
    )
    expect(() => snapshotRetentionConfig({ EYELER_SNAPSHOT_RETENTION_BATCH_SIZE: '0' })).toThrow(
      'INVALID_EYELER_SNAPSHOT_RETENTION_BATCH_SIZE',
    )
  })
  it('keeps recent snapshots, one per minute in the archive, and unresolved books', async () => {
    const { db, store } = await databaseFixture()
    const now = Date.parse('2026-09-29T00:00:00.000Z')
    try {
      const user = await store.pool.query(
        "INSERT INTO users(wallet_address) VALUES('0x0000000000000000000000000000000000000001') RETURNING id",
      )
      const books = []
      for (let i = 0; i < 2; i++) {
        const result = await store.pool.query(
          "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms,status) VALUES($1,'BTC','LONG','DEFEND',7,5,3600000,'ACTIVE') RETURNING id",
          [user.rows[0].id],
        )
        books.push(result.rows[0].id)
      }
      const insert = async (bookId: string, at: number) => {
        const result = await store.pool.query(
          "INSERT INTO risk_snapshots(book_id,block,timestamp,mark,oracle,liquidation,funding,spread,depth,volatility,reserve,freshness,source) VALUES($1,1,$2,100,100,90,0,0,100,0,5,0,'test') RETURNING id",
          [bookId, new Date(at).toISOString()],
        )
        return result.rows[0].id
      }
      const recent = await insert(books[0], now - hour)
      const archivedOld = await insert(books[0], now - 3 * day)
      const archivedNew = await insert(books[0], now - 3 * day + 20_000)
      const expired = await insert(books[0], now - 31 * day)
      const unresolved = await insert(books[1], now - 31 * day)
      const decision = await store.pool.query(
        "INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features) VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id",
        [books[1]],
      )
      await store.pool.query(
        "INSERT INTO actions(book_id,decision_id,kind,amount,status,idempotency_key) VALUES($1,$2,'DEFEND',1,'UNKNOWN','retention-unresolved')",
        [books[1], decision.rows[0].id],
      )
      const retention = new SnapshotRetention(
        store.pool,
        { fullMs: 2 * day, archiveMs: 30 * day, batchSize: 1, intervalMs: hour },
        () => now,
      )
      expect(await retention.runOnce()).toBe(1)
      expect(await retention.runOnce()).toBe(1)
      expect(await retention.runOnce()).toBe(0)
      const rows = await store.pool.query('SELECT id FROM risk_snapshots')
      expect(new Set(rows.rows.map((row) => row.id))).toEqual(new Set([recent, archivedNew, unresolved]))
      expect(rows.rows.map((row) => row.id)).not.toContain(archivedOld)
      expect(rows.rows.map((row) => row.id)).not.toContain(expired)
    } finally {
      await db.close()
    }
  })
})
