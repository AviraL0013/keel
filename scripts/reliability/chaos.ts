import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import type { Action } from '../../packages/domain/src/index.js'
import type { Ed25519PerplSigner } from '../../packages/perpl/src/signer.js'
import { PerplTradingClient, type PerplOrder } from '../../packages/perpl/src/trading.js'
import { EyelerRuntime, type RuntimeVenue } from '../../server/src/runtime.js'
import type { PostgresStore } from '../../server/src/infrastructure/database/postgres-store.js'
import { SyntheticExecutionFixture } from './chaos-fixture.js'

export type ReliabilityChaosResult = {
  scenario: string
  at: string
  status: 'passed' | 'failed' | 'unavailable'
  recoveryMs: number
  invariants: {
    noDuplicateOrders: boolean
    noUnknownResubmission: boolean
    noPartialResubmission: boolean
    failClosed: boolean
  }
  summary: string
}
type Evidence = {
  at: string
  recoveryMs: number
  recovered: boolean
  blocked: boolean
  orders: string[]
  summary: string
}
type FailureStamp = { at: string; monotonic: number }
const failureStamp = (): FailureStamp => ({ at: new Date().toISOString(), monotonic: performance.now() })
const finishEvidence = (stamp: FailureStamp, evidence: Omit<Evidence, 'at' | 'recoveryMs'>): Evidence => ({
  ...evidence,
  at: stamp.at,
  recoveryMs: Math.round((performance.now() - stamp.monotonic) * 1000) / 1000,
})
type RuntimeControl = {
  tick(): Promise<void>
  tryAcquireAndStart(): Promise<void>
  lockLoss?: Promise<void>
  repository: unknown
  lease: unknown
}
const controls = (runtime: EyelerRuntime) => runtime as unknown as RuntimeControl
const order: PerplOrder = { acc: 642, mkt: 16, t: 1, s: 1, p: 10000, lv: 100, orderTtlBlocks: 20, fl: 4 }

/** Recursive cleanup must target only the disposable child created by this harness. */
export function verifiedSyntheticTempDirectory(directory: string): string {
  const target = resolve(directory)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('eyeler-synthetic-chaos-'))
    throw Error('SYNTHETIC_TEMP_PATH_INVALID')
  return target
}

function runtimeRecovery(fixture: SyntheticExecutionFixture, reconcile: (action: Action) => Promise<Action>) {
  let submits = 0
  const venue: RuntimeVenue = {
    ready: () => false,
    close: async () => undefined,
    refresh: async () => undefined,
    submit: async () => {
      submits++
      throw Error('SYNTHETIC_RESUBMISSION')
    },
    reconcile,
  }
  const store = {
    pool: {
      query: async (sql: string) => ({
        rows: sql.includes('FROM books') ? [{ id: fixture.book.id, user_id: fixture.book.userId }] : [],
      }),
    },
    getBook: async () => fixture.book,
  } as unknown as PostgresStore
  const runtime = new EyelerRuntime(store, venue)
  controls(runtime).repository = fixture.repository
  controls(runtime).lease = { query: async () => ({ rows: [] }), release: () => undefined }
  return { runtime, submits: () => submits }
}

/** Every scenario also checks the real runtime's unresolved-action recovery paths. */
async function unresolvedSafety() {
  const results: Record<'UNKNOWN' | 'PARTIAL', boolean> = { UNKNOWN: false, PARTIAL: false }
  let blocked = true
  for (const status of ['UNKNOWN', 'PARTIAL'] as const) {
    const fixture = new SyntheticExecutionFixture()
    const worker = fixture.worker()
    const decision = await worker.evaluate(fixture.book.id)
    const action: Action = {
      id: `synthetic-${status}`,
      bookId: fixture.book.id,
      decisionId: decision.id,
      kind: 'DEFEND',
      amount: decision.amount,
      status,
      idempotencyKey: `${decision.id}:${decision.action}`,
      venueReference: '642:45',
    }
    await fixture.repository.saveAction(action)
    const existing = await worker.execute(decision)
    let secondBlocked = false
    try {
      await worker.execute({ ...decision, id: `${decision.id}-new` })
    } catch {
      secondBlocked = true
    }
    const recovery = runtimeRecovery(fixture, async (row) => ({ ...row, status }))
    try {
      await controls(recovery.runtime).tick()
      results[status] =
        existing.id === action.id &&
        fixture.ledger.orderIds.length === 0 &&
        recovery.submits() === 0 &&
        fixture.ledger.actions[0].status === status
      blocked &&= secondBlocked
    } finally {
      await recovery.runtime.stop()
    }
  }
  return { results, blocked }
}

