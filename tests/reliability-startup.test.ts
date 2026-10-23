import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from '../server/src/index.js'
import { EyelerRuntime, type RuntimeVenue } from '../server/src/runtime.js'
import { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'
import { ReliabilityStore } from '../server/src/infrastructure/reliability/store.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('serves HTTP and the original completed report without starting a paused private runtime', async () => {
  const env = {
    NODE_ENV: 'production',
    EYELER_ENV: 'mainnet',
    EYELER_PERPL_ACCOUNT_MODE: 'per-user',
    EYELER_ACCESS_MODE: 'allowlist',
    EYELER_ALLOWED_WALLETS: '0x1111111111111111111111111111111111111111',
    DATABASE_URL: 'postgres://unused/test',
    SESSION_SECRET: 'unit-test-only',
    CORS_ORIGIN: 'https://app.eyeler.xyz',
    PERPL_ENROLLMENT_ORIGIN: 'https://app.eyeler.xyz',
    PERPL_REST_URL: 'https://app.perpl.xyz/api',
    PERPL_WS_URL: 'wss://app.perpl.xyz',
    PERPL_CHAIN_ID: '143',
    MONAD_CHAIN_ID: '143',
    MONAD_RPC_URL: 'https://rpc.monad.xyz',
    AUSD_TOKEN_ADDRESS: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    EYELER_BUILDER_ID: '25',
    EYELER_MAX_BUILDER_FEE_PER_100K: '0',
    EYELER_KEY_CUSTODY: 'railway-allowlist-demo',
    EYELER_DEMO_CUSTODY_KEYS: JSON.stringify({ v1: '11'.repeat(32) }),
    EYELER_DEMO_CUSTODY_ACTIVE_VERSION: 'v1',
    EYELER_EXECUTION_DISABLED: 'false',
    EYELER_OPENING_ENABLED: 'false',
    EYELER_STRATEGIES_ENABLED: 'false',
    EYELER_ANALYTICS_ROLLUPS_ENABLED: 'false',
    EYELER_ANALYTICS_SNAPSHOTS_ENABLED: 'false',
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  const report = {
    version: 1,
    run: {
      startedAt: '2020-01-01T00:00:00.000Z',
      endsAt: '2020-01-08T00:00:00.000Z',
      status: 'completed',
    },
    availability: { observedSeconds: 15 },
    limitations: [],
  }
  vi.spyOn(ReliabilityStore.prototype, 'ensureRun').mockResolvedValue({
    started_at: new Date(report.run.startedAt),
    ends_at: new Date(report.run.endsAt),
    status: 'COMPLETED',
    automation_paused: true,
  } as never)
  vi.spyOn(ReliabilityStore.prototype, 'report').mockResolvedValue(report as never)
  const sample = vi.spyOn(ReliabilityStore.prototype, 'sample')
  const start = vi.spyOn(EyelerRuntime.prototype, 'start').mockResolvedValue(undefined)
  const venue = { start: vi.fn(), ready: () => false, close: vi.fn(async () => {}) }
  const connect = vi.fn()
  const store = Object.assign(Object.create(PostgresStore.prototype) as PostgresStore, {
    pool: {
      query: async () => ({ rows: [{ '?column?': 1 }] }),
      connect,
      end: async () => {},
    },
  })
  const app = createServer(store, { venue: venue as unknown as RuntimeVenue })
  try {
    await app.ready()
    expect(start).not.toHaveBeenCalled()
    expect(venue.start).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(sample).not.toHaveBeenCalled()
    expect((await app.inject('/health')).statusCode).toBe(200)
    const status = await app.inject('/status.json')
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ run: report.run, availability: { observedSeconds: 15, lockOwned: false } })
    const ready = await app.inject('/ready')
    expect(ready.statusCode).toBe(503)
    expect(ready.json()).toMatchObject({
      ready: false,
      reason: 'WORKER_OR_VENUE_UNAVAILABLE',
      lockOwned: false,
      venueReady: false,
      worker: { running: false },
    })
    expect(process.env.EYELER_EXECUTION_DISABLED).toBe('false')
  } finally {
    await app.close()
  }
})
