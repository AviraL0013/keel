import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'

it('migration 017 preserves existing data, re-runs safely and enforces per-user idempotency and one unresolved opening', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000001')
    const connection = randomUUID(),
      preview = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE')`,
      [connection, user],
    )
    const sql = await readFile('database/migrations/017_opening_orders.sql', 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    await db.query(
      `INSERT INTO opening_previews(id,user_id,connection_id,environment,account_id,market_id,parameters,parameter_hash,quote,expires_at)
      VALUES($1,$2,$3,'testnet',12,7,'{}','hash','{}',now()+interval '15 seconds')`,
      [preview, user, connection],
    )
    const insert = async (key: string, account = 12) =>
      db.query(
        `INSERT INTO opening_orders
      (user_id,connection_id,environment,account_id,market_id,side,size,price_limit,leverage,collateral,fees,preview_id,idempotency_key,status)
      VALUES($1,$2,'testnet',$3,7,'LONG',0.001,100000,5,20,0.05,$4,$5,'QUEUED')`,
        [user, connection, account, preview, key],
      )
    const key = randomUUID()
    await insert(key)
    await expect(insert(key, 13)).rejects.toThrow()
    await expect(insert(randomUUID())).rejects.toThrow()
    expect((await db.query('SELECT count(*)::int AS count FROM opening_orders')).rows[0].count).toBe(1)
    expect((await db.query('SELECT count(*)::int AS count FROM users WHERE id=$1', [user])).rows[0].count).toBe(1)
  } finally {
    await db.close()
  }
}, 30000)
