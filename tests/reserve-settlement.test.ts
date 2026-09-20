import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { settleDefense } from '../server/src/reserveSettlement.js'

it('settles confirmed defense, ledger and audit atomically and once', async () => {
  const db = new PGlite()
  try {
    await db.exec((await readFile('database/migrations/001_initial.sql', 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''))
    await db.exec(await readFile('database/migrations/002_execution.sql', 'utf8'))
    const user = (await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES('settlement-test') RETURNING id")).rows[0].id
    const book = (await db.query<{ id: string }>("INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC','LONG','DEFEND',6,100,1000) RETURNING id", [user])).rows[0].id
    await db.query('INSERT INTO reserves(book_id,available,cap) VALUES($1,100,100)', [book])
    const decision = (await db.query<{ id: string }>("INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features) VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id", [book])).rows[0].id
    const action = (await db.query<{ id: string }>("INSERT INTO actions(book_id,decision_id,kind,amount,status,idempotency_key) VALUES($1,$2,'DEFEND',20,'CONFIRMED','settlement') RETURNING id", [book, decision])).rows[0].id
    const run = () => db.transaction(async tx => settleDefense(tx, book, 20, action, decision))
    await run(); await run()
    expect((await db.query('SELECT available,deployed FROM reserves')).rows).toEqual([{ available: '80', deployed: '20' }])
    expect((await db.query('SELECT action_id,decision_id FROM reserve_ledger_entries')).rows).toEqual([{ action_id: action, decision_id: decision }])
    expect((await db.query("SELECT * FROM autopsy_events WHERE type='RESERVE_DEPLOYED'")).rows).toHaveLength(1)
    await expect(db.transaction(async tx => { await tx.query('DELETE FROM reserve_ledger_entries'); await settleDefense(tx, book, 200, action, decision) })).rejects.toThrow('UNCONFIRMED_DEPLOYMENT')
    expect((await db.query('SELECT * FROM reserve_ledger_entries')).rows).toHaveLength(1)
  } finally { await db.close() }
}, 20000)
