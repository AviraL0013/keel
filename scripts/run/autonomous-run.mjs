import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, appendFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import Decimal from 'decimal.js'
import { privateKeyToAccount } from 'viem/accounts'

const terminal = new Set(['CONFIRMED', 'FAILED', 'CANCELED', 'EXPIRED'])
const unresolved = new Set(['UNKNOWN', 'PARTIAL'])
const active = new Set(['QUEUED', 'VALIDATING', 'SUBMITTING', 'SUBMITTED', 'VERIFYING', 'UNKNOWN', 'PARTIAL'])
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

export function validateConfig(config, dryRun = false) {
  if (!config || typeof config !== 'object') throw new Error('RUN_CONFIG_REQUIRED')
  if (config.chainId !== 10143) throw new Error('MONAD_TESTNET_CHAIN_REQUIRED')
  const api = new URL(config.apiUrl)
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password) throw new Error('API_URL_INVALID')
  if (!dryRun && api.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(api.hostname))
    throw new Error('LIVE_API_HTTPS_REQUIRED')
  if (
    [config.apiUrl, config.perplRestUrl, config.perplWsUrl].some((value) =>
      /mainnet|app\.perpl\.xyz/i.test(value ?? ''),
    )
  )
    throw new Error('MAINNET_TARGET_REFUSED')
  if (!/testnet/i.test(config.perplRestUrl ?? '') || !/testnet/i.test(config.perplWsUrl ?? ''))
    throw new Error('PERPL_TESTNET_URLS_REQUIRED')
  if (!Number.isSafeInteger(config.positionId) || config.positionId <= 0) throw new Error('POSITION_ID_INVALID')
  if (!Number.isSafeInteger(config.marketId) || config.marketId <= 0 || !config.market)
    throw new Error('MARKET_INVALID')
  for (const key of ['reserve', 'cap', 'liquidationFloorOffset']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`${key.toUpperCase()}_INVALID`)
  }
  if (new Decimal(config.reserve).gt(5) || new Decimal(config.cap).gt(2) || new Decimal(config.cap).gt(config.reserve))
    throw new Error('RUN_BUDGET_LIMIT')
  if (!Number.isSafeInteger(config.runMinutes) || config.runMinutes < 60 || config.runMinutes > 120)
    throw new Error('RUN_LENGTH_INVALID')
  if (
    config.restartCommand &&
    (!Array.isArray(config.restartCommand) || !config.restartCommand.every((x) => typeof x === 'string'))
  )
    throw new Error('RESTART_COMMAND_INVALID')
  return config
}

function command(argv) {
  return new Promise((done, reject) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? done() : reject(new Error(`COMMAND_EXIT_${code}`))))
  })
}

