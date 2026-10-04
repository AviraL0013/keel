import { describe, expect, it, vi } from 'vitest'
import { EyelerRuntime, type RuntimeVenue } from '../server/src/runtime.js'
import type { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'

type Client = {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function client(tryLock: () => boolean, releaseLock: () => void): Client {
  const value = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ owned: tryLock() }] }
      if (sql.includes('pg_advisory_unlock')) {
        releaseLock()
        return { rows: [] }
      }
      return { rows: [] }
    }),
    release: vi.fn(),
    on: vi.fn(),
  }
  return value
}

function venue() {
  return {
    start: vi.fn(async () => undefined),
    ready: () => true,
    close: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    submit: vi.fn(),
    reconcile: vi.fn(),
  } as unknown as RuntimeVenue
}

describe('runtime standby lock handover', () => {
  it('starts healthy in standby, does not touch the venue, and acquires the lock on retry', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const value = venue()
      const pool = {
        connect: vi.fn(async () =>
          client(
            () => ++attempts > 1,
            () => undefined,
          ),
        ),
        query: vi.fn(async () => ({ rows: [] })),
      }
      const runtime = new EyelerRuntime({ pool } as unknown as PostgresStore, value)
      await runtime.start()
      expect(value.start).not.toHaveBeenCalled()
      expect(runtime.health()).toMatchObject({ waitingForLock: true, lockOwned: false, running: false })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(value.start).toHaveBeenCalledOnce()
      expect(runtime.health()).toMatchObject({ waitingForLock: false, lockOwned: true, running: true })
      await runtime.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the lock to a standby instance after graceful shutdown', async () => {
    vi.useFakeTimers()
    try {
      let owner: string | undefined
      const pool = {
        connect: vi.fn(async () => {
          const name = owner ? 'standby' : 'primary'
          return client(
            () => {
              if (owner) return owner === name
              owner = name
              return true
            },
            () => {
              if (owner === name) owner = undefined
            },
          )
        }),
        query: vi.fn(async () => ({ rows: [] })),
      }
      const primaryVenue = venue()
      const standbyVenue = venue()
      const primary = new EyelerRuntime({ pool } as unknown as PostgresStore, primaryVenue)
      const standby = new EyelerRuntime({ pool } as unknown as PostgresStore, standbyVenue)
      await primary.start()
      await standby.start()
      expect(standbyVenue.start).not.toHaveBeenCalled()
      expect(standby.health()).toMatchObject({ waitingForLock: true, lockOwned: false, running: false })
      await primary.stop()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(standbyVenue.start).toHaveBeenCalledOnce()
      expect(standby.health()).toMatchObject({ waitingForLock: false, lockOwned: true, running: true })
      await standby.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
