import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { StrategyCapital } from '../server/src/infrastructure/strategies/capital.js'
import { strategyIntentHash } from '../packages/strategies/src/order-intent.js'
import { withAccountCapital, assertAccountCapitalCoverage } from '../server/src/infrastructure/capital/admission.js'

async function fixture() {
  const { db, store } = await databaseFixture()
  const user = await store.ensureUser('0x00000000000000000000000000000000000000aa'),
    connection = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
    VALUES($1,$2,'testnet','trade','fake','ACTIVE',now()+interval '1 day')`,
    [connection, user],
  )
  await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
    connection,
  ])
  await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',642,$1)", [user])
  const strategy = (
    await db.query<{ id: string }>(
      `INSERT INTO strategies(user_id,connection_id,environment,account_id,
    market_id,mode,kind,capital,config,state,status) VALUES($1,$2,'testnet',642,16,'LIVE','GRID',40,'{}','{}','PAUSED') RETURNING id`,
      [user, connection],
    )
  ).rows[0].id
  const book = (
    await db.query<{ id: string }>(
      `INSERT INTO books(user_id,market,market_id,venue_account_id,perpl_connection_id,
    side,stance,liquidation_floor,defense_cap,time_limit_ms,status)
    VALUES($1,'BTC',16,642,$2,'LONG','DEFEND',5,60,60000,'PAUSED') RETURNING id`,
      [user, connection],
    )
  ).rows[0].id
  await db.query('INSERT INTO reserves(book_id,available,reserved,deployed,cap) VALUES($1,20,40,0,60)', [book])
  const balance = {
    environment: 'testnet' as const,
    accountId: 642,
    free: '100.000000',
    observedAt: Date.now(),
    observedBlock: 120,
  }
  const readBalance = vi.fn(async () => ({ ...balance, observedAt: Date.now() }))
  const cost = vi.fn(async () => ({ required: '10.000001', balance: await readBalance() }))
  const service = () => new StrategyCapital(store.pool, 'testnet', readBalance, cost)
  const wire = { acc: 642, mkt: 16, t: 1, p: 990, s: 100, lv: 100, fl: 1 as const, orderTtlBlocks: 20 }
  const terms = { priceDecimals: 1, sizeDecimals: 3, contractMarketId: 16 }
  const order = async () =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO strategy_orders(strategy_id,environment,account_id,
    market_id,kind,simulated,status,side,price,size,idempotency_key,wire_order,market_terms,payload_hash)
    VALUES($1,'testnet',642,16,'POST',false,'QUEUED','BUY',99,0.1,$2,$3,$4,$5) RETURNING id`,
        [strategy, randomUUID(), JSON.stringify(wire), JSON.stringify(terms), strategyIntentHash(wire, terms, null)],
      )
    ).rows[0].id
  return { db, store, user, connection, strategy, book, balance, readBalance, cost, service, order }
}

it('allocates once under the account lock and preserves Book reserves at one-micro boundary', async () => {
  const f = await fixture()
  try {
    f.balance.free = '99.999999'
    await expect(f.service().allocate(f.user, f.strategy)).rejects.toThrow('STRATEGY_WOULD_UNDERFUND_BOOK_RESERVES')
    expect((await f.db.query('SELECT * FROM strategy_capital_allocations')).rows).toHaveLength(0)
    f.balance.free = '100.000000'
    expect(await f.service().allocate(f.user, f.strategy)).toMatchObject({
      amount: '40.000000',
      available: '40.000000',
    })
    await f.service().allocate(f.user, f.strategy)
    expect((await f.db.query('SELECT * FROM strategy_capital_allocations')).rows).toHaveLength(1)
    expect(
      (await f.db.query('SELECT available::text,reserved::text FROM reserves WHERE book_id=$1', [f.book])).rows[0],
    ).toEqual({ available: '20', reserved: '40' })
  } finally {
    await f.db.close()
  }
}, 30000)

it('reserves only its own allocation, is idempotent across restart and rejects changed costs', async () => {
  const f = await fixture()
  try {
    await f.service().allocate(f.user, f.strategy)
    const id = await f.order()
    await f.service().reserve(f.user, f.strategy, id)
    await f.service().reserve(f.user, f.strategy, id)
    f.readBalance.mockImplementationOnce(async () => ({ ...f.balance, observedAt: Date.now() - 20000 }))
    await expect(f.service().reserve(f.user, f.strategy, id)).rejects.toThrow('PERPL_FREE_BALANCE_UNAVAILABLE')
    expect(
      (await f.db.query('SELECT available::text,reserved::text FROM strategy_capital_allocations')).rows[0],
    ).toEqual({ available: '29.999999', reserved: '10.000001' })
    f.cost.mockImplementation(async () => ({
      required: '10.000002',
      balance: { ...f.balance, observedAt: Date.now() },
    }))
    await expect(f.service().reserve(f.user, f.strategy, id)).rejects.toThrow('STRATEGY_RESERVATION_CONFLICT')
    const next = await f.order()
    f.cost.mockImplementation(async () => ({
      required: '30.000000',
      balance: { ...f.balance, observedAt: Date.now() },
    }))
    await expect(f.service().reserve(f.user, f.strategy, next)).rejects.toThrow('STRATEGY_ALLOCATION_INSUFFICIENT')
    expect((await f.db.query('SELECT * FROM strategy_capital_reservations')).rows).toHaveLength(1)
  } finally {
    await f.db.close()
  }
}, 30000)