export async function runAutonomous(config, options = {}) {
  validateConfig(config, options.dryRun)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? delay
  const fetchImpl = options.fetch ?? fetch
  const wallet = options.wallet
  if (!wallet?.address || !wallet?.signMessage) throw new Error('OPERATOR_WALLET_REQUIRED')
  const runId = options.state?.runId ?? options.runId ?? randomUUID()
  const state = options.state ?? {
    runId,
    phase: 'PREFLIGHT',
    startedAt: new Date(now()).toISOString(),
    actionIntents: {},
  }
  const persist = options.persist ?? (async () => {})
  const record = options.record ?? (async () => {})
  const restart = options.restart ?? command
  const report = options.report ?? command
  let token
  const request = async (method, path, body) => {
    const response = await fetchImpl(new URL(path, config.apiUrl), {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.status === 401 || response.status === 403) throw new Error(`ACCESS_DENIED_${response.status}`)
    if (!response.ok) throw new Error(`API_${response.status}_${path.split('?')[0]}`)
    return response.json()
  }
  const setPhase = async (phase) => {
    state.phase = phase
    await persist(state)
  }
  const scanActions = async () => {
    const actions = await request('GET', `/books/${state.bookId}/actions`)
    if (actions.some((item) => unresolved.has(item.status))) throw new Error('UNRESOLVED_ACTION_STOP')
    return actions
  }
  const waitForAction = async (kind, intent) => {
    for (let tries = 0; tries < 120; tries++) {
      const actions = await scanActions()
      const found = actions.find(
        (item) =>
          item.kind === kind && (intent.actionId ? item.id === intent.actionId : !intent.knownIds.includes(item.id)),
      )
      if (found) {
        if (found.status === 'CONFIRMED') return found
        if (terminal.has(found.status)) throw new Error(`ACTION_${found.status}`)
      }
      await sleep(5000)
    }
    throw new Error('ACTION_CONFIRMATION_TIMEOUT')
  }
  const manualAction = async (kind) => {
    if (state.actionIntents[kind]) {
      if (state.actionIntents[kind].status === 'CONFIRMED') return
      const found = await waitForAction(kind, state.actionIntents[kind])
      state.actionIntents[kind] = { ...state.actionIntents[kind], status: found.status, actionId: found.id }
      await persist(state)
      return
    }
    const knownIds = (await scanActions()).map((item) => item.id)
    state.actionIntents[kind] = { at: now(), status: 'SENDING', knownIds }
    await persist(state)
    const action =
      kind === 'EXIT'
        ? await request('POST', `/books/${state.bookId}/close`)
        : await request('POST', `/books/${state.bookId}/actions`, { kind })
    state.actionIntents[kind] = { ...state.actionIntents[kind], status: 'WAITING', actionId: action.id ?? null }
    await persist(state)
    const confirmed = await waitForAction(kind, state.actionIntents[kind])
    state.actionIntents[kind] = { ...state.actionIntents[kind], status: 'CONFIRMED', actionId: confirmed.id }
    await persist(state)
  }

  const health = await request('GET', '/health')
  if (health.environment !== (options.dryRun ? 'test' : 'testnet')) throw new Error('TARGET_ENVIRONMENT_MISMATCH')
  const identity = await request('GET', '/')
  if (identity.environment !== health.environment) throw new Error('TARGET_ENVIRONMENT_MISMATCH')
  let unreadySince
  const ready = async () => {
    try {
      const value = await request('GET', '/ready')
      if (!value.ready || value.executionDisabled || !value.venueReady || !value.lockOwned)
        throw new Error('BACKEND_NOT_READY')
      unreadySince = undefined
      return value
    } catch (error) {
      if (String(error.message).startsWith('ACCESS_DENIED')) throw error
      unreadySince ??= now()
      if (now() - unreadySince >= 120_000) throw new Error('READY_UNAVAILABLE_OVER_TWO_MINUTES')
      return null
    }
  }
  if (!(await ready())) throw new Error('PREFLIGHT_NOT_READY')

  const challenge = await request('POST', '/auth/challenge', { address: wallet.address })
  const signature = await wallet.signMessage({ message: challenge.message })
  const session = await request('POST', '/auth/verify', {
    address: wallet.address,
    nonce: challenge.nonce,
    message: challenge.message,
    signature,
  })
  token = session.token
  if (!token) throw new Error('AUTH_TOKEN_MISSING')
  const positions = await request('GET', '/connections/perpl/positions')
  const selected = positions.positions?.find(
    (item) => item.positionId === config.positionId && item.marketId === config.marketId,
  )
  if (!selected || selected.position?.status !== 'OPEN') throw new Error('BOUND_POSITION_NOT_OPEN')
  if (selected.market !== config.market) throw new Error('MARKET_BINDING_MISMATCH')
  if (selected.bookCreation?.allowed === false) throw new Error('POSITION_NOT_BOOK_READY')
  const capital = await request('GET', '/capital')
  if (capital.perplAvailable?.amount == null || new Decimal(capital.perplAvailable.amount).lt(config.cap))
    throw new Error('FREE_BALANCE_BELOW_CAP')
  const books = await request('GET', '/books')
  for (const book of books.filter((item) => item.venuePositionId === config.positionId)) {
    if ((await request('GET', `/books/${book.id}/actions`)).some((item) => active.has(item.status)))
      throw new Error('POSITION_HAS_UNRESOLVED_ACTION')
  }
  const distance = Number(selected.telemetry?.liquidationDistance)
  if (!Number.isFinite(distance) || distance <= config.liquidationFloorOffset)
    throw new Error('LIQUIDATION_DISTANCE_UNAVAILABLE')
  const floor = Number(new Decimal(distance).minus(config.liquidationFloorOffset).toFixed(4))
  if (state.phase === 'PREFLIGHT') {
    if (state.createIntent) {
      const matches = books.filter(
        (item) => item.venuePositionId === config.positionId && item.marketId === config.marketId,
      )
      if (matches.length !== 1) throw new Error('AMBIGUOUS_BOOK_CREATION')
      state.bookId = matches[0].id
      state.floor = floor
      await setPhase('MANUAL_DEFEND')
    } else {
      state.createIntent = true
      await persist(state)
      const book = await request('POST', '/books', {
        market: config.market,
        marketId: config.marketId,
        venueAccountId: selected.accountId,
        venuePositionId: config.positionId,
        side: selected.position.side,
        stance: 'DEFEND',
        liquidationFloor: floor,
        defenseCap: config.cap,
        timeLimitMs: config.runMinutes * 60_000,
        automationEnabled: false,
        reserveAvailable: config.reserve,
      })
      state.bookId = book.id
      state.floor = floor
      await setPhase('MANUAL_DEFEND')
    }
  }
  if (!state.bookId) throw new Error('RESUME_BOOK_ID_MISSING')
  if (state.phase === 'MANUAL_DEFEND') {
    await manualAction('DEFEND')
    await setPhase('MANUAL_REDUCE')
  }
  if (state.phase === 'MANUAL_REDUCE') {
    await manualAction('REDUCE')
    await setPhase('ARM')
  }
  if (state.phase === 'ARM') {
    const position = await request('GET', `/books/${state.bookId}/position`)
    if (position?.status !== 'OPEN') throw new Error('POSITION_NOT_OPEN_AFTER_REDUCE')
    state.armIntent = true
    await persist(state)
    const book = await request('GET', `/books/${state.bookId}`)
    if (!book.automationEnabled) {
      if (state.armRequestSent) throw new Error('AMBIGUOUS_ARM_REQUEST')
      state.armRequestSent = true
      await persist(state)
      await request('POST', `/books/${state.bookId}/arm`)
    }
    state.monitorUntil ??= now() + config.runMinutes * 60_000
    await record({
      at: new Date(now()).toISOString(),
      kind: 'ARMED',
      floor: state.floor,
      distance,
      offset: config.liquidationFloorOffset,
    })
    await setPhase('MONITOR')
  }
  if (state.phase === 'MONITOR') {
    let lastSeen = new Set(state.seenActions ?? [])
    while (now() < state.monitorUntil) {
      const status = await ready()
      const book = await request('GET', `/books/${state.bookId}`)
      const actions = await scanActions()
      const reserve = await request('GET', `/books/${state.bookId}/reserve`)
      if (book.status === 'SAFE_MODE' || !book.automationEnabled || book.venuePositionId !== config.positionId)
        throw new Error('BOOK_SAFETY_STATE_CHANGED')
      if (
        !reserve ||
        new Decimal(reserve.cap).gt(config.cap) ||
        new Decimal(reserve.reserved).plus(reserve.deployed).gt(reserve.cap) ||
        new Decimal(reserve.available).lt(0)
      )
        throw new Error('RESERVE_INVARIANT_BROKEN')
      const fresh = actions.filter((item) => !lastSeen.has(item.id))
      if (fresh.some((item) => item.kind === 'DEFEND' && new Decimal(item.amount).gt(config.cap)))
        throw new Error('DEFENSE_CAP_BREACH')
      await record({
        at: new Date(now()).toISOString(),
        kind: 'MONITOR',
        ready: status?.ready ?? false,
        lastTickAgeMs: status?.lastTickAgeMs ?? null,
        bookStatus: book.status,
        actions: fresh.map((item) => ({ id: item.id, kind: item.kind, status: item.status })),
      })
      fresh.forEach((item) => lastSeen.add(item.id))
      state.seenActions = [...lastSeen]
      await persist(state)
      if (
        config.restartCommand &&
        !state.restarted &&
        now() >= Date.parse(state.startedAt) + (config.runMinutes * 60_000) / 2
      ) {
        if (state.restartIntent) throw new Error('AMBIGUOUS_RESTART')
        state.restartIntent = true
        await persist(state)
        await restart(config.restartCommand)
        state.restarted = true
        await persist(state)
      }
      await sleep(60_000)
    }
    await setPhase('PAUSE')
  }
  if (state.phase === 'PAUSE') {
    const book = await request('GET', `/books/${state.bookId}`)
    state.pauseIntent = true
    await persist(state)
    if (book.automationEnabled) {
      if (state.pauseRequestSent) throw new Error('AMBIGUOUS_PAUSE_REQUEST')
      state.pauseRequestSent = true
      await persist(state)
      await request('POST', `/books/${state.bookId}/pause`)
    }
    await setPhase('MANUAL_EXIT')
  }
  if (state.phase === 'MANUAL_EXIT') {
    await manualAction('EXIT')
    await setPhase('REPORT')
  }
  if (state.phase === 'REPORT') {
    await report([
      'node',
      'dist/scripts/report.js',
      '--from',
      state.startedAt,
      '--to',
      new Date(now()).toISOString(),
      '--book',
      state.bookId,
      '--out',
      options.reportPath ?? `runs/${runId}/report.md`,
    ])
    await setPhase('DONE')
  }
  return state
}

async function main() {
  const args = process.argv.slice(2)
  const configPath = args[0]
  if (!configPath) throw new Error('CONFIG_PATH_REQUIRED')
  const dryRun = args.includes('--dry-run')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  validateConfig(config, dryRun)
  const key = process.env.EYELER_OPERATOR_PRIVATE_KEY
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('OPERATOR_PRIVATE_KEY_REQUIRED')
  const wallet = privateKeyToAccount(key)
  const runId =
    args[args.indexOf('--resume') + 1] && args.includes('--resume') ? args[args.indexOf('--resume') + 1] : randomUUID()
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('RUN_ID_INVALID')
  const directory = resolve('runs', runId)
  await mkdir(directory, { recursive: true })
  const statePath = resolve(directory, 'state.json')
  let state
  if (args.includes('--resume')) state = JSON.parse(await readFile(statePath, 'utf8'))
  const persist = async (value) => {
    const temporary = `${statePath}.tmp`
    await writeFile(temporary, JSON.stringify(value, null, 2))
    await rename(temporary, statePath)
  }
  const record = (value) => appendFile(resolve(directory, 'events.jsonl'), `${JSON.stringify(value)}\n`)
  await runAutonomous(config, {
    dryRun,
    wallet,
    runId,
    state,
    persist,
    record,
    reportPath: resolve(directory, 'report.md'),
  })
  console.log(`Run complete: ${directory}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'RUN_FAILED')
    process.exitCode = 1
  })
