import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { loadConfig, assertProductionConfig, brandEnv, logger, walletAccess } from './config/index.js'
import { EyelerRuntime, type RuntimeVenue } from './runtime.js'
import { AuthService } from './auth.js'
import { MemoryStore } from './memoryStore.js'
import { NotificationStore } from './infrastructure/database/notification-store.js'
import { PostgresStore, UnconfiguredStore, type Store } from './infrastructure/database/postgres-store.js'
import { createPerplRuntime } from './infrastructure/perpl/runtime.js'
import { PerplUserVenues } from './infrastructure/perpl/user-venues.js'
import { configuredKeyCustody } from './infrastructure/perpl/configured-key-custody.js'
import { discoverPerplAccount } from './infrastructure/perpl/account-discovery.js'
import { PerplHistory } from '../../packages/perpl/src/history.js'
import { Ed25519PerplSigner } from '../../packages/perpl/src/signer.js'
import { createPerplEnrollmentService, type PerplEnrollmentService } from './infrastructure/perpl/enrollment-service.js'
import { DeterministicTestRuntime } from './infrastructure/replay/test-runtime.js'
import { registerRoutes } from './interfaces/http/register.js'
import { installShutdownHandlers } from './shutdown.js'
import { createTelegramNotifier } from './infrastructure/telegram/notifier.js'
import { TelegramLinks } from './infrastructure/telegram/links.js'
import { createPublicCapital } from './infrastructure/capital/snapshot.js'
import { SnapshotRetention, snapshotRetentionConfig } from './infrastructure/database/snapshot-retention.js'

export type ServerServices = {
  venue?: RuntimeVenue
  closeBook?: (userId: string, bookId: string) => Promise<{ actionId: string; status: string }>
  executeAction?: (
    userId: string,
    bookId: string,
    kind: 'DEFEND' | 'REDUCE',
  ) => Promise<{ actionId: string; status: string }>
  enrollment?: PerplEnrollmentService
}

