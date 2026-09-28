import { expect, it } from 'vitest'
import { toAutopsyDto } from '../server/src/interfaces/http/mappers.js'
import { databaseFixture } from './helpers/database.js'

it('exposes stored venue progress and a verified transaction hash in Autopsy', () => {
  const hash = `0x${'ab'.repeat(32)}`
  const dto = toAutopsyDto({
    id: 'event',
    book_id: 'book',
    type: 'DEFEND_CONFIRMED',
    timestamp: '2026-09-29T00:00:00Z',
    payload: { actionId: 'action' },
    venue_progress: {
      requestId: '1791001362433',
      clientSequence: 4,
      admitted: true,
      requestedLastExecBlock: 100,
      effectiveLastExecBlock: 101,
      response: 'ORDER_UPDATE',
    },
    venue_reference: `642:1791001362433:${hash}`,
  })
  expect(dto.venueProgress).toMatchObject({ requestId: '1791001362433', effectiveLastExecBlock: 101 })
  expect(dto.transactionHash).toBe(hash)
})

it('joins action venue progress to the user-owned Autopsy event', async () => {
  const { db, store } = await databaseFixture()
  try {
    const userId = await store.ensureUser('autopsy-venue-owner')
    const book = await store.pool.query(
      "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC','LONG','DEFEND',7,5,3600000) RETURNING id",
      [userId],
    )
    const bookId = book.rows[0].id
    const decision = await store.pool.query(
      "INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features) VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id",
      [bookId],
    )
    const action = await store.pool.query(
      "INSERT INTO actions(book_id,decision_id,kind,amount,status,idempotency_key,venue_progress) VALUES($1,$2,'DEFEND',1,'CONFIRMED','autopsy-test',$3) RETURNING id",
      [bookId, decision.rows[0].id, JSON.stringify({ requestId: '42', admitted: true, response: 'ORDER_UPDATE' })],
    )
    await store.pool.query('INSERT INTO autopsy_events(book_id,type,payload) VALUES($1,$2,$3)', [
      bookId,
      'DEFEND_CONFIRMED',
      JSON.stringify({ actionId: action.rows[0].id }),
    ])
    const rows = await store.listAutopsy(userId, bookId)
    expect(toAutopsyDto(rows[0] as Record<string, unknown>).venueProgress?.requestId).toBe('42')
  } finally {
    await db.close()
  }
}, 20_000)
