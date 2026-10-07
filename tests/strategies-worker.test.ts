import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { StrategyStore } from '../server/src/infrastructure/strategies/store.js'
import { StrategyWorker } from '../server/src/workers/strategy-worker.js'
import type { StrategyConfig, StrategyTick } from '../packages/strategies/src/index.js'

const config: StrategyConfig = {
  kind: 'GRID',
  mode: 'PAPER',
  marketId: 16,
  accountId: 642,
  capital: 1000,
  quoteSize: 0.1,
  maxNotional: 500,
  maxInventory: 0.3,
  maxOpenOrders: 4,
  maxDailyLoss: 50,
  maxDrawdownPct: 5,
  maxVolatility: 0.1,
  maxDataAgeMs: 2000,
  maxPriceBandBps: 100,
  maxFundingRate: 0.001,
  leverage: 1,
  grid: { lower: 99, upper: 101, levels: 3 },
}

it('paper worker persists simulated fills, then halts and clears quotes on kill', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000066')
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
    const created = await repo.create(user, connection, config)
    await repo.start(user, created.id)
    let now = Date.now()
    const tick = (mark: number, bid: number, ask: number): StrategyTick => ({
      at: now,
      mark,
      oracle: mark,
      bid,
      ask,
      volatility: 0.01,
      fundingRate: 0,
    })
    let sample = { tick: tick(100, 99, 101), makerFeeMicros: 1000, depthNotional: 10000 }
    const worker = new StrategyWorker(
      repo,
      { sample: async () => sample },
      () => now,
      () => false,
    )
    await worker.tick()
    expect((await repo.get(user, created.id))!.state.openOrders.length).toBe(2)
    expect((await repo.orders(user, created.id)).every((row) => row.simulated === true)).toBe(true)
    now += 1000
    sample = { tick: tick(101.5, 101.2, 101.8), makerFeeMicros: 1000, depthNotional: 10000 }
    await worker.tick()
    expect(await repo.fills(user, created.id)).toHaveLength(1)
    expect((await repo.fills(user, created.id))[0]?.simulated).toBe(true)
    await worker.close()
    expect((await repo.get(user, created.id))!.state.openOrders).toEqual([])
    expect((await repo.orders(user, created.id)).some((row) => row.status === 'OPEN')).toBe(false)
    await worker.tick()
    expect((await repo.get(user, created.id))!.state.openOrders.length).toBeGreaterThan(0)
    await repo.kill(user)
    await worker.tick()
    expect((await repo.get(user, created.id))!.status).toBe('HALTED')
    expect((await repo.orders(user, created.id)).some((row) => row.status === 'OPEN')).toBe(false)
  } finally {
    await db.close()
  }
}, 30_000)
