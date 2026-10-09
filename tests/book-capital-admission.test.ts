import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { BooksApplication, type BookSetup } from '../server/src/application/books.js'
import type { VenuePort } from '../server/src/application/ports.js'
import { databaseFixture } from './helpers/database.js'
import { DevelopmentKeyCustody } from '../server/src/infrastructure/perpl/key-custody.js'
import { PerplUserVenues } from '../server/src/infrastructure/perpl/user-venues.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import { settleDefense } from '../server/src/reserveSettlement.js'

async function fixture() {
  const f = await databaseFixture()
  const user = await f.store.ensureUser('capital-admission-owner')
  const connection = randomUUID()
  await f.db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
     VALUES($1,$2,'testnet','trade','fake','ACTIVE',now()+interval '1 day')`,
    [connection, user],
  )
  await f.db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
    connection,
  ])
  await f.db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',642,$1)", [user])
  const at = Date.now()
  const setup: BookSetup = {
    market: 'BTC',
    reserveAvailable: 100,
    position: {
      side: 'LONG',
      size: 1,
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: 90,
      leverage: 5,
      unrealizedPnl: 0,
      margin: 20,
      status: 'OPEN',
      timestamp: at,
    },
    telemetry: {
      mark: 100,
      oracle: 100,
      bid: 99.9,
      ask: 100.1,
      mid: 100,
      spreadBps: 20,
      fundingRate: 0,
      depthNotional: 10000,
      volatility: 0.01,
      volume24h: 0,
      openInterest: 0,
      block: 1,
      timestamp: at,
      source: 'replay',
    },
  }
  const balance = {
    environment: 'testnet' as const,
    accountId: 642,
    free: '100.000000',
    observedAt: Date.now(),
    observedBlock: 109,
  }
  const venue = {
    connectionId: connection,
    loadBookSetup: async () => ({
      ...setup,
      capital: { ...balance, observedAt: Date.now() },
    }),
  }
  const directory = { ...venue, forUser: async () => venue } as unknown as VenuePort & {
    loadBookSetup: () => Promise<BookSetup>
  }
  const app = new BooksApplication(f.store, directory)
  let position = 1
  const command = (reserve: number) => ({
    market: 'BTC',
    marketId: 16,
    venueAccountId: 642,
    venuePositionId: position++,
    side: 'LONG' as const,
    stance: 'DEFEND' as const,
    liquidationFloor: 6,
    defenseCap: Math.min(reserve, 1),
    timeLimitMs: 3600000,
    automationEnabled: false,
    reserveAvailable: reserve,
  })
  const create = (reserve: number) => app.create(user, command(reserve))
  return { ...f, user, connection, setup, venue, balance, command, app, create }
}

it('refuses duplicate Book promises and preserves the exact six-decimal boundary without leaked rows', async () => {
  const f = await fixture()
  try {
    await f.create(60)
    await expect(f.create(50)).rejects.toThrow('ACCOUNT_CAPITAL_INSUFFICIENT')
    expect(await f.store.listBooks(f.user)).toHaveLength(1)
    expect((await f.db.query('SELECT * FROM reserves')).rows).toHaveLength(1)
    expect((await f.db.query('SELECT * FROM reserve_ledger_entries')).rows).toHaveLength(1)
    await f.create(40)
    await expect(f.create(0.000001)).rejects.toThrow('ACCOUNT_CAPITAL_INSUFFICIENT')
    expect(await f.store.listBooks(f.user)).toHaveLength(2)
  } finally {
    await f.db.close()
  }
}, 30_000)

it('keeps paused, safe-mode and reserved Book claims, and releases an idle closed Book', async () => {
  const f = await fixture()
  try {
    const book = await f.create(60)
    for (const status of ['PAUSED', 'SAFE_MODE']) {
      await f.db.query('UPDATE books SET status=$2 WHERE id=$1', [book.id, status])
      await expect(f.create(50)).rejects.toThrow('ACCOUNT_CAPITAL_INSUFFICIENT')
    }
    await f.db.query('UPDATE reserves SET available=20,reserved=40 WHERE book_id=$1', [book.id])
    await expect(f.create(50)).rejects.toThrow('ACCOUNT_CAPITAL_INSUFFICIENT')
    await f.db.query("UPDATE books SET status='CLOSED' WHERE id=$1", [book.id])
    await expect(f.create(90)).resolves.toBeDefined()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('retains old connection claims after key rotation and refuses foreign or missing account ownership', async () => {
  const f = await fixture()
  try {
    await f.create(60)
    await f.db.query("UPDATE perpl_connections SET status='EXPIRED' WHERE id=$1", [f.connection])
    const replacement = randomUUID()
    await f.db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
      VALUES($1,$2,'testnet','trade','fake','ACTIVE',now()+interval '1 day')`,
      [replacement, f.user],
    )
    await f.db.query(
      'INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)',
      [replacement],
    )
    f.venue.connectionId = replacement
    await expect(f.create(50)).rejects.toThrow('ACCOUNT_CAPITAL_INSUFFICIENT')
    const other = await f.store.ensureUser('foreign-capital-owner')
    await f.db.query('UPDATE perpl_account_owners SET user_id=$1', [other])
    await expect(f.create(1)).rejects.toThrow('ACCOUNT_CAPITAL_BINDING_UNAVAILABLE')
    await f.db.query('DELETE FROM perpl_account_owners')
    await expect(f.create(1)).rejects.toThrow('ACCOUNT_CAPITAL_BINDING_UNAVAILABLE')
    expect(await f.store.listBooks(f.user)).toHaveLength(1)
  } finally {
    await f.db.close()
  }
}, 30_000)

