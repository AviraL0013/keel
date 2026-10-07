import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'

it('migration 031 reruns without losing legacy rows and binds cancel targets to their strategy', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000031')
    const connection = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE')`,
      [connection, user],
    )
    const strategies: string[] = []
    for (let n = 0; n < 2; n++) {
      strategies.push(
        (
          await db.query(
            `INSERT INTO strategies(user_id,connection_id,environment,account_id,market_id,
        mode,kind,capital,config,state,status) VALUES($1,$2,'testnet',642,16,'LIVE','GRID',100,'{}','{}','PAUSED')
        RETURNING id`,
            [user, connection],
          )
        ).rows[0].id as string,
      )
    }
    const legacy = randomUUID()
    await db.query(
      `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,status,side,price,size)
      VALUES($1,$2,'testnet',642,16,'POST','UNKNOWN','BUY',99,1)`,
      [legacy, strategies[0]],
    )
    const sql = await readFile('database/migrations/031_strategy_order_intents.sql', 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    expect((await db.query('SELECT status FROM strategy_orders WHERE id=$1', [legacy])).rows[0].status).toBe('UNKNOWN')
    const key = randomUUID()
    const values = [strategies[0], key, 'a'.repeat(64)]
    const insert = `INSERT INTO strategy_orders(strategy_id,environment,account_id,market_id,kind,status,side,price,size,
      idempotency_key,wire_order,payload_hash,market_terms) VALUES($1,'testnet',642,16,'POST','QUEUED','BUY',99,1,$2,'{}',$3,'{}')`
    await db.query(insert, values)
    await expect(db.query(insert, values)).rejects.toThrow()
    await expect(db.query(insert, [strategies[0], randomUUID(), null])).rejects.toThrow()
    await expect(
      db.query(
        `INSERT INTO strategy_orders(strategy_id,environment,account_id,market_id,kind,status,
      idempotency_key,wire_order,payload_hash,market_terms,target_order_id)
      VALUES($1,'testnet',642,16,'CANCEL','QUEUED',$2,'{}',$3,'{}',$4)`,
        [strategies[1], randomUUID(), 'b'.repeat(64), legacy],
      ),
    ).rejects.toThrow()
  } finally {
    await db.close()
  }
}, 30_000)
