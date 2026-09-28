import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { loadConfig, assertProductionConfig, logger, walletAccess } from './config/index.js'
import { KeelRuntime, type RuntimeVenue } from './runtime.js'
import { AuthService } from './auth.js'
import { MemoryStore } from './memoryStore.js'
import { NotificationStore } from './infrastructure/database/notification-store.js'
import { PostgresStore, UnconfiguredStore, type Store } from './infrastructure/database/postgres-store.js'
import { createPerplRuntime } from './infrastructure/perpl/runtime.js'
import { createPerplEnrollmentService, type PerplEnrollmentService } from './infrastructure/perpl/enrollment-service.js'
import { DeterministicTestRuntime } from './infrastructure/replay/test-runtime.js'
import { registerRoutes } from './interfaces/http/register.js'
import { installShutdownHandlers } from './shutdown.js'

export type ServerServices = {
  venue?: RuntimeVenue
  closeBook?: (userId: string, bookId: string) => Promise<{ actionId: string; status: string }>
  executeAction?: (userId: string, bookId: string, kind: 'DEFEND' | 'REDUCE') => Promise<{ actionId: string; status: string }>
  enrollment?: PerplEnrollmentService
}

export function createServer(store?: Store, services: ServerServices = {}) {
  const config = loadConfig(process.env)
  assertProductionConfig(config)
  // Venue authentication can wait for its 15-second snapshot deadline. Keep
  // HTTP startup alive so health remains available while trading fails closed.
  const app = Fastify({ logger: false, pluginTimeout: 30_000 })
  const persistence = store ?? (config.databaseUrl ? new PostgresStore(config.databaseUrl) : config.environment === 'test' ? new MemoryStore() : new UnconfiguredStore())
  const auth = new AuthService(persistence, config.sessionSecret, address => walletAccess(config, address))
  const notificationStore = persistence instanceof PostgresStore ? new NotificationStore(persistence.pool) : null
  const origins = new Set(config.corsOrigin.split(',').map(origin => origin.trim()).filter(Boolean))
  if (config.environment === 'test' || config.environment === 'development') for (const port of [8082, 8083]) { origins.add(`http://localhost:${port}`); origins.add(`http://127.0.0.1:${port}`) }
  void app.register(cors, { origin: config.environment === 'test' || config.environment === 'development' ? true : [...origins], credentials: true })
  void app.register(cookie, { secret: config.sessionSecret })
  void app.register(rateLimit, { max: 120, timeWindow: '1 minute' })
  const testRuntime = persistence instanceof MemoryStore && process.env.KEEL_TEST_VENUE === 'true' ? new DeterministicTestRuntime(persistence) : undefined
  let venue = services.venue ?? testRuntime?.venue
  if (!venue && persistence instanceof PostgresStore) {
    try { venue = createPerplRuntime(persistence) } catch (error) { logger.warn({ error: error instanceof Error ? error.message : 'PERPL_CONFIGURATION_INVALID' }, 'Perpl live adapter unavailable; readiness will fail closed') }
  }
  const runtime = persistence instanceof PostgresStore ? new KeelRuntime(persistence, venue, Date.now, config.safeModeResumeTicks) : undefined
  const enrollment = services.enrollment ?? (persistence instanceof PostgresStore ? createPerplEnrollmentService(persistence, config, process.env) : undefined)
  const closeBook = services.closeBook ?? (runtime ? runtime.closeBook.bind(runtime) : testRuntime ? testRuntime.closeBook.bind(testRuntime) : undefined)
  const executeAction = services.executeAction ?? (runtime ? runtime.executeAction.bind(runtime) : testRuntime ? testRuntime.executeAction.bind(testRuntime) : undefined)
  app.addHook('onReady', async () => { enrollment?.startCleanup(); await runtime?.start() })
  app.addHook('onClose', async () => { enrollment?.stopCleanup(); try { await runtime?.stop() } finally { if (persistence instanceof PostgresStore) await persistence.pool.end() } })
  registerRoutes({ app, config, persistence, auth, notificationStore, venue, runtime, closeBook, executeAction, testRuntime, enrollment })
  return app
}

export async function startServer() {
  const config = loadConfig(process.env)
  const app = createServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  installShutdownHandlers(app)
  logger.info({ port: config.port, environment: config.environment }, 'KEEL API listening')
  return app
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void startServer()


