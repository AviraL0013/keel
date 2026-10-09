import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { StrategyStore } from '../server/src/infrastructure/strategies/store.js'
import { StrategyOrderRecovery } from '../server/src/infrastructure/strategies/order-recovery.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { StrategyConfig } from '../packages/strategies/src/index.js'
import type { WireOrder } from '../packages/perpl/src/decoder.js'

const config: StrategyConfig = {
  kind: 'GRID',
  mode: 'PAPER',
  marketId: 16,
  accountId: 642,
  capital: 100,
  quoteSize: 0.1,
  maxNotional: 100,
  maxInventory: 0.2,
  maxOpenOrders: 2,
  maxDailyLoss: 5,
  maxDrawdownPct: 5,
  maxVolatility: 0.1,
  maxDataAgeMs: 2000,
  maxPriceBandBps: 100,
  maxFundingRate: 0.001,
  leverage: 1,
  grid: { lower: 99, upper: 101, levels: 3 },
}

it('reconciles beyond the first 100 unresolved orders without starving later requests', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000074')
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
      `INSERT INTO strategy_orders(strategy_id,environment,account_id,market_id,kind,status,side,price,size,request_id,created_at)
      SELECT $1,'testnet',642,16,'POST','UNKNOWN','BUY',99,1,n,to_timestamp(n) FROM generate_series(1,101) n`,
      [strategy],
    )
    const seen = new Set<string>()
    const scoped = {
      accountId: 642,
      strategyOrderEvidence: async (intent: { requestId: string }) => {
        seen.add(intent.requestId)
        return { snapshotReady: false, snapshot: [], history: [] }
      },
    } as unknown as RuntimeVenue
    const venue = { forUser: async () => scoped } as unknown as RuntimeVenue
    const recovery = new StrategyOrderRecovery(store.pool, venue, 'testnet')
    await recovery.recover()
    expect(seen.size).toBe(0) // Legacy rows lack immutable command metadata.
    expect(
      (await db.query("SELECT count(*)::int AS n FROM strategy_orders WHERE error='STRATEGY_INTENT_UNVERIFIED'"))
        .rows[0].n,
    ).toBe(100)
    await recovery.recover()
    expect(
      (await db.query("SELECT count(*)::int AS n FROM strategy_orders WHERE error='STRATEGY_INTENT_UNVERIFIED'"))
        .rows[0].n,
    ).toBe(101)
  } finally {
    await db.close()
  }
}, 30_000)

it('keeps legacy snapshot-only state unverified after restart without any resubmission', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000069')
    const connection = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE',now()+interval '1 hour')`,
      [connection, user],
    )
    await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
      connection,
    ])
    await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',642,$1)", [user])
    const repo = new StrategyStore(store.pool, 'testnet')
    const strategy = await repo.create(user, connection, config)
    const id = randomUUID()
    await db.query(
      `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,status,side,price,size,request_id)
      VALUES($1,$2,'testnet',642,16,'POST','UNKNOWN','BUY',99,0.1,45)`,
      [id, strategy.id],
    )
    const order = (st: number): WireOrder => ({
      acc: 642,
      mkt: 16,
      oid: 75,
      rq: '45',
      st,
      sr: 0,
      t: 1,
      os: 10,
      fs: 0,
      at: { b: 101, t: 1000 },
    })
    let snapshot = [order(2)]
    let history: WireOrder[] = []
    let submissions = 0
    const scoped = {
      accountId: 642,
      ready: () => true,
      close: async () => {},
      refresh: async () => {},
      submit: async () => {
        submissions++
        throw new Error('RESUBMITTED')
      },
      reconcile: async (action: never) => action,
      strategyOrderEvidence: async () => ({ snapshotReady: true, snapshot, history }),
    } as RuntimeVenue
    const venue = { ...scoped, forUser: async () => scoped } as RuntimeVenue
    const recovery = new StrategyOrderRecovery(store.pool, venue, 'testnet')
    await recovery.recover()
    expect((await repo.orders(user, strategy.id))[0]).toMatchObject({
      status: 'UNKNOWN',
      error: 'STRATEGY_INTENT_UNVERIFIED',
    })
    snapshot = []
    history = [order(5)]
    await recovery.recover()
    expect((await repo.orders(user, strategy.id))[0].status).toBe('UNKNOWN')
    expect(submissions).toBe(0)
  } finally {
    await db.close()
  }
}, 30_000)