it('refuses unavailable balance blocks and rolls back every row after a mid-write fault', async () => {
  const f = await fixture(),
    connect = f.store.pool.connect.bind(f.store.pool)
  try {
    f.balance.observedBlock = 0
    await expect(f.create(60)).rejects.toThrow('PERPL_FREE_BALANCE_UNAVAILABLE')
    f.balance.observedBlock = 100
    vi.spyOn(f.store.pool, 'connect').mockImplementation(async () => {
      const client = await connect()
      return {
        ...client,
        query: async (sql: string, values?: unknown[]) => {
          if (sql.startsWith('INSERT INTO reserve_ledger_entries')) throw new Error('FAKE_LEDGER_WRITE_FAILURE')
          return client.query(sql, values)
        },
      } as never
    })
    await expect(f.create(60)).rejects.toThrow('FAKE_LEDGER_WRITE_FAILURE')
    expect(await f.store.listBooks(f.user)).toHaveLength(0)
    expect((await f.db.query('SELECT * FROM reserves')).rows).toHaveLength(0)
    expect((await f.db.query('SELECT * FROM positions')).rows).toHaveLength(0)
  } finally {
    vi.restoreAllMocks()
    await f.db.close()
  }
}, 30_000)

it('reloads the actual guarded venue using the transaction client when the pool has no spare capacity', async () => {
  const f = await fixture()
  const custody = new DevelopmentKeyCustody('12'.repeat(32))
  const registry = new PerplUserVenues(
    f.store,
    'testnet',
    custody,
    async () =>
      ({
        ...f.venue,
        accountId: 642,
        ready: () => true,
        refresh: async () => {},
        close: async () => {},
        submit: async () => {
          throw new Error('NO_ORDER_ALLOWED')
        },
        reconcile: async (action) => action,
      }) as RuntimeVenue,
  )
  try {
    await f.db.query(
      `UPDATE perpl_connections SET wallet_address=(SELECT wallet_address FROM users WHERE id=$2),
      scope_mask=3,sealed_private_key=$3,sealed_api_token=$4 WHERE id=$1`,
      [
        f.connection,
        f.user,
        custody.seal('11'.repeat(32), `${f.connection}:private_key`),
        custody.seal('fixture-only', `${f.connection}:api_token`),
      ],
    )
    await registry.start()
    await registry.forUser(f.user)
    let checkedOut = false
    const query = f.store.pool.query.bind(f.store.pool)
    const connect = f.store.pool.connect.bind(f.store.pool)
    vi.spyOn(f.store.pool, 'query').mockImplementation(((sql: string, values?: unknown[]) => {
      if (checkedOut) throw new Error('NESTED_POOL_CHECKOUT_DEADLOCK')
      return query(sql, values)
    }) as typeof f.store.pool.query)
    vi.spyOn(f.store.pool, 'connect').mockImplementation(async () => {
      const client = await connect()
      checkedOut = true
      return {
        ...client,
        release: () => {
          checkedOut = false
          client.release()
        },
      } as never
    })
    await expect(new BooksApplication(f.store, registry).create(f.user, f.command(60))).resolves.toMatchObject({
      venueAccountId: 642,
    })
  } finally {
    vi.restoreAllMocks()
    await registry.close()
    await f.db.close()
  }
}, 30_000)

