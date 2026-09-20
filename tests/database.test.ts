import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'

describe('PostgreSQL migration invariants', () => {
  it('enforces ownership relations, reserve caps, session expiry and active action uniqueness', async () => {
    const db = new PGlite()
    try {
      // PGlite includes gen_random_uuid in PostgreSQL core; pgcrypto is not bundled.
      const migration = (await readFile('database/migrations/001_initial.sql', 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '')
      await db.exec(migration)
      await db.exec(await readFile('database/migrations/002_execution.sql', 'utf8'))
      const user = (await db.query<{id:string}>("INSERT INTO users(wallet_address) VALUES('0x111') RETURNING id")).rows[0].id
      const book = (await db.query<{id:string}>("INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC','LONG','DEFEND',6,100,3600000) RETURNING id", [user])).rows[0].id
      await db.query('INSERT INTO reserves(book_id,available,reserved,deployed,cap) VALUES($1,100,0,0,100)', [book])
      await expect(db.query('UPDATE reserves SET deployed=101 WHERE book_id=$1', [book])).rejects.toThrow()
      await expect(db.query('UPDATE reserves SET available=-1 WHERE book_id=$1', [book])).rejects.toThrow()
      const decision = (await db.query<{id:string}>("INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features) VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id", [book])).rows[0].id
      await db.query("INSERT INTO actions(book_id,decision_id,kind,status,idempotency_key) VALUES($1,$2,'DEFEND','UNKNOWN','first')", [book,decision])
      await expect(db.query("INSERT INTO actions(book_id,decision_id,kind,status,idempotency_key) VALUES($1,$2,'DEFEND','QUEUED','second')", [book,decision])).rejects.toThrow()
      await db.query('INSERT INTO sessions(id,user_id,wallet_address,expires_at) VALUES($1,$2,$3,now()-interval \'1 second\')',['hash',user,'0x111'])
      expect((await db.query('SELECT * FROM sessions WHERE expires_at>now() AND revoked_at IS NULL')).rows).toHaveLength(0)
    } finally { await db.close() }
  }, 20000)
})
