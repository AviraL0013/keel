import { describe, expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'

describe('Book execution ordering', () => {
  it('shows the latest decision action rather than the highest UUID', async () => {
    const { db, store } = await databaseFixture()
    try {
      const userId = (await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES('0x123') RETURNING id")).rows[0].id
      const bookId = (await db.query<{ id: string }>("INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC','LONG','DEFEND',6,5,3600000) RETURNING id", [userId])).rows[0].id
      const addAction = async (decisionAt: string, actionId: string, status: string) => {
        const decisionId = (await db.query<{ id: string }>("INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features,created_at) VALUES($1,'DEFEND','DEFEND','[]','[]','{}',$2) RETURNING id", [bookId, decisionAt])).rows[0].id
        await db.query('INSERT INTO actions(id,book_id,decision_id,kind,status,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)', [actionId, bookId, decisionId, 'DEFEND', status, actionId])
      }
      await addAction('2026-09-26T17:56:55.833Z', 'd3fba3d8-6ce9-4a9a-a3fb-c9e373e4e18d', 'FAILED')
      await addAction('2026-09-26T18:03:20.347Z', '719c4b43-8df4-4225-9c0f-35ffc734a89f', 'CONFIRMED')

      const actions = await store.listActions(userId, bookId) as Array<{ id: string; status: string }>
      expect(actions.map(action => action.status)).toEqual(['CONFIRMED', 'FAILED'])
      expect(actions[0].id).toBe('719c4b43-8df4-4225-9c0f-35ffc734a89f')
    } finally {
      await db.close()
    }
  }, 20000)
})