it('keeps a confirmed opening claim until the wallet block covers its verified fills', async () => {
  const f = await fixture()
  try {
    const preview = randomUUID(),
      txHash = `0x${'a'.repeat(64)}`
    await f.db.query(
      `INSERT INTO opening_previews(id,user_id,connection_id,environment,account_id,market_id,parameters,parameter_hash,quote,expires_at)
      VALUES($1,$2,$3,'testnet',642,16,'{}','fixture','{}',now()+interval '1 day')`,
      [preview, f.user, f.connection],
    )
    await f.db.query(
      `INSERT INTO opening_orders(user_id,connection_id,environment,account_id,market_id,side,size,price_limit,leverage,collateral,fees,preview_id,idempotency_key,status,request_id,tx_hash,evidence,resolved_at)
      VALUES($1,$2,'testnet',642,16,'LONG',0.1,100,5,20,0,$3,$4,'CONFIRMED',45,$5,$6,now()-interval '1 minute')`,
      [
        f.user,
        f.connection,
        preview,
        randomUUID(),
        txHash,
        JSON.stringify({
          operations: [{ requestId: '45', block: 110, txHash, type: 1, marketId: 16 }],
          fills: [{ acc: 642, mkt: 16, at: { b: 110 } }],
        }),
      ],
    )
    await expect(f.create(90)).rejects.toThrow('ACCOUNT_CAPITAL_INSUFFICIENT')
    f.balance.observedBlock = 110
    await expect(f.create(90)).resolves.toBeDefined()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('fences receipt-backed superseded failures until their spend is reflected, but releases a pre-send failure', async () => {
  const f = await fixture()
  try {
    const preview = randomUUID(),
      txHash = `0x${'b'.repeat(64)}`
    await f.db.query(
      `INSERT INTO opening_previews(id,user_id,connection_id,environment,account_id,market_id,parameters,parameter_hash,quote,expires_at)
      VALUES($1,$2,$3,'testnet',642,16,'{}','fixture','{}',now()+interval '1 day')`,
      [preview, f.user, f.connection],
    )
    const failed = (
      await f.db.query<{ id: string }>(
        `INSERT INTO opening_orders(user_id,connection_id,environment,account_id,market_id,side,size,price_limit,leverage,collateral,fees,preview_id,idempotency_key,status,request_id,error)
      VALUES($1,$2,'testnet',642,16,'LONG',0.1,100,5,20,0,$3,$4,'FAILED',45,'PREVIEW_STALE') RETURNING id`,
        [f.user, f.connection, preview, randomUUID()],
      )
    ).rows[0].id
    const book = await f.create(90)
    await f.db.query("UPDATE books SET status='CLOSED' WHERE id=$1", [book.id])
    await f.db.query("UPDATE opening_orders SET error='PERPL_REQUEST_ID_SUPERSEDED',evidence=$2 WHERE id=$1", [
      failed,
      JSON.stringify({ operations: [{ requestId: '45', marketId: 17, type: 2, block: 110, txHash }], fills: [] }),
    ])
    // A superseded payload may spend more than the old intent's collateral.
    // Even a small admission waits for the independently verified wallet block.
    await expect(f.create(1)).rejects.toThrow('PERPL_FREE_BALANCE_UNAVAILABLE')
    expect(await f.store.listBooks(f.user)).toHaveLength(1)
    f.balance.observedBlock = 110
    await expect(f.create(90)).resolves.toBeDefined()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('keeps settled DEFEND spend until its verified block is covered and retains missing legacy proof', async () => {
  const f = await fixture()
  try {
    const book = await f.create(60)
    await f.db.query('UPDATE books SET defense_cap=20 WHERE id=$1', [book.id])
    const decision = (
      await f.db.query<{ id: string }>(
        `INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features)
      VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id`,
        [book.id],
      )
    ).rows[0].id
    const action = (
      await f.db.query<{ id: string }>(
        `INSERT INTO actions(book_id,decision_id,kind,amount,status,idempotency_key)
      VALUES($1,$2,'DEFEND',20,'CONFIRMED',$3) RETURNING id`,
        [book.id, decision, randomUUID()],
      )
    ).rows[0].id
    await f.db.transaction((tx) => settleDefense(tx, book.id, 20, action, decision))
    await expect(f.create(50)).rejects.toThrow('ACCOUNT_CAPITAL_INSUFFICIENT')
    await f.db.query(`UPDATE actions SET venue_progress='{"confirmedExecutionBlock":110}' WHERE id=$1`, [action])
    await expect(f.create(50)).rejects.toThrow('ACCOUNT_CAPITAL_INSUFFICIENT')
    f.balance.observedBlock = 110
    await expect(f.create(50)).resolves.toBeDefined()
  } finally {
    await f.db.close()
  }
}, 30_000)
