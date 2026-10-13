import { describe, expect, it, vi } from 'vitest'
import { ReliabilityRecorder, tradingFlagStates } from '../server/src/infrastructure/reliability/recorder.js'

function fixture() {
  let now = Date.parse('2026-10-14T00:00:00Z')
  const flags = tradingFlagStates({ EYELER_EXECUTION_DISABLED: 'false', EYELER_STRATEGIES_LIVE_ENABLED: 'false' })
  const run = {
    id: 'run',
    started_at: new Date(now),
    ends_at: new Date(now + 7 * 86400000),
    status: 'RUNNING',
    restarts_claimed: 0,
    automation_paused: false,
    trading_states: flags,
  }
  const store = {
    ensureRun: vi.fn(async () => run),
    run: vi.fn(async () => run),
    event: vi.fn(async () => {}),
    sample: vi.fn(async () => {}),
    incident: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    pause: vi.fn(async () => {
      run.automation_paused = true
    }),
    complete: vi.fn(async () => {}),
    claimRestart: vi.fn(async (_now: number, _processId?: string) => null as { index: number } | null),
    claimChaos: vi.fn(async () => false),
    saveChaos: vi.fn(async () => {}),
    restartRecovery: vi.fn(async () => 'pending'),
    report: vi.fn(async () => ({ books: { duplicateActions: 0 }, limitations: [] })),
    ingestBookIncidents: vi.fn(async () => {}),
    recordBookSend: vi.fn(async () => {}),
  }
  const health = { running: true, lastTickAgeMs: 100, lockOwned: true, venueReady: true }
  const pause = vi.fn(async () => {})
  const restart = vi.fn(async () => {})
  const chaos = vi.fn(async () => [])
  const recorder = new ReliabilityRecorder({
    store: store as never,
    health: () => health,
    flags: () => flags,
    pause,
    restart,
    chaos,
    processId: '00000000-0000-4000-8000-000000000001',
    now: () => now,
    intervalMs: 86400000,
  })
  return {
    store,
    run,
    health,
    pause,
    restart,
    chaos,
    recorder,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('seven-day recorder scheduling and fail-closed behavior', () => {
  it('coalesces polls and never starts or submits a trade', async () => {
    const f = fixture()
    await f.recorder.start()
    await Promise.all([f.recorder.pollOnce(), f.recorder.pollOnce()])
    expect(f.store.sample).toHaveBeenCalledTimes(1)
    expect(f.pause).not.toHaveBeenCalled()
    expect(f.restart).not.toHaveBeenCalled()
    await f.recorder.stop()
  })
  it('fences changed flags before startup can grant worker authority', async () => {
    const f = fixture()
    f.run.trading_states = { ...f.run.trading_states, EYELER_EXECUTION_DISABLED: true }
    await f.recorder.start()
    expect(f.pause).toHaveBeenCalledTimes(1)
    expect(f.store.pause).toHaveBeenCalled()
    expect(f.store.incident).toHaveBeenCalledWith(
      'configuration',
      'configuration_changed',
      'mainnet',
      expect.any(Number),
    )
    await f.recorder.stop()
  })
  it('persists a pause after bounded telemetry overflow instead of leaving a volatile-only latch', async () => {
    const f = fixture()
    await f.recorder.start()
    for (let i = 0; i < 2001; i++) f.recorder.lifecycle('lock_lost')
    await f.recorder.pollOnce()
    expect(f.pause).toHaveBeenCalledTimes(1)
    expect(f.store.pause).toHaveBeenCalled()
    expect(f.store.incident).toHaveBeenCalledWith(
      'telemetry-overflow',
      'invariant_violation',
      'mainnet',
      expect.any(Number),
    )
    await f.recorder.stop()
  })
  it('queues the restart after poll resolves; stop cannot deadlock', async () => {
    const f = fixture()
    f.store.claimRestart.mockResolvedValueOnce({ index: 1 })
    f.restart.mockImplementation(async () => {
      await f.recorder.stop()
    })
    await f.recorder.start()
    await f.recorder.pollOnce()
    expect(f.restart).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(f.restart).toHaveBeenCalledTimes(1)
    expect(f.store.claimRestart).toHaveBeenCalledWith(expect.any(Number), '00000000-0000-4000-8000-000000000001')
  })
  it('refuses a send when authority is revoked during asynchronous admission', async () => {
    const f = fixture()
    let release!: () => void
    let entered!: () => void
    const enteredSend = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.store.recordBookSend.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await f.recorder.start()
    const sending = f.recorder.beforeBookSend('00000000-0000-4000-8000-000000000003')
    await enteredSend
    f.store.sample.mockRejectedValueOnce(Error('fixture failure'))
    await f.recorder.pollOnce()
    expect(f.pause).toHaveBeenCalledTimes(1)
    release()
    await expect(sending).rejects.toThrow('RELIABILITY_SUBMISSION_BLOCKED')
    await f.recorder.stop()
  })
  it('revokes authority immediately after observation storage fails, then persists the pause on recovery', async () => {
    const f = fixture()
    f.store.sample.mockRejectedValueOnce(Error('secret value must not be published'))
    await f.recorder.start()
    await f.recorder.pollOnce()
    expect(f.pause).toHaveBeenCalledTimes(1)
    f.advance(15000)
    await f.recorder.pollOnce()
    expect(f.store.incident).toHaveBeenCalledWith('database', 'database_unavailable', 'mainnet', expect.any(Number))
    expect(f.store.pause).toHaveBeenCalled()
    await f.recorder.stop()
  })
  it('revokes authority when storage stalls without rejecting, then records the outage after recovery', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let release!: () => void
    let entered!: () => void
    const enteredSample = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.store.sample.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    try {
      await f.recorder.start()
      const polling = f.recorder.pollOnce()
      await enteredSample
      f.advance(30001)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.pause).toHaveBeenCalledTimes(1)
      release()
      await polling
      await f.recorder.pollOnce()
      expect(f.store.incident).toHaveBeenCalledWith('database', 'database_unavailable', 'mainnet', expect.any(Number))
      expect(f.store.pause).toHaveBeenCalled()
    } finally {
      release?.()
      await f.recorder.stop()
      vi.useRealTimers()
    }
  })
  it('does not turn unavailable chaos proof into a successful test', async () => {
    const f = fixture()
    f.store.claimChaos.mockResolvedValueOnce(true)
    f.chaos.mockResolvedValue([
      {
        scenario: 'rpc-timeout',
        at: new Date().toISOString(),
        status: 'unavailable',
        recoveryMs: null,
        invariants: {
          noDuplicateOrders: null,
          noUnknownResubmission: null,
          noPartialResubmission: null,
          failClosed: null,
        },
      },
    ] as never)
    await f.recorder.start()
    await f.recorder.pollOnce()
    expect(f.store.saveChaos).toHaveBeenCalled()
    expect(f.pause).not.toHaveBeenCalled()
    await f.recorder.stop()
  })
  it('pauses when a measured invariant fails without changing environment flags', async () => {
    const f = fixture()
    f.store.claimChaos.mockResolvedValueOnce(true)
    f.chaos.mockResolvedValue([
      {
        scenario: 'lock-contention',
        at: new Date().toISOString(),
        status: 'failed',
        recoveryMs: 1,
        invariants: {
          noDuplicateOrders: false,
          noUnknownResubmission: true,
          noPartialResubmission: true,
          failClosed: false,
        },
      },
    ] as never)
    await f.recorder.start()
    await f.recorder.pollOnce()
    expect(f.pause).toHaveBeenCalledTimes(1)
    expect(f.store.pause).toHaveBeenCalled()
    expect(f.run.trading_states.EYELER_EXECUTION_DISABLED).toBe(false)
    await f.recorder.stop()
  })
})
