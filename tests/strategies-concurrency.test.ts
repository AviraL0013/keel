import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { DevelopmentKeyCustody } from '../server/src/infrastructure/perpl/key-custody.js'
import { PerplUserVenues } from '../server/src/infrastructure/perpl/user-venues.js'
import { PerplRequestIdAllocator } from '../server/src/infrastructure/perpl/request-id-allocator.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { Action } from '../packages/domain/src/index.js'

it('repairs the shared request counter from real strategy orders and ignores simulated IDs', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000073')
    const connection = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE',now()+interval '1 hour')`,
      [connection, user],
    )
    const strategy = (
      await db.query(
        `INSERT INTO strategies(user_id,connection_id,environment,account_id,market_id,
      mode,kind,capital,config,state,status) VALUES($1,$2,'testnet',642,16,'PAPER','GRID',100,'{}','{}','PAUSED') RETURNING id`,
        [user, connection],
      )
    ).rows[0].id
    await db.query(
      `INSERT INTO strategy_orders(strategy_id,environment,account_id,market_id,kind,simulated,status,side,price,size,request_id)
      VALUES($1,'testnet',642,16,'POST',false,'UNKNOWN','BUY',99,1,101),
            ($1,'testnet',642,16,'POST',true,'OPEN','BUY',99,1,999)`,
      [strategy],
    )
    const allocator = new PerplRequestIdAllocator(store.pool)
    expect(await allocator.allocate(642, '100')).toBe('102')
    await db.query('DELETE FROM perpl_request_ids WHERE account_id=642')
    expect(await allocator.allocate(642, '100')).toBe('102')
  } finally {
    await db.close()
  }
}, 30_000)

it('serializes a strategy post after a Book action on one account and never reuses request IDs', async () => {
  const { db, store } = await databaseFixture()
  const custody = new DevelopmentKeyCustody('12'.repeat(32))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000072')
    const connection = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,wallet_address,scope_mask,expires_at,sealed_private_key,sealed_api_token)
      SELECT $1::uuid,id,'testnet','trade',$1::text,'ACTIVE',wallet_address,3,now()+interval '1 day',$3,$4
      FROM users WHERE id=$2`,
      [
        connection,
        user,
        custody.seal('11'.repeat(32), `${connection}:private_key`),
        custody.seal('test-token', `${connection}:api_token`),
      ],
    )
    await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
      connection,
    ])
    const bookId = (
      await db.query(
        `INSERT INTO books(user_id,market,market_id,venue_account_id,venue_position_id,side,stance,liquidation_floor,defense_cap,time_limit_ms,perpl_connection_id)
      VALUES($1,'BTC',16,642,7,'LONG','DEFEND',5,5,1000,$2) RETURNING id`,
        [user, connection],
      )
    ).rows[0].id
    const allocator = new PerplRequestIdAllocator(store.pool)
    const sent: string[] = []
    const rawSubmit = vi.fn(async () => {
      await held
      const id = await allocator.allocate(642, '44')
      sent.push(id)
      return { venueReference: `642:${id}`, status: 'SUBMITTED' as const }
    })
    const rawStrategy = vi.fn(
      async (_intentId: string, _order: unknown, beforeSend: (reference: string, lb: number) => Promise<void>) => {
        const id = await allocator.allocate(642, '44')
        sent.push(id)
        await beforeSend(`642:${id}`, 120)
        return { venueReference: `642:${id}`, status: 'SUBMITTED' as const }
      },
    )
    const raw: RuntimeVenue = {
      accountId: 642,
      ready: () => true,
      start: async () => {},
      close: async () => {},
      refresh: async () => {},
      submit: rawSubmit,
      submitStrategy: rawStrategy,
      reconcile: async (action) => action,
    }
    const registry = new PerplUserVenues(store, 'testnet', custody, async () => raw)
    await registry.start()
    const scoped = (await registry.forUser(user, connection))!
    const book = scoped.submit({ id: randomUUID(), bookId } as Action)
    await vi.waitFor(() => expect(rawSubmit).toHaveBeenCalledOnce())
    const strategy = scoped.submitStrategy!(
      'strategy-post',
      { acc: 642, mkt: 16, t: 1, p: 99, s: 1, lv: 100, fl: 1, orderTtlBlocks: 20 },
      async () => {},
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(rawStrategy).not.toHaveBeenCalled()
    release()
    await Promise.all([book, strategy])
    expect(sent).toEqual(['45', '46'])
    await registry.close()
  } finally {
    release?.()
    await db.close()
  }
}, 30_000)
