import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { MonitorScheduler } from '../server/src/lifecycle.js'
import { registerRoutes } from '../server/src/interfaces/http/register.js'
import { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'
import { loadConfig } from '../packages/shared/src/index.js'
import type { AuthService } from '../server/src/auth.js'
import type { EyelerRuntime } from '../server/src/runtime.js'

describe('monitor readiness', () => {
  it('ages a running but hung tick using an injected clock', async () => {
    let now = 1_000
    let finish!: () => void
    const tick = new Promise<void>((resolve) => {
      finish = resolve
    })
    const scheduler = new MonitorScheduler(
      { tick: () => tick },
      1_000,
      () => undefined,
      () => now,
    )
    scheduler.start()
    expect(scheduler.health().lastTickAgeMs).toBe(0)
    now += 15_001
    expect(scheduler.health().lastTickAgeMs).toBe(15_001)
    finish()
    await scheduler.stop()
    expect(scheduler.health().lastTickAgeMs).toBe(0)
  })

  it('accepts the previous setting name and rejects invalid thresholds', () => {
    expect(loadConfig({ KEEL_TICK_STALE_MS: '20000' }).tickStaleMs).toBe(20_000)
    expect(() => loadConfig({ EYELER_TICK_STALE_MS: '0' })).toThrow('INVALID_EYELER_TICK_STALE_MS')
  })

  it('returns 503 with tick age, venue readiness, and lock ownership', async () => {
    const app = Fastify()
    const store = Object.assign(Object.create(PostgresStore.prototype) as PostgresStore, {
      pool: { query: async () => ({ rows: [{ '?column?': 1 }] }) },
    })
    registerRoutes({
      app,
      config: loadConfig({ EYELER_ENV: 'test' }),
      persistence: store,
      auth: {} as AuthService,
      notificationStore: null,
      runtime: {
        health: () => ({
          running: true,
          executionReady: true,
          lastTickAgeMs: 15_001,
          venueReady: true,
          lockOwned: true,
        }),
      } as EyelerRuntime,
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/ready' })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({
        ready: false,
        reason: 'MONITOR_TICK_STALE',
        lastTickAgeMs: 15_001,
        venueReady: true,
        lockOwned: true,
      })
    } finally {
      await app.close()
    }
  })
})
