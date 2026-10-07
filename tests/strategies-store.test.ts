import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { StrategyStore } from '../server/src/infrastructure/strategies/store.js'
import type { StrategyConfig } from '../packages/strategies/src/index.js'

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
  grid: { lower: 90, upper: 110, levels: 3 },
}

it('stores owner-bound strategy state and enforces kill switch before start', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000064')
    const other = await store.ensureUser('0x0000000000000000000000000000000000000065')
    const connection = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE',now()+interval '1 hour')`,
      [connection, user],
    )
    await db.query(
      `INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen)
      VALUES($1,642,true,false)`,
      [connection],
    )
    await db.query(
      `INSERT INTO perpl_account_owners(environment,account_id,user_id)
      VALUES('testnet',642,$1)`,
      [user],
    )
    const repo = new StrategyStore(store.pool, 'testnet')
    const created = await repo.create(user, connection, config)
    expect(created.status).toBe('PAUSED')
    expect(await repo.get(other, created.id)).toBeNull()
    await repo.kill(user)
    await expect(repo.start(user, created.id)).rejects.toThrow('STRATEGY_KILL_SWITCH')
    await repo.resetKill(user)
    expect((await repo.start(user, created.id)).status).toBe('RUNNING')
    expect((await repo.stop(user, created.id)).status).toBe('STOPPED')
    await expect(repo.create(other, connection, config)).rejects.toThrow('STRATEGY_CONNECTION_UNAVAILABLE')
  } finally {
    await db.close()
  }
}, 30_000)
