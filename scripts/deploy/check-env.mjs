#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const required = {
  testnet: [
    'DATABASE_URL',
    'SESSION_SECRET',
    'EYELER_ALLOWED_WALLETS',
    'CORS_ORIGIN',
    'PERPL_REST_URL',
    'PERPL_WS_URL',
    'PERPL_CHAIN_ID',
    'PERPL_API_KEY',
    'PERPL_API_KEY_SECRET',
    'PERPL_ACCOUNT_ID',
    'MONAD_RPC_URL',
    'MONAD_CHAIN_ID',
  ],
  sandbox: ['SESSION_SECRET', 'EYELER_ENV', 'EYELER_TEST_VENUE'],
}

export function namesFromEnv(source) {
  return new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter(Boolean),
  )
}

export function namesFromRailway(source) {
  const parsed = JSON.parse(source)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('INVALID_RAILWAY_JSON')
  return new Set(Object.keys(parsed))
}

export function checkNames(target, names) {
  if (!(target in required)) throw new Error('INVALID_TARGET')
  return required[target].filter((name) => !names.has(name))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2]
  const file = process.argv[3]
  const railwayJson = process.argv.includes('--railway-json')
  if (!file) {
    console.error('Usage: check-env.mjs <testnet|sandbox> <file> [--railway-json]')
    process.exitCode = 2
  } else {
    try {
      const source = await readFile(file, 'utf8')
      const missing = checkNames(target, railwayJson ? namesFromRailway(source) : namesFromEnv(source))
      if (missing.length) {
        console.error(`Missing names: ${missing.join(', ')}`)
        process.exitCode = 1
      } else console.log(`Required ${target} variable names present`)
    } catch (error) {
      console.error(error instanceof SyntaxError ? 'INVALID_RAILWAY_JSON' : error.message)
      process.exitCode = 2
    }
  }
}
