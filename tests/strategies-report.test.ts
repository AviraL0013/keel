import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { buildStrategyRunReport } from '../server/src/infrastructure/strategies/report.js'

it('labels simulated fills and reports PnL, risk and observed uptime without inventing hashes', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000071')
    const connection = randomUUID(),
      strategy = randomUUID(),
      order = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE')`,
      [connection, user],
    )
    await db.query(
      `INSERT INTO strategies(id,user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status,created_at)
      VALUES($1,$2,$3,'testnet',642,16,'PAPER','GRID',1000,'{}','{}','STOPPED','2026-10-05T00:00:00Z')`,
      [strategy, user, connection],
    )
    await db.query(
      `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,simulated,status,side,price,size)
      VALUES($1,$2,'testnet',642,16,'POST',true,'FILLED','BUY',99,0.1)`,
      [order, strategy],
    )
    await db.query(
      `INSERT INTO strategy_fills(strategy_id,order_id,side,liquidity,price,size,fee,filled_at,simulated)
      VALUES($1,$2,'BUY','MAKER',99,0.1,0.01,'2026-10-05T00:30:00Z',true)`,
      [strategy, order],
    )
    await db.query(
      `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory) VALUES
      ($1,'2026-10-05T00:00:00Z',1000,0),($1,'2026-10-05T00:59:00Z',1001,0.1),($1,'2026-10-05T01:00:00Z',999,0)`,
      [strategy],
    )
    await db.query(
      `INSERT INTO strategy_tick_minutes(strategy_id,minute,first_tick,last_tick,tick_count)
      VALUES($1,'2026-10-05T00:30:00Z','2026-10-05T00:30:00Z','2026-10-05T00:30:59Z',2)`,
      [strategy],
    )
    await db.query(
      `INSERT INTO strategy_risk_events(strategy_id,code,observed_at)
      VALUES($1,'VOLATILITY','2026-10-05T00:45:00Z')`,
      [strategy],
    )
    const report = await buildStrategyRunReport(store.pool, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', strategy)
    expect(report.strategies[0]).toMatchObject({
      mode: 'PAPER',
      pnl: 1,
      observedMinuteCoverage: 1 / 60,
      transactionHashes: [],
    })
    expect(report.strategies[0]!.fills[0]).toMatchObject({ simulated: true, transactionHash: null })
    expect(report.strategies[0]!.riskEvents[0]).toMatchObject({ code: 'VOLATILITY' })
  } finally {
    await db.close()
  }
}, 30_000)
