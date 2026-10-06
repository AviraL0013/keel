import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { DevelopmentKeyCustody } from '../server/src/infrastructure/perpl/key-custody.js'
import { PerplUserVenues } from '../server/src/infrastructure/perpl/user-venues.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { Action } from '../packages/domain/src/index.js'

async function fixture() {
  const { db, store } = await databaseFixture()
  const custody = new DevelopmentKeyCustody('12'.repeat(32))
  const a = await store.ensureUser('0x0000000000000000000000000000000000000001')
  const b = await store.ensureUser('0x0000000000000000000000000000000000000002')
  const add = async (userId: string, accountId: number, environment = 'testnet') => {
    const id = randomUUID()
    await store.pool.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,wallet_address,scope_mask,expires_at,sealed_private_key,sealed_api_token)
       SELECT $1::uuid,id,$3,'trade',$1::text,'ACTIVE',wallet_address,3,now()+interval '1 day',$4,$5 FROM users WHERE id=$2`,
      [
        id,
        userId,
        environment,
        custody.seal('11'.repeat(32), `${id}:private_key`),
        custody.seal(`token-${accountId}`, `${id}:api_token`),
      ],
    )
    await store.pool.query('INSERT INTO perpl_accounts(connection_id,account_id) VALUES($1,$2)', [id, accountId])
    return id
  }
  const created: RuntimeVenue[] = []
  const factory = vi.fn(async (credentials: { accountId: number }) => {
    const venue: RuntimeVenue = {
      accountId: credentials.accountId,
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      ready: () => true,
      refresh: vi.fn(async () => {}),
      submit: vi.fn(),
      reconcile: vi.fn(),
      listPositions: vi.fn(async () => []),
    }
    created.push(venue)
    return venue
  })
  const registry = new PerplUserVenues(store, 'testnet', custody, factory)
  return { db, store, a, b, add, factory, created, registry }
}

describe('per-user Perpl runtime ownership', () => {
  it('closes established sockets before waiting for another users pending credential initialization', async () => {
    const f = await fixture()
    let finishFactory!: (value: RuntimeVenue) => void
    const blocked = new Promise<RuntimeVenue>((resolve) => {
      finishFactory = resolve
    })
    try {
      await f.add(f.a, 642)
      await f.add(f.b, 777)
      await f.registry.start()
      await f.registry.forUser(f.a)
      f.factory.mockImplementationOnce(async () => blocked)
      const pending = f.registry.forUser(f.b)
      await vi.waitFor(() => expect(f.factory).toHaveBeenCalledTimes(2))
      const closing = f.registry.close()
      expect(f.created[0].close).toHaveBeenCalledOnce()
      expect(f.registry.ready()).toBe(false)
      finishFactory({ ...f.created[0], accountId: 777, close: vi.fn(async () => {}) })
      await closing
      expect(await pending).toBeUndefined()
    } finally {
      finishFactory?.({ accountId: 777, close: async () => {} } as RuntimeVenue)
      await f.registry.close()
      await f.db.close()
    }
  }, 20000)
  it('reconciles an expired connection with a renewed key for the same verified account without authorizing new orders', async () => {
    const f = await fixture()
    try {
      const oldId = await f.add(f.a, 642)
      await f.registry.start()
      await f.registry.forUser(f.a, oldId)
      const bookId = (
        await f.db.query(
          `INSERT INTO books(user_id,market,market_id,venue_account_id,venue_position_id,side,stance,
         liquidation_floor,defense_cap,time_limit_ms,perpl_connection_id)
         VALUES($1,'BTC',1,642,123,'LONG','DEFEND',5,5,1000,$2) RETURNING id`,
          [f.a, oldId],
        )
      ).rows[0].id
      await f.db.query(
        `UPDATE perpl_connections SET status='EXPIRED',expires_at=now()-interval '1 second',
         sealed_private_key=NULL,sealed_api_token=NULL WHERE id=$1`,
        [oldId],
      )
      const nextId = await f.add(f.a, 642)
      expect(await f.registry.forUser(f.a, oldId)).toBeUndefined()
      const recovery = await f.registry.recoveryForUser(f.a, oldId)
      expect(recovery?.connectionId).toBe(oldId)
      const action = { id: randomUUID(), bookId, status: 'UNKNOWN', venueReference: '642:1791001362478' } as Action
      f.created.at(-1)!.reconcile = vi.fn(async () => ({ ...action, status: 'CONFIRMED' }) as never)
      await recovery!.reconcile(action)
      expect(f.created.at(-1)!.reconcile).toHaveBeenCalledWith(action)
      await expect(recovery!.submit(action)).rejects.toThrow('PERPL_CONNECTION_RENEWAL_REQUIRES_REVIEW')
      expect(f.created.every((venue) => vi.mocked(venue.submit).mock.calls.length === 0)).toBe(true)
      expect((await f.store.getBook(f.a, bookId))?.perplConnectionId).toBe(oldId)
      expect(await f.registry.recoveryForUser(f.b, oldId)).toBeUndefined()
      await f.db.query("UPDATE perpl_connections SET status='REVOKED' WHERE id=$1", [nextId])
      await expect(recovery!.reconcile(action)).rejects.toThrow('PERPL_CONNECTION_UNAVAILABLE')
      await f.add(f.a, 888)
      expect(await f.registry.recoveryForUser(f.a, oldId)).toBeUndefined()
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20000)
  it('rejects disabled forwarding before opening or using a cached venue', async () => {
    const f = await fixture()
    try {
      const id = await f.add(f.a, 642)
      await f.registry.start()
      const venue = await f.registry.forUser(f.a)
      await f.store.pool.query('UPDATE perpl_accounts SET forwarding=false WHERE connection_id=$1', [id])
      await expect(venue!.listPositions!()).rejects.toThrow('PERPL_CONNECTION_UNAVAILABLE')
      expect(f.created[0].listPositions).not.toHaveBeenCalled()
      expect(await f.registry.forUser(f.a)).toBeUndefined()
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20000)
  it('keeps connection credentials while a bound action remains UNKNOWN or PARTIAL', async () => {
    const f = await fixture()
    try {
      const id = await f.add(f.a, 642)
      const book = (
        await f.db.query(
          "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms,perpl_connection_id) VALUES($1,'BTC','LONG','DEFEND',5,5,1000,$2) RETURNING id",
          [f.a, id],
        )
      ).rows[0].id
      const decision = (
        await f.db.query(
          "INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features) VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id",
          [book],
        )
      ).rows[0].id
      await f.db.query(
        "INSERT INTO actions(book_id,decision_id,kind,status,idempotency_key) VALUES($1,$2,'DEFEND','UNKNOWN','fixture-pending')",
        [book, decision],
      )
      await expect(f.store.revokeConnection(f.a)).rejects.toThrow('PERPL_CONNECTION_EXECUTION_UNRESOLVED')
      expect(
        (await f.db.query('SELECT sealed_private_key FROM perpl_connections WHERE id=$1', [id])).rows[0]
          .sealed_private_key,
      ).not.toBeNull()
      await f.db.query("UPDATE actions SET status='PARTIAL' WHERE book_id=$1", [book])
      await expect(f.store.revokeConnection(f.a)).rejects.toThrow('PERPL_CONNECTION_EXECUTION_UNRESOLVED')
      await f.db.query("UPDATE actions SET status='CONFIRMED' WHERE book_id=$1", [book])
      await f.store.revokeConnection(f.a)
      await expect(
        f.db.query(
          "INSERT INTO actions(book_id,decision_id,kind,status,idempotency_key) VALUES($1,$2,'DEFEND','QUEUED','fixture-after-revoke')",
          [book, decision],
        ),
      ).rejects.toThrow('PERPL_CONNECTION_UNAVAILABLE')
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20000)
  it('reapplies the binding migration safely and preserves legacy unbound Books', async () => {
    const f = await fixture()
    try {
      const legacy = await f.db.query(
        "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC','LONG','DEFEND',5,5,1000) RETURNING id",
        [f.a],
      )
      for (const file of [
        '014_book_connection_binding.sql',
        '015_telegram_links.sql',
        '016_perpl_connection_execution_guard.sql',
      ])
        await f.db.exec(await readFile(`database/migrations/${file}`, 'utf8'))
      const preserved = await f.db.query('SELECT id,perpl_connection_id,defense_cap FROM books WHERE user_id=$1', [f.a])
      expect(preserved.rows).toEqual([{ id: legacy.rows[0].id, perpl_connection_id: null, defense_cap: '5' }])
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20_000)

  it('does not let two different owners claim the same Perpl account', async () => {
    const f = await fixture()
    try {
      await f.add(f.a, 642)
      await f.add(f.b, 642)
      await f.registry.start()
      await expect(f.registry.forUser(f.a)).rejects.toThrow('PERPL_ACCOUNT_OWNERSHIP_CONFLICT')
      expect(f.factory).not.toHaveBeenCalled()
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20_000)

  it('does not decrypt or start a venue while standby has not acquired the lock', async () => {
    const f = await fixture()
    try {
      await f.add(f.a, 642)
      expect(await f.registry.forUser(f.a)).toBeUndefined()
      expect(f.factory).not.toHaveBeenCalled()
      expect(f.registry.ready()).toBe(false)
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20_000)

  it('resolves each user separately and never falls back to another user or environment', async () => {
    const f = await fixture()
    try {
      const aId = await f.add(f.a, 642)
      const bId = await f.add(f.b, 777)
      await f.add(f.a, 999, 'mainnet')
      await f.registry.start()
      expect((await f.registry.forUser(f.a))?.accountId).toBe(642)
      expect((await f.registry.forUser(f.b))?.accountId).toBe(777)
      expect(await f.registry.forUser(f.a, bId)).toBeUndefined()
      expect(await f.registry.forUser(f.b, aId)).toBeUndefined()
      expect(await f.registry.forUser(randomUUID())).toBeUndefined()
      expect(f.factory).toHaveBeenCalledTimes(2)
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20_000)

  it('starts one socket owner for concurrent requests and retains the original Book connection', async () => {
    const f = await fixture()
    try {
      const id = await f.add(f.a, 642)
      await f.registry.start()
      const venues = await Promise.all(Array.from({ length: 12 }, () => f.registry.forUser(f.a, id)))
      expect(venues.every((venue) => venue === venues[0])).toBe(true)
      expect(f.factory).toHaveBeenCalledTimes(1)
      expect(f.created[0].start).toHaveBeenCalledTimes(1)
      await f.store.pool.query("UPDATE perpl_connections SET status='REVOKED',revoked_at=now() WHERE id=$1", [id])
      await f.add(f.a, 888)
      expect(await f.registry.forUser(f.a, id)).toBeUndefined()
      expect(f.created[0].close).toHaveBeenCalledTimes(1)
      expect((await f.registry.forUser(f.a))?.accountId).toBe(888)
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20_000)

  it('rejects ambiguous accounts, expired credentials and tampered encrypted keys without a venue', async () => {
    const f = await fixture()
    try {
      const id = await f.add(f.a, 642)
      await f.registry.start()
      await f.store.pool.query('INSERT INTO perpl_accounts(connection_id,account_id) VALUES($1,777)', [id])
      await expect(f.registry.forUser(f.a)).rejects.toThrow('PERPL_ACCOUNT_SELECTION_REQUIRED')
      await f.store.pool.query('DELETE FROM perpl_accounts WHERE connection_id=$1 AND account_id=777', [id])
      await f.store.pool.query("UPDATE perpl_connections SET sealed_private_key='tampered' WHERE id=$1", [id])
      await expect(f.registry.forUser(f.a)).rejects.toThrow('INVALID_SEALED_CREDENTIAL')
      await f.store.pool.query("UPDATE perpl_connections SET expires_at=now()-interval '1 second' WHERE id=$1", [id])
      expect(await f.registry.forUser(f.a)).toBeUndefined()
      expect(f.factory).not.toHaveBeenCalled()
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20_000)

  it('invalidates an already-returned venue before another submission after revocation', async () => {
    const f = await fixture()
    try {
      const id = await f.add(f.a, 642)
      await f.registry.start()
      const venue = await f.registry.forUser(f.a)
      await f.store.pool.query("UPDATE perpl_connections SET status='REVOKED' WHERE id=$1", [id])
      await expect(venue!.submit({ bookId: randomUUID() } as never)).rejects.toThrow('PERPL_CONNECTION_UNAVAILABLE')
      expect(f.created[0].submit).not.toHaveBeenCalled()
    } finally {
      await f.registry.close()
      await f.db.close()
    }
  }, 20_000)
})
