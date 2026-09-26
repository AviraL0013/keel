import { describe, expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { PerplRequestIdAllocator } from '../server/src/infrastructure/perpl/request-id-allocator.js'
import { forwardedRequestDelta, nextForwardedRequestId, orderFrameWithRequestId, parsePerplRequestIds, requestId, validForwardedRequestId } from '../packages/perpl/src/request-id.js'

describe('Exchange signed-32 forwarding window', () => {
  it('reproduces the failed on-chain ID and selects the verified recovery candidate', () => {
    expect(forwardedRequestDelta('1790412137977', '0')).toBe(-589224455n)
    expect(validForwardedRequestId('1790412137977', '0')).toBe(false)
    expect(nextForwardedRequestId('0', '1790412137977')).toBe('1791001362433')
    expect(forwardedRequestDelta('1791001362433', '0')).toBe(1n)
  })
  it.each([
    ['0', '0', '1'],
    ['0', '2147483646', '2147483647'],
    ['0', '2147483647', '4294967297'],
    ['0', '4294967295', '4294967297'],
    ['4294967295', '4294967295', '4294967296'],
    ['4294967295', '6442450942', '8589934592'],
    ['9007199254740993', '9007199254740993', '9007199254740994'],
  ])('allocates within the serial window: lfr=%s highWater=%s', (lfr, highWater, expected) => {
    expect(nextForwardedRequestId(lfr, highWater)).toBe(expected)
    expect(validForwardedRequestId(expected, lfr)).toBe(true)
  })
  it('rejects equality, half-range ambiguity, malformed IDs and uint64 exhaustion', () => {
    expect(validForwardedRequestId('4294967296', '0')).toBe(false)
    expect(validForwardedRequestId('2147483648', '0')).toBe(false)
    expect(validForwardedRequestId('0', '4294967295')).toBe(false)
    expect(() => nextForwardedRequestId('', '0')).toThrow('PERPL_REQUEST_ID_INVALID')
    expect(() => nextForwardedRequestId('0', '18446744073709551615')).toThrow('PERPL_REQUEST_ID_OVERFLOW')
    expect(() => nextForwardedRequestId('0', '18446744073709551614')).toThrow('PERPL_REQUEST_ID_OVERFLOW')
  })
})

describe('Perpl request ID allocator', () => {
  it('skips the invalid signed-32 window left by the rejected account-642 timestamp ID', async () => {
    const { db, store } = await databaseFixture()
    try {
      await db.query('INSERT INTO perpl_request_ids(account_id,last_rq) VALUES(642,1790412137977)')
      const allocator = new PerplRequestIdAllocator(store.pool)
      expect(await allocator.allocate(642, '0')).toBe('1791001362433')
      expect(await new PerplRequestIdAllocator(store.pool).allocate(642, '0')).toBe('1791001362434')
    } finally { await db.close() }
  }, 20000)

  it('preserves signed rejection evidence after a local DB reset without allocating from direct-order history', async () => {
    const { db, store } = await databaseFixture()
    try {
      const allocator = new PerplRequestIdAllocator(store.pool)
      expect(await allocator.allocate(642, '0', '1790412137977')).toBe('1791001362433')
      const result = await db.query<{ last_rq: string }>('SELECT last_rq FROM perpl_request_ids WHERE account_id=642')
      expect(String(result.rows[0].last_rq)).toBe('1791001362433')
      expect(await allocator.allocate(643, '0')).toBe('1')
      await expect(allocator.allocate(642, '0', '18446744073709551615')).rejects.toThrow('PERPL_REQUEST_ID_OVERFLOW')
      expect(String((await db.query<{ last_rq: string }>('SELECT last_rq FROM perpl_request_ids WHERE account_id=642')).rows[0].last_rq)).toBe('1791001362433')
    } finally { await db.close() }
  }, 20000)

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
