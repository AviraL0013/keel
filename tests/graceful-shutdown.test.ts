import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { EyelerRuntime } from '../server/src/runtime.js'
import { createServer } from '../server/src/index.js'
import { installShutdownHandlers, shutdownServer } from '../server/src/shutdown.js'
import { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'
import { logger } from '../server/src/config/index.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import * as rollups from '../server/src/workers/analytics-rollups.js'

describe('graceful shutdown', () => {
  it('drains an in-flight tick before closing Perpl and releasing the advisory lock', async () => {
    const events: string[] = []
    let finishTick!: () => void
    const tick = new Promise<void>((resolve) => {
      finishTick = resolve
    })
    const venue = {
      close: async () => {
        events.push('close-venue')
      },
    } as RuntimeVenue
    const runtime = new EyelerRuntime({ pool: {} } as PostgresStore, venue)
    Object.assign(runtime, {
      scheduler: {
        stop: async () => {
          events.push('stop-monitor')
          await tick
          events.push('tick-finished')
        },
      },
      lease: {
        query: async () => {
          events.push('unlock')
          return { rows: [{ pg_advisory_unlock: true }] }
        },
        release: () => {
          events.push('release-lease')
        },
      },
    })
    const stopping = runtime.stop()
    await Promise.resolve()
    expect(events).toEqual(['stop-monitor'])
    finishTick()
    await stopping
    expect(events).toEqual(['stop-monitor', 'tick-finished', 'close-venue', 'unlock', 'release-lease'])
  })

  it('SIGTERM closes the server once and waits for shutdown', async () => {
    const signals = new EventEmitter()
    let finish!: () => void
    const closing = new Promise<void>((resolve) => {
      finish = resolve
    })
    const close = vi.fn(() => closing)
    const detach = installShutdownHandlers({ close }, signals, 1000, vi.fn())
    signals.emit('SIGTERM')
    signals.emit('SIGINT')
    expect(close).toHaveBeenCalledTimes(1)
    finish()
    await detach()
  })

  it('logs completion only after the server has closed', async () => {
    const signals = new EventEmitter()
    let finish!: () => void
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const detach = installShutdownHandlers({ close }, signals)
      signals.emit('SIGTERM')
      expect(info).not.toHaveBeenCalledWith({}, 'EYELER shutdown complete')
      finish()
      await detach()
      expect(info).toHaveBeenCalledWith({}, 'EYELER shutdown complete')
    } finally {
      info.mockRestore()
    }
  })

  it('closes the worker before ending the Postgres pool', async () => {
    const events: string[] = []
    const start = vi.spyOn(EyelerRuntime.prototype, 'start').mockResolvedValue(undefined)
    const stop = vi.spyOn(EyelerRuntime.prototype, 'stop').mockImplementation(async () => {
      events.push('stop-worker')
    })
    const store = Object.assign(Object.create(PostgresStore.prototype) as PostgresStore, {
      pool: {
        end: async () => {
          events.push('end-pool')
        },
      },
    })
    const app = createServer(store, { venue: { ready: () => false, close: async () => undefined } as RuntimeVenue })
    try {
      await app.ready()
      await app.close()
      expect(events).toEqual(['stop-worker', 'end-pool'])
    } finally {
      start.mockRestore()
      stop.mockRestore()
    }
  })

  it('releases trading authority before waiting for stalled analytics cleanup', async () => {
    const events: string[] = []
    let finish!: () => void
    let entered!: () => void
    const enteredAnalytics = new Promise<void>((resolve) => {
      entered = resolve
    })
    const start = vi.spyOn(EyelerRuntime.prototype, 'start').mockResolvedValue(undefined)
    const stop = vi.spyOn(EyelerRuntime.prototype, 'stop').mockImplementation(async () => {
      events.push('stop-worker')
    })
    const collector = vi.spyOn(rollups, 'startAnalyticsRollups').mockReturnValue({
      stop: async () => {
        events.push('stop-analytics')
        entered()
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
    } as never)
    const store = Object.assign(Object.create(PostgresStore.prototype) as PostgresStore, {
      pool: {
        end: async () => {
          events.push('end-pool')
        },
      },
    })
    const app = createServer(store, { venue: { ready: () => false, close: async () => undefined } as RuntimeVenue })
    let closing: Promise<void> | undefined
    try {
      await app.ready()
      closing = app.close()
      await enteredAnalytics
      expect(events).toEqual(['stop-worker', 'stop-analytics'])
    } finally {
      finish?.()
      await closing
      start.mockRestore()
      stop.mockRestore()
      collector.mockRestore()
    }
    expect(events).toEqual(['stop-worker', 'stop-analytics', 'end-pool'])
  })

  it('stops waiting at the shutdown deadline', async () => {
    vi.useFakeTimers()
    try {
      const forceExit = vi.fn()
      const closing = expect(
        shutdownServer({ close: () => new Promise<void>(() => undefined) }, 5000, forceExit),
      ).rejects.toThrow('SHUTDOWN_TIMEOUT')
      await vi.advanceTimersByTimeAsync(5000)
      await closing
      expect(forceExit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