export function createServer(store?: Store, services: ServerServices = {}) {
  const config = loadConfig(process.env)
  assertProductionConfig(config)
  const custody = configuredKeyCustody(process.env, config.environment)
  // Venue authentication can wait for its 15-second snapshot deadline. Keep
  // HTTP startup alive so health remains available while trading fails closed.
  const app = Fastify({ logger: false, pluginTimeout: 30_000 })
  const persistence =
    store ??
    (config.databaseUrl
      ? new PostgresStore(config.databaseUrl)
      : config.environment === 'test'
        ? new MemoryStore()
        : new UnconfiguredStore())
  const auth = new AuthService(persistence, config.sessionSecret, (address) => walletAccess(config, address), {
    origin: new URL(brandEnv(process.env, 'APP_URL') ?? config.corsOrigin.split(',')[0].trim()).origin,
    chainId: config.perplChainId,
    environment: config.environment,
  })
  const notificationStore = persistence instanceof PostgresStore ? new NotificationStore(persistence.pool) : null
  const telegram =
    persistence instanceof PostgresStore && ['testnet', 'mainnet'].includes(config.environment)
      ? createTelegramNotifier(persistence.pool, process.env)
      : undefined
  const telegramLinks =
    persistence instanceof PostgresStore &&
    config.perplAccountMode === 'per-user' &&
    process.env.TELEGRAM_BOT_TOKEN &&
    process.env.TELEGRAM_BOT_USERNAME &&
    process.env.TELEGRAM_WEBHOOK_SECRET
      ? new TelegramLinks(persistence.pool, process.env.TELEGRAM_BOT_USERNAME, process.env.TELEGRAM_WEBHOOK_SECRET)
      : undefined
  const snapshotRetention =
    persistence instanceof PostgresStore
      ? new SnapshotRetention(persistence.pool, snapshotRetentionConfig(process.env))
      : undefined
  const origins = new Set(
    config.corsOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  origins.add('https://app.eyeler.xyz')
  if (process.env.ANALYTICS_CORS_ORIGIN) {
    const origin = new URL(process.env.ANALYTICS_CORS_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== process.env.ANALYTICS_CORS_ORIGIN)
      throw new Error('ANALYTICS_CORS_ORIGIN_INVALID')
    origins.add(origin.origin)
  }
  if (config.environment === 'test' || config.environment === 'development')
    for (const port of [8082, 8083]) {
      origins.add(`http://localhost:${port}`)
      origins.add(`http://127.0.0.1:${port}`)
    }
  void app.register(cors, {
    origin: config.environment === 'test' || config.environment === 'development' ? true : [...origins],
    credentials: true,
  })
  void app.register(cookie, { secret: config.sessionSecret })
  void app.register(rateLimit, { max: 120, timeWindow: '1 minute' })
  const testRuntime =
    persistence instanceof MemoryStore && brandEnv(process.env, 'TEST_VENUE') === 'true'
      ? new DeterministicTestRuntime(persistence)
      : undefined
  let venue = services.venue ?? testRuntime?.venue
  if (!venue && persistence instanceof PostgresStore) {
    try {
      venue =
        config.perplAccountMode === 'per-user'
          ? new PerplUserVenues(
              persistence,
              config.environment === 'mainnet' ? 'mainnet' : 'testnet',
              custody!,
              async (credentials) => {
                const scoped = createPerplRuntime(persistence, {
                  ...process.env,
                  PERPL_API_KEY: credentials.apiKey,
                  PERPL_API_KEY_SECRET: credentials.privateKey,
                  PERPL_ACCOUNT_ID: String(credentials.accountId),
                  MONAD_WALLET_ADDRESS: credentials.walletAddress,
                  EYELER_PERPL_CONNECTION_ID: credentials.connectionId,
                })
                if (!scoped) throw new Error('PERPL_CONNECTION_UNAVAILABLE')
                return scoped
              },
              64,
              async (credentials) => {
                const signer = new Ed25519PerplSigner(credentials.apiKey, credentials.privateKey, config.perplChainId)
                const history = new PerplHistory(config.perplRestUrl, signer)
                return discoverPerplAccount(await history.wallet(), credentials.walletAddress)
              },
            )
          : createPerplRuntime(persistence)
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : 'PERPL_CONFIGURATION_INVALID' },
        'Perpl live adapter unavailable; readiness will fail closed',
      )
    }
  }
  const runtime =
    persistence instanceof PostgresStore
      ? new EyelerRuntime(
          persistence,
          venue,
          Date.now,
          config.safeModeResumeTicks,
          config.environment === 'mainnet' ? 'mainnet' : config.environment === 'testnet' ? 'testnet' : undefined,
        )
      : undefined
  const enrollment =
    services.enrollment ??
    (persistence instanceof PostgresStore
      ? createPerplEnrollmentService(persistence, config, process.env, fetch, custody)
      : undefined)
  const closeBook =
    services.closeBook ??
    (runtime ? runtime.closeBook.bind(runtime) : testRuntime ? testRuntime.closeBook.bind(testRuntime) : undefined)
  const executeAction =
    services.executeAction ??
    (runtime
      ? runtime.executeAction.bind(runtime)
      : testRuntime
        ? testRuntime.executeAction.bind(testRuntime)
        : undefined)
  app.addHook('onReady', async () => {
    // Verify KMS before any worker or private venue starts. Failure aborts startup.
    await custody?.assertReady?.()
    enrollment?.startCleanup()
    await runtime?.start()
    telegram?.start()
    snapshotRetention?.start()
  })
  app.addHook('onClose', async () => {
    enrollment?.stopCleanup()
    await snapshotRetention?.stop()
    try {
      await runtime?.stop()
    } finally {
      try {
        await telegram?.stop()
      } finally {
        try {
          if (persistence instanceof PostgresStore) await persistence.pool.end()
        } finally {
          custody?.close?.()
        }
      }
    }
  })
  registerRoutes({
    app,
    config,
    persistence,
    auth,
    notificationStore,
    venue,
    runtime,
    closeBook,
    executeAction,
    testRuntime,
    enrollment,
    telegramLinks,
    publicCapital: createPublicCapital(persistence instanceof PostgresStore ? persistence : undefined, process.env),
  })
  return app
}

export async function startServer() {
  const config = loadConfig(process.env)
  const app = createServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  installShutdownHandlers(app)
  logger.info({ port: config.port, environment: config.environment }, 'EYELER API listening')
  return app
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void startServer()
