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

it('rebuilds order state from venue snapshot after restart without any resubmission', async () => {
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
    expect((await repo.orders(user, strategy.id))[0]).toMatchObject({ status: 'OPEN', venue_order_id: 75 })
    snapshot = []
    history = [order(5)]
    await recovery.recover()
    expect((await repo.orders(user, strategy.id))[0].status).toBe('CANCELED')
    expect(submissions).toBe(0)
  } finally {
    await db.close()
  }
}, 30_000)