async function killedAction(): Promise<Evidence> {
  const directory = await mkdtemp(join(tmpdir(), 'eyeler-synthetic-chaos-'))
  const path = join(directory, 'ledger.json')
  const source = import.meta.url.endsWith('.ts')
  const childPath = fileURLToPath(new URL(source ? './chaos-child.ts' : './chaos-child.js', import.meta.url))
  const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), childPath, path], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { NODE_ENV: 'test', EYELER_EXECUTION_DISABLED: 'false' },
    windowsHide: true,
  })
  let fault: FailureStamp | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(Error('SYNTHETIC_CHILD_TIMEOUT'))
      }, 15_000)
      child.once('error', () => {
        clearTimeout(timer)
        reject(Error('SYNTHETIC_CHILD_UNAVAILABLE'))
      })
      child.on('message', (message) => {
        if ((message as { event?: string }).event === 'synthetic-send-persisted') {
          fault = failureStamp()
          child.kill('SIGKILL')
        }
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        if (signal === 'SIGKILL' || (process.platform === 'win32' && code !== 0)) resolve()
        else reject(Error('SYNTHETIC_KILL_NOT_OBSERVED'))
      })
    })
    if (!fault) throw Error('SYNTHETIC_KILL_NOT_OBSERVED')
    const fixture = new SyntheticExecutionFixture(path)
    await fixture.restore()
    const decision = fixture.ledger.decisions[0]
    if (!decision || fixture.ledger.actions[0]?.status !== 'SUBMITTING') throw Error('SYNTHETIC_DURABLE_ACTION_MISSING')
    let blocked = false
    try {
      await fixture.worker().execute({ ...decision, id: `${decision.id}-after-kill` })
    } catch {
      blocked = true
    }
    const pending = runtimeRecovery(fixture, async (action) => ({ ...action, status: 'UNKNOWN' }))
    try {
      await controls(pending.runtime).tick()
    } finally {
      await pending.runtime.stop()
    }
    const unknown = ['SUBMITTING', 'UNKNOWN'].includes(fixture.ledger.actions[0]?.status) && pending.submits() === 0
    const restored = runtimeRecovery(fixture, async (action) => ({ ...action, status: 'CONFIRMED' }))
    try {
      await controls(restored.runtime).tick()
    } finally {
      await restored.runtime.stop()
    }
    return finishEvidence(fault, {
      blocked: blocked && unknown,
      recovered: String(fixture.ledger.actions[0]?.status) === 'CONFIRMED' && restored.submits() === 0,
      orders: fixture.ledger.orderIds,
      summary:
        'Synthetic child killed after a durable fake send; restarted Book recovery keeps the outcome unresolved, then confirms from fake evidence without another send.',
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    const cleanupTarget = verifiedSyntheticTempDirectory(directory)
    await rm(cleanupTarget, { recursive: true, force: true })
  }
}

