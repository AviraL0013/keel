import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { PostgresExecutionRepository } from '../server/src/infrastructure/database/execution-repository.js'
import type { Action } from '../packages/domain/src/index.js'

it('settles verified DEFEND once when stale market timestamps prevent efficiency measurement', async () => {
  const db = new PGlite()
  try {
    await db.exec((await readFile('database/migrations/001_initial.sql', 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''))
    await db.exec(await readFile('database/migrations/002_execution.sql', 'utf8'))
    const user = (await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES('reconciled-defend') RETURNING id")).rows[0].id
    const bookId = (await db.query<{ id: string }>("INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC','LONG','DEFEND',7,5,86400000) RETURNING id", [user])).rows[0].id
    await db.query('INSERT INTO reserves(book_id,available,cap) VALUES($1,10,10)', [bookId])
    const decisionId = (await db.query<{ id: string }>("INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features) VALUES($1,'DEFEND','DEFEND','[]','[]','{}') RETURNING id", [bookId])).rows[0].id
    const actionId = (await db.query<{ id: string }>("INSERT INTO actions(book_id,decision_id,kind,amount,status,idempotency_key) VALUES($1,$2,'DEFEND',0.022509,'FAILED','verified-defend') RETURNING id", [bookId, decisionId])).rows[0].id
    const beforePosition = { side: 'LONG', size: 0.0001, entryPrice: 80599, markPrice: 84000, liquidationPrice: 78449, leverage: 15, unrealizedPnl: 0.34, margin: 0.54, status: 'OPEN' }
    const beforeTelemetry = { mark: 84000, fundingRate: 0, depthNotional: 1000, volatility: 0, timestamp: 2000 }
    const action = { id: actionId, bookId, decisionId, kind: 'DEFEND', amount: 0.022509, status: 'CONFIRMED', idempotencyKey: 'verified-defend', venueReference: '642:1791001362436:0xproof', confirmedAt: new Date().toISOString(), beforeState: { position: beforePosition, telemetry: beforeTelemetry } } as Action
    const pool = { query: db.query.bind(db), connect: async () => ({ query: db.query.bind(db), release: () => undefined }) }
    const repo = new PostgresExecutionRepository({ pool } as never)
    vi.spyOn(repo, 'getBookContext').mockResolvedValue({ position: beforePosition, telemetry: { ...beforeTelemetry, timestamp: 1000 } } as never)
    await repo.finalize(action)
    await repo.finalize(action)
    expect((await db.query('SELECT status,error FROM actions WHERE id=$1', [actionId])).rows).toEqual([{ status: 'CONFIRMED', error: null }])
    expect((await db.query('SELECT available,deployed FROM reserves WHERE book_id=$1', [bookId])).rows).toEqual([{ available: '9.977491', deployed: '0.022509' }])
    expect((await db.query("SELECT id FROM reserve_ledger_entries WHERE action_id=$1 AND type='RESERVE_DEPLOYED'", [actionId])).rows).toHaveLength(1)
    expect((await db.query("SELECT id FROM autopsy_events WHERE book_id=$1 AND type='DEFENSE_MEASUREMENT_UNAVAILABLE'", [bookId])).rows).toHaveLength(1)
    expect((await db.query('SELECT action_id FROM defense_performance WHERE action_id=$1', [actionId])).rows).toHaveLength(0)
  } finally { await db.close() }
}, 20000)
