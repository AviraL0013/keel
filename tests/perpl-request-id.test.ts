import { describe, expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { PerplRequestIdAllocator } from '../server/src/infrastructure/perpl/request-id-allocator.js'
import { orderFrameWithRequestId, parsePerplRequestIds, requestId } from '../packages/perpl/src/request-id.js'

describe('Perpl request ID allocator', () => {
  it('uses fresh venue lfr after an empty local database and ignores a lower local counter', async () => {
    const { db, store } = await databaseFixture()
    try {
      const allocator = new PerplRequestIdAllocator(store.pool)
      expect(await allocator.allocate(642, '1790412138000')).toBe('1790412138001')
      await db.query('UPDATE perpl_request_ids SET last_rq=1 WHERE account_id=642')
      expect(await allocator.allocate(642, '1790412138000')).toBe('1790412138001')
    } finally { await db.close() }
  }, 20000)

  it('uses durable high water, unresolved action references, and persists across allocator instances', async () => {
    const { db, store } = await databaseFixture()
    try {
      const first = new PerplRequestIdAllocator(store.pool)
      expect(await first.allocate(642, '44')).toBe('45')
      expect(await new PerplRequestIdAllocator(store.pool).allocate(642, '44')).toBe('46')
      const user = (await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES('0x111') RETURNING id")).rows[0].id
      const book = (await db.query<{ id: string }>("INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC','LONG','DEFEND',6,5,3600000) RETURNING id", [user])).rows[0].id
      const decision = (await db.query<{ id: string }>("INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features) VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id", [book])).rows[0].id
      await db.query("INSERT INTO actions(book_id,decision_id,kind,status,idempotency_key,venue_reference) VALUES($1,$2,'DEFEND','UNKNOWN','prior','642:100')", [book, decision])
      expect(await first.allocate(642, '44')).toBe('101')
      await db.query('UPDATE perpl_request_ids SET last_rq=200 WHERE account_id=642')
      expect(await first.allocate(642, '44')).toBe('201')
    } finally { await db.close() }
  }, 20000)

  it('keeps uint64 request IDs exact on wire and rejects missing/unsafe baselines', async () => {
    const huge = '9007199254740993'
    expect(requestId(huge)).toBe(9007199254740993n)
    expect(() => requestId(Number(huge))).toThrow('PERPL_REQUEST_ID_INVALID')
    expect(() => requestId(undefined)).toThrow('PERPL_REQUEST_ID_INVALID')
    const parsed = parsePerplRequestIds(`{"mt":19,"as":[{"lfr":${huge}}]}`) as { as: Array<{ lfr: string }> }
    expect(parsed.as[0].lfr).toBe(huge)
    expect(orderFrameWithRequestId({ mt: 22, sn: 1 }, huge)).toContain(`"rq":${huge}`)
    const { db, store } = await databaseFixture()
    try {
      expect(await new PerplRequestIdAllocator(store.pool).allocate(642, huge)).toBe('9007199254740994')
      await expect(new PerplRequestIdAllocator(store.pool).allocate(642, '')).rejects.toThrow('PERPL_REQUEST_ID_INVALID')
    } finally { await db.close() }
  }, 20000)
})
