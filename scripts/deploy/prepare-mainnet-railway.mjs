#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const fixedVariables = Object.freeze({
  EYELER_ENV: 'mainnet',
  EYELER_PERPL_ACCOUNT_MODE: 'per-user',
  EYELER_ACCESS_MODE: 'allowlist',
  EYELER_OPENING_ENABLED: 'false',
  EYELER_EXECUTION_DISABLED: 'true',
  EYELER_STRATEGIES_ENABLED: 'false',
  EYELER_STRATEGIES_LIVE_ENABLED: 'false',
  EYELER_ANALYTICS_ENABLED: 'false',
  CORS_ORIGIN: 'https://app.eyeler.xyz',
  EYELER_APP_URL: 'https://app.eyeler.xyz',
  PERPL_ENROLLMENT_ORIGIN: 'https://app.eyeler.xyz',
  PERPL_REST_URL: 'https://app.perpl.xyz/api',
  PERPL_WS_URL: 'wss://app.perpl.xyz',
  PERPL_CHAIN_ID: '143',
  MONAD_RPC_URL: 'https://rpc.monad.xyz',
  MONAD_CHAIN_ID: '143',
  AUSD_TOKEN_ADDRESS: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  EYELER_BUILDER_ID: '25',
  EYELER_MAX_BUILDER_FEE_PER_100K: '0',
  EYELER_KEY_CUSTODY: 'railway-allowlist-demo',
  EYELER_DEMO_CUSTODY_ACTIVE_VERSION: 'v1',
})

const secretNames = ['SESSION_SECRET', 'EYELER_DEMO_CUSTODY_KEYS']
const forbiddenNames = [
  'PERPL_API_KEY',
  'PERPL_API_KEY_SECRET',
  'PERPL_ACCOUNT_ID',
  'EYELER_KEY_ENCRYPTION_KEY',
  'KEEL_KEY_ENCRYPTION_KEY',
  'EYELER_TESTNET_CUSTODY_KEYS',
  'EYELER_TESTNET_CUSTODY_ACTIVE_VERSION',
]

export function planMainnetVariables(wallet) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet ?? '')) throw new Error('INVALID_PUBLIC_WALLET_ADDRESS')
  return { ...fixedVariables, EYELER_ALLOWED_WALLETS: wallet.toLowerCase() }
}

export function validateTarget({ service, environment, project }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(service ?? '') || !/mainnet/i.test(service))
    throw new Error('SEPARATE_MAINNET_SERVICE_REQUIRED')
  if (environment !== 'production') throw new Error('PRODUCTION_ENVIRONMENT_REQUIRED')
  if (!/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(project ?? ''))
    throw new Error('EXPLICIT_RAILWAY_PROJECT_REQUIRED')
}

export function railwayArguments(target, key, value) {
  const scope = ['--service', target.service, '--environment', target.environment, '--project', target.project]
  return value === undefined
    ? ['variable', 'set', key, '--stdin', '--skip-deploys', ...scope]
    : ['variable', 'set', `${key}=${value}`, '--skip-deploys', ...scope]
}

export function createRailwayClient(target, run = runRailway) {
  const scope = ['--service', target.service, '--environment', target.environment, '--project', target.project]
  return {
    async listNames() {
      const output = await run(['variable', 'list', '--json', ...scope])
      let parsed
      try {
        parsed = JSON.parse(output)
      } catch {
        throw new Error('RAILWAY_VARIABLE_LIST_INVALID')
      }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
        throw new Error('RAILWAY_VARIABLE_LIST_INVALID')
      return new Set(Object.keys(parsed))
    },
    setPublic: (name, value) => run(railwayArguments(target, name, value)),
    setSecret: (name, value) => run(railwayArguments(target, name), value),
  }
}

export function railwayLaunch(args, platform = process.platform, env = process.env) {
  if (platform === 'win32' && env.APPDATA) {
    return {
      command: process.execPath,
      args: [join(env.APPDATA, 'npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.js'), ...args],
    }
  }
  return { command: 'railway', args }
}

function runRailway(args, input) {
  return new Promise((resolve, reject) => {
    const launch = railwayLaunch(args)
    const child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let byteCount = 0
    child.stdout.on('data', (chunk) => {
      byteCount += chunk.length
      if (byteCount <= 1_000_000) stdout += chunk.toString()
    })
    // Railway may echo variable values; never forward or log its output.
    child.stderr.resume()
    child.on('error', () => reject(new Error('RAILWAY_COMMAND_UNAVAILABLE')))
    child.on('close', (code) => {
      if (byteCount > 1_000_000) reject(new Error('RAILWAY_OUTPUT_TOO_LARGE'))
      else if (code !== 0) reject(new Error('RAILWAY_COMMAND_FAILED'))
      else resolve(stdout)
    })
    child.stdin.end(input)
  })
}

export async function prepareMainnetRailway(target, client, random = randomBytes) {
  validateTarget(target)
  const publicVariables = planMainnetVariables(target.wallet)
  const names = [...Object.keys(publicVariables), ...secretNames]
  if (!target.apply) return { applied: false, names }
  const existing = await client.listNames()
  const forbidden = forbiddenNames.filter((name) => existing.has(name))
  if (forbidden.length) throw new Error(`FORBIDDEN_SHARED_VARIABLE_NAMES: ${forbidden.join(', ')}`)
  const conflicts = names.filter((name) => existing.has(name))
  if (conflicts.length) throw new Error(`VARIABLE_NAMES_ALREADY_PRESENT: ${conflicts.join(', ')}`)
  const applied = []
  try {
    for (const [name, value] of Object.entries(publicVariables)) {
      await client.setPublic(name, value)
      applied.push(name)
    }
    const sessionSecret = random(48).toString('hex')
    await client.setSecret('SESSION_SECRET', sessionSecret)
    applied.push('SESSION_SECRET')
    const wrappingKey = random(32).toString('hex')
    await client.setSecret('EYELER_DEMO_CUSTODY_KEYS', JSON.stringify({ v1: wrappingKey }))
    applied.push('EYELER_DEMO_CUSTODY_KEYS')
  } catch {
    throw new Error(`RAILWAY_PREPARATION_INCOMPLETE_AFTER_NAMES: ${applied.join(', ')}`)
  }
  return { applied: true, names }
}

function parseArguments(argv) {
  const target = { apply: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--apply') target.apply = true
    else if (['--service', '--environment', '--project', '--wallet'].includes(flag)) {
      if (!argv[i + 1]) throw new Error('MISSING_ARGUMENT_VALUE')
      target[flag.slice(2)] = argv[++i]
    } else throw new Error('UNKNOWN_ARGUMENT')
  }
  return target
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const target = parseArguments(process.argv.slice(2))
    const result = await prepareMainnetRailway(target, createRailwayClient(target))
    console.log(`${result.applied ? 'Prepared' : 'Would prepare'} names: ${result.names.join(', ')}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'RAILWAY_PREPARATION_FAILED')
    process.exitCode = 1
  }
}
