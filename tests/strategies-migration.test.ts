import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'

it('migration 030 re-runs, preserves rows and binds strategy orders to owner and account', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000030')
    const connection = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE')`,
      [connection, user],
    )
    const sql = await readFile('database/migrations/030_strategies.sql', 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    const strategy = randomUUID()
    await db.query(
      `INSERT INTO strategies(id,user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status)
      VALUES($1,$2,$3,'testnet',30,16,'PAPER','GRID',1000,'{}','{}','PAUSED')`,
      [strategy, user, connection],
    )
    const order = randomUUID()
    await db.query(
      `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,status,side,price,size)
      VALUES($1,$2,'testnet',30,16,'POST','UNKNOWN','BUY',99,0.1)`,
      [order, strategy],
    )
    await db.exec(sql)
    expect((await db.query('SELECT status FROM strategy_orders WHERE id=$1', [order])).rows[0].status).toBe('UNKNOWN')
    await expect(
      db.query(
        `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,status,side,price,size)
      VALUES($1,$2,'testnet',31,16,'POST','QUEUED','BUY',99,0.1)`,
        [randomUUID(), strategy],
      ),
    ).rejects.toThrow()
  } finally {
    await db.close()
  }
}, 30_000)
