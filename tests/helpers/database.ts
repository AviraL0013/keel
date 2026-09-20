import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import type pg from 'pg'
import { PostgresStore } from '../../server/src/infrastructure/database/postgres-store.js'

/** SQL executes in PostgreSQL/WASM; only the pg transport is substituted. */
export async function databaseFixture() {
  const db = new PGlite()
  for (const file of (await readdir('database/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await readFile(`database/migrations/${file}`, 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''))
  }
  const query = async (sql: string, values?: unknown[]) => {
    const result = await db.query<Record<string, unknown>>(sql, values)
    return { ...result, rowCount: result.affectedRows ?? result.rows.length }
  }
  const pool = { query, connect: async () => ({ query, release() {} }), end: () => db.close() } as unknown as pg.Pool
  return { db, store: new PostgresStore('', pool) }
}

