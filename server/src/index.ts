import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { loadConfig, assertProductionConfig, logger } from './config/index.js'
import { KeelRuntime, type RuntimeVenue } from './runtime.js'
import { AuthService } from './auth.js'
import { MemoryStore } from './memoryStore.js'
import { NotificationStore } from './infrastructure/database/notification-store.js'
import { PostgresStore, UnconfiguredStore, type Store } from './infrastructure/database/postgres-store.js'
import { createPerplRuntime } from './infrastructure/perpl/runtime.js'
import { DeterministicTestRuntime } from './infrastructure/replay/test-runtime.js'
import { registerRoutes } from './interfaces/http/register.js'

export type ServerServices = {
  venue?: RuntimeVenue
  closeBook?: (userId: string, bookId: string) => Promise<{ actionId: string; status: string }>
  executeAction?: (userId: string, bookId: string, kind: 'DEFEND' | 'REDUCE') => Promise<{ actionId: string; status: string }>
}

export function createServer(store?: Store, services: ServerServices = {}) {
  const config = loadConfig(process.env)
  assertProductionConfig(config)
  const app = Fastify({ logger: false })
  const persistence = store ?? (config.databaseUrl ? new PostgresStore(config.databaseUrl) : config.environment === 'test' ? new MemoryStore() : new UnconfiguredStore())
  const auth = new AuthService(persistence, config.sessionSecret)
  const notificationStore = persistence instanceof PostgresStore ? new NotificationStore(persistence.pool) : null
  const origins = new Set(config.corsOrigin.split(',').map(origin => origin.trim()).filter(Boolean))
  if (config.environment !== 'mainnet') for (const port of [8082, 8083]) { origins.add(`http://localhost:${port}`); origins.add(`http://127.0.0.1:${port}`) }
  void app.register(cors, { origin: config.environment === 'mainnet' ? [...origins] : true, credentials: true })
  void app.register(cookie, { secret: config.sessionSecret })
  void app.register(rateLimit, { max: 120, timeWindow: '1 minute' })
  const testRuntime = persistence instanceof MemoryStore && process.env.KEEL_TEST_VENUE === 'true' ? new DeterministicTestRuntime(persistence) : undefined
  let venue = services.venue ?? testRuntime?.venue
  if (!venue && persistence instanceof PostgresStore) {
    try { venue = createPerplRuntime(persistence) } catch (error) { logger.warn({ error: error instanceof Error ? error.message : 'PERPL_CONFIGURATION_INVALID' }, 'Perpl live adapter unavailable; readiness will fail closed') }
  }
  const runtime = persistence instanceof PostgresStore ? new KeelRuntime(persistence, venue) : undefined
  const closeBook = services.closeBook ?? (runtime ? runtime.closeBook.bind(runtime) : testRuntime ? testRuntime.closeBook.bind(testRuntime) : undefined)
  const executeAction = services.executeAction ?? (runtime ? runtime.executeAction.bind(runtime) : testRuntime ? testRuntime.executeAction.bind(testRuntime) : undefined)
  app.addHook('onReady', async () => { await runtime?.start() })
  app.addHook('onClose', async () => { await runtime?.stop(); if (persistence instanceof PostgresStore) await persistence.pool.end() })
  registerRoutes({ app, config, persistence, auth, notificationStore, venue, runtime, closeBook, executeAction, testRuntime })
  return app
}

export async function startServer() {
  const config = loadConfig(process.env)
  const app = createServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  return app
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void startServer()