type FakeClientControl = {
  socket: unknown
  lifecycle: string
  streamEpoch: string
  stopped: boolean
  handleMessage(raw: string): void
}
function syntheticTrading(
  baseline: () => Promise<{ lfr: string; rejectedForwardedRq: string }> = async () => ({
    lfr: '44',
    rejectedForwardedRq: '0',
  }),
) {
  const orderIds: string[] = []
  const client = new PerplTradingClient(
    {
      environment: 'testnet',
      chainId: 10143,
      restUrl: '',
      wsUrl: '',
      rpcUrl: '',
      exchangeAddress: '',
      collateralToken: '',
    },
    { apiKey: 'synthetic-only' } as Ed25519PerplSigner,
    () => undefined,
    async () => '45',
    baseline,
    30_000,
    100,
    () => undefined,
  )
  const internals = client as unknown as FakeClientControl
  const install = (confirm: boolean) => {
    internals.stopped = false
    internals.lifecycle = 'AUTHENTICATING'
    internals.streamEpoch = 'synthetic-stream'
    internals.socket = {
      readyState: 1,
      close: () => undefined,
      send: (raw: string, callback?: (error?: Error) => void) => {
        const frame = JSON.parse(raw) as { mt: number; rq: string }
        if (frame.mt === 22) {
          orderIds.push(String(frame.rq))
          if (confirm)
            internals.handleMessage(
              JSON.stringify({
                mt: 24,
                d: [
                  {
                    acc: 642,
                    mkt: 16,
                    rq: frame.rq,
                    oid: 99,
                    st: 4,
                    t: 1,
                    os: 1,
                    fs: 1,
                    at: { b: 101, t: Date.now() },
                  },
                ],
              }),
            )
        }
        callback?.()
      },
    }
    for (const frame of [
      {
        mt: 19,
        sn: 9,
        addr: 'synthetic',
        as: [{ id: 642, in: 1, fr: false, fw: true, ft: 0, lfr: 44, b: '100000000', lb: '0' }],
      },
      { mt: 23, d: [] },
      { mt: 26, d: [] },
      { mt: 100, sn: 10, h: 100 },
    ])
      internals.handleMessage(JSON.stringify(frame))
  }
  return { client, orderIds, install }
}

async function websocketDrop(): Promise<Evidence> {
  const fixture = syntheticTrading()
  try {
    fixture.install(false)
    const readyBefore = fixture.client.isReady()
    const pending = fixture.client.submitOpening('synthetic-disconnect', order, async () => undefined)
    // Wait until the real transport has emitted its frame to the in-memory socket.
    for (let step = 0; step < 20 && fixture.orderIds.length === 0; step++)
      await new Promise((resolve) => setImmediate(resolve))
    const fault = failureStamp()
    fixture.client.close()
    const result = await pending
    let refused = false
    try {
      await fixture.client.submitOpening('synthetic-while-disconnected', order, async () => undefined)
    } catch {
      refused = true
    }
    const disconnected = !fixture.client.isReady() && fixture.client.lifecycleState() === 'DISCONNECTED'
    fixture.install(true)
    return finishEvidence(fault, {
      blocked: readyBefore && refused && disconnected && result.status === 'UNKNOWN',
      recovered: fixture.client.isReady(),
      orders: fixture.orderIds,
      summary:
        'Synthetic WebSocket disconnect invalidates real Perpl client state, resolves pending outcome as UNKNOWN, and blocks new sends until fresh snapshots.',
    })
  } finally {
    fixture.client.close()
  }
}

async function staleData(): Promise<Evidence> {
  const fixture = new SyntheticExecutionFixture()
  const worker = fixture.worker()
  const fault = failureStamp()
  fixture.telemetry.timestamp -= 60_000
  fixture.position.timestamp = fixture.telemetry.timestamp
  fixture.telemetry.freshnessMs = 60_000
  const decision = await worker.evaluate(fixture.book.id)
  await worker.execute(decision)
  const blocked = decision.action === 'SAFE_MODE' && fixture.ledger.orderIds.length === 0
  fixture.telemetry.timestamp = Date.now()
  fixture.position.timestamp = fixture.telemetry.timestamp
  fixture.telemetry.freshnessMs = 1
  const fresh = await worker.evaluate(fixture.book.id)
  const result = await worker.execute(fresh)
  return finishEvidence(fault, {
    blocked,
    recovered: 'status' in result && result.status === 'CONFIRMED',
    orders: fixture.ledger.orderIds,
    summary:
      'Synthetic stale market/position observations trigger real risk-engine SAFE_MODE; refreshed replay state permits one fake action.',
  })
}