it('reports legacy idle claims and refuses to pretend missing allocations were released', async () => {
  const f = await fixture()
  try {
    await f.db.query("UPDATE strategies SET status='STOPPED' WHERE id=$1", [f.strategy])
    expect(await f.service().leaks(f.user)).toMatchObject([
      { strategyId: f.strategy, code: 'STRATEGY_IDLE_CAPITAL_HELD' },
    ])
    await expect(f.service().releaseIdle(f.user, f.strategy)).rejects.toThrow('STRATEGY_CAPITAL_ALLOCATION_MISSING')
    expect((await f.db.query('SELECT * FROM strategy_capital_allocations')).rows).toHaveLength(0)
  } finally {
    await f.db.close()
  }
}, 30000)

it('refuses stale, foreign and unavailable balances and other-user allocation access', async () => {
  const f = await fixture()
  try {
    await expect(f.service().allocate(randomUUID(), f.strategy)).rejects.toThrow('STRATEGY_NOT_FOUND')
    f.readBalance.mockImplementation(async () => ({ ...f.balance, observedAt: Date.now() - 20000 }))
    await expect(f.service().allocate(f.user, f.strategy)).rejects.toThrow('PERPL_FREE_BALANCE_UNAVAILABLE')
    f.readBalance.mockImplementation(async () => ({ ...f.balance, accountId: 999, observedAt: Date.now() }))
    await expect(f.service().allocate(f.user, f.strategy)).rejects.toThrow('PERPL_FREE_BALANCE_UNAVAILABLE')
    f.readBalance.mockRejectedValue(Error('FAKE_BALANCE_UNAVAILABLE'))
    await expect(f.service().allocate(f.user, f.strategy)).rejects.toThrow('FAKE_BALANCE_UNAVAILABLE')
    expect((await f.db.query('SELECT * FROM strategy_capital_allocations')).rows).toHaveLength(0)
  } finally {
    await f.db.close()
  }
}, 30000)

it('releases idle stopped capital atomically, invalidates never-sent intents and lets Books use only released capital', async () => {
  const f = await fixture()
  try {
    await f.service().allocate(f.user, f.strategy)
    const id = await f.order()
    await f.service().reserve(f.user, f.strategy, id)
    await f.db.query("UPDATE strategies SET status='STOPPED' WHERE id=$1", [f.strategy])
    expect(await f.service().leaks(f.user)).toMatchObject([
      { strategyId: f.strategy, code: 'STRATEGY_IDLE_CAPITAL_HELD' },
    ])
    await f.service().releaseIdle(f.user, f.strategy)
    expect((await f.db.query('SELECT status,error FROM strategy_orders WHERE id=$1', [id])).rows[0]).toEqual({
      status: 'FAILED',
      error: 'STRATEGY_CAPITAL_RELEASED_BEFORE_SEND',
    })
    expect(
      (await f.db.query('SELECT status,available::text,reserved::text FROM strategy_capital_allocations')).rows[0],
    ).toEqual({ status: 'RELEASED', available: '0.000000', reserved: '0.000000' })
    await expect(
      withAccountCapital(
        f.store.pool,
        { userId: f.user, connectionId: f.connection, accountId: 642, environment: 'testnet' },
        async (client, binding) =>
          assertAccountCapitalCoverage(client, binding, { ...f.balance, observedAt: Date.now() }, '40.000000'),
      ),
    ).resolves.toBe('0.000000')
    expect(await f.service().leaks(f.user)).toEqual([])
  } finally {
    await f.db.close()
  }
}, 30000)

it('never releases transmitted or ambiguous exposure, and reruns migration033 safely', async () => {
  const f = await fixture()
  try {
    await f.service().allocate(f.user, f.strategy)
    const id = await f.order()
    await f.service().reserve(f.user, f.strategy, id)
    await f.db.query("UPDATE strategy_orders SET status='UNKNOWN',request_id=45,last_execution_block=130 WHERE id=$1", [
      id,
    ])
    await f.db.query("UPDATE strategies SET status='HALTED' WHERE id=$1", [f.strategy])
    await expect(f.service().releaseIdle(f.user, f.strategy)).rejects.toThrow('STRATEGY_CAPITAL_EXPOSURE_UNRESOLVED')
    const sql = await readFile('database/migrations/033_strategy_capital.sql', 'utf8')
    await f.db.exec(sql)
    await f.db.exec(sql)
    expect(
      (await f.db.query('SELECT available::text,reserved::text FROM strategy_capital_allocations')).rows[0],
    ).toEqual({ available: '29.999999', reserved: '10.000001' })
  } finally {
    await f.db.close()
  }
}, 30000)
