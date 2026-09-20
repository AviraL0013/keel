import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL_REQUIRED')
const pool = new pg.Pool({ connectionString: url })
try { for (const name of (await readdir(resolve('database/migrations'))).filter(name => name.endsWith('.sql')).sort()) { const sql = await readFile(resolve('database/migrations', name), 'utf8'); await pool.query(sql); } console.log('migration applied') } finally { await pool.end() }