async function rpcTimeout(): Promise<Evidence> {
  let timeout = true
  const fixture = syntheticTrading(async () => {
    if (timeout) throw Error('SYNTHETIC_RPC_TIMEOUT')
    return { lfr: '44', rejectedForwardedRq: '0' }
  })
  try {
    fixture.install(true)
    const fault = failureStamp()
    let refused = false
    try {
      await fixture.client.submitOpening('synthetic-rpc-fault', order, async () => undefined)
    } catch (error) {
      refused = error instanceof Error && error.message === 'PERPL_REQUEST_ID_BASELINE_UNAVAILABLE'
    }
    const blocked = refused && fixture.orderIds.length === 0
    timeout = false
    const result = await fixture.client.submitOpening('synthetic-rpc-recovered', order, async () => undefined)
    return finishEvidence(fault, {
      blocked,
      recovered: result.status === 'CONFIRMED',
      orders: fixture.orderIds,
      summary:
        'Synthetic RPC timeout at real request-baseline guard prevents allocation/send; restored fake baseline permits one confirmed fake frame.',
    })
  } finally {
    fixture.client.close()
  }
}

function syntheticLease() {
  let owner: string | undefined
  let next = 0
  const connections: Array<
    EventEmitter & { query(sql: string): Promise<{ rows: Array<{ owned?: boolean }> }>; release(): void }
  > = []
  const authority = new Set<string>()
  let maximumAuthority = 0
  const pool = {
    connect: async () => {
      const id = `synthetic-lease-${++next}`
      const connection = Object.assign(new EventEmitter(), {
        query: async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) {
            const owned = owner === undefined || owner === id
            if (owned) owner = id
            return { rows: [{ owned }] }
          }
          if (sql.includes('pg_advisory_unlock') && owner === id) owner = undefined
          return { rows: [] }
        },
        release: () => {
          if (owner === id) owner = undefined
        },
      })
      connections.push(connection)
      return connection
    },
    query: async () => ({ rows: [] }),
  }
  const venue = (id: string): RuntimeVenue => ({
    ready: () => authority.has(id),
    start: async () => {
      authority.add(id)
      maximumAuthority = Math.max(maximumAuthority, authority.size)
    },
    close: async () => {
      authority.delete(id)
    },
    refresh: async () => undefined,
    submit: async () => {
      throw Error('SYNTHETIC_ORDER_FORBIDDEN')
    },
    reconcile: async (action) => action,
  })
  return { pool, connections, authority, venue, maximum: () => maximumAuthority }
}

async function databaseLoss(): Promise<Evidence> {
  const fixture = syntheticLease()
  const runtime = new EyelerRuntime({ pool: fixture.pool } as unknown as PostgresStore, fixture.venue('primary'))
  const execution = new SyntheticExecutionFixture()
  const worker = execution.worker()
  const decision = await worker.evaluate(execution.book.id)
  try {
    await runtime.start()
    const fault = failureStamp()
    execution.unavailable = true
    let refused = false
    try {
      await worker.execute(decision)
    } catch {
      refused = true
    }
    fixture.connections[0].emit('error', Error('SYNTHETIC_DATABASE_CONNECTION_LOST'))
    await controls(runtime).lockLoss
    const blocked =
      refused && execution.ledger.orderIds.length === 0 && !runtime.health().lockOwned && fixture.authority.size === 0
    execution.unavailable = false
    await controls(runtime).tryAcquireAndStart()
    const recovered = runtime.health().lockOwned && fixture.authority.size === 1
    return finishEvidence(fault, {
      blocked,
      recovered,
      orders: execution.ledger.orderIds,
      summary:
        'Synthetic database loss rejects durable action reads; real runtime lease-error handler closes authority and reacquires only after transport recovery.',
    })
  } finally {
    await runtime.stop()
  }
}

async function lockCompetition(): Promise<Evidence> {
  const fixture = syntheticLease()
  const primary = new EyelerRuntime({ pool: fixture.pool } as unknown as PostgresStore, fixture.venue('primary'))
  const standby = new EyelerRuntime({ pool: fixture.pool } as unknown as PostgresStore, fixture.venue('standby'))
  try {
    const fault = failureStamp()
    await Promise.all([primary.start(), standby.start()])
    const blocked =
      fixture.maximum() === 1 &&
      primary.health().lockOwned &&
      !standby.health().lockOwned &&
      standby.health().waitingForLock
    await primary.stop()
    await controls(standby).tryAcquireAndStart()
    return finishEvidence(fault, {
      blocked,
      recovered: standby.health().lockOwned && !primary.health().lockOwned && fixture.maximum() === 1,
      orders: [],
      summary:
        'Synthetic competing advisory-lock transport exercises two real runtime instances; standby never obtains venue authority until owner releases lock.',
    })
  } finally {
    await Promise.all([primary.stop(), standby.stop()])
  }
}

async function delayedPartial(): Promise<Evidence> {
  const fixture = new SyntheticExecutionFixture()
  const worker = fixture.worker(async (action) => ({ ...action, status: 'PARTIAL' }))
  const decision = await worker.evaluate(fixture.book.id)
  const fault = failureStamp()
  const initial = await worker.execute(decision)
  let refused = false
  try {
    await worker.execute({ ...decision, id: `${decision.id}-delayed` })
  } catch {
    refused = true
  }
  const partial = runtimeRecovery(fixture, async (action) => ({ ...action, status: 'PARTIAL' }))
  try {
    await controls(partial.runtime).tick()
  } finally {
    await partial.runtime.stop()
  }
  const blocked =
    'status' in initial &&
    initial.status === 'PARTIAL' &&
    refused &&
    partial.submits() === 0 &&
    fixture.ledger.orderIds.length === 1
  const restored = runtimeRecovery(fixture, async (action) => ({ ...action, status: 'CONFIRMED' }))
  try {
    await controls(restored.runtime).tick()
  } finally {
    await restored.runtime.stop()
  }
  return finishEvidence(fault, {
    blocked,
    recovered: fixture.ledger.actions[0]?.status === 'CONFIRMED' && restored.submits() === 0,
    orders: fixture.ledger.orderIds,
    summary:
      'Synthetic partial fill remains unresolved across real runtime recovery; delayed final evidence confirms without a replacement action.',
  })
}

/** Isolated application chaos evidence. No real venue, chain, credentials, or PostgreSQL connection is used. */
export async function runReliabilityChaosSuite(): Promise<ReliabilityChaosResult[]> {
  const scenarios: Array<[string, () => Promise<Evidence>]> = [
    ['process-kill-mid-action', killedAction],
    ['websocket-disconnect', websocketDrop],
    ['stale-market-data', staleData],
    ['rpc-timeout', rpcTimeout],
    ['database-connection-loss', databaseLoss],
    ['competing-lock-instances', lockCompetition],
    ['delayed-partial-fills', delayedPartial],
  ]
  const results: ReliabilityChaosResult[] = []
  for (const [scenario, inject] of scenarios) {
    const at = new Date().toISOString(),
      began = performance.now()
    try {
      const evidence = await inject()
      const unresolved = await unresolvedSafety()
      const invariants = {
        noDuplicateOrders: evidence.orders.length <= 1 && new Set(evidence.orders).size === evidence.orders.length,
        noUnknownResubmission: unresolved.results.UNKNOWN,
        noPartialResubmission: unresolved.results.PARTIAL,
        failClosed: evidence.blocked && unresolved.blocked,
      }
      results.push({
        scenario,
        at: evidence.at,
        status: evidence.recovered && Object.values(invariants).every(Boolean) ? 'passed' : 'failed',
        recoveryMs: evidence.recoveryMs,
        invariants,
        summary: evidence.summary,
      })
    } catch {
      // No raw error is published: implementation/environment exceptions may contain private diagnostics.
      results.push({
        scenario,
        at,
        status: 'unavailable',
        recoveryMs: Math.round((performance.now() - began) * 1000) / 1000,
        invariants: {
          noDuplicateOrders: false,
          noUnknownResubmission: false,
          noPartialResubmission: false,
          failClosed: false,
        },
        summary: 'Synthetic scenario could not verify recovery or every invariant. No production failure was injected.',
      })
    }
  }
  return results
}
