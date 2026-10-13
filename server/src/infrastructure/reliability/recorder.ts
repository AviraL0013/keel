import { randomUUID } from 'node:crypto'
import { subscribePerplReliability } from '../../../../packages/perpl/src/reliability-events.js'
import { executionDisabled } from '../../config/index.js'
import type { ReliabilityChaosResult } from '../../../../scripts/reliability/chaos.js'
import type { ReliabilityStore } from './store.js'

export type ReliabilityHealth = {
  running: boolean
  lastError?: string
  lastTickAgeMs: number | null
  lockOwned: boolean
  venueReady: boolean
}
export function tradingFlagStates(env: Record<string, string | undefined>): Record<string, boolean> {
  const states: Record<string, boolean> = { EYELER_EXECUTION_DISABLED: executionDisabled(env) }
  for (const name of [
    'EYELER_OPENING_ENABLED',
    'EYELER_STRATEGIES_ENABLED',
    'EYELER_STRATEGIES_LIVE_ENABLED',
    'EYELER_ANALYTICS_ENABLED',
    'EYELER_ANALYTICS_ROLLUPS_ENABLED',
    'EYELER_ANALYTICS_SNAPSHOTS_ENABLED',
    'EYELER_ANALYTICS_WALLET_ONDEMAND_ENABLED',
    'EYELER_ANALYTICS_WALLET_LEDGER_ENABLED',
  ])
    states[name] = env[name] === 'true'
  return states
}
type Options = {
  store: ReliabilityStore
  health(): ReliabilityHealth
  flags(): Record<string, boolean>
  /** Revoke transport authority first; this never starts or submits a trade. */
  pause(): Promise<void>
  restart(): Promise<void>
  chaos(): Promise<ReliabilityChaosResult[]>
  alerts?: {
    flush(runId: string): Promise<void>
    health(): Promise<{ configured: boolean; linkedRecipients: number; reason?: string }>
  }
  now?: () => number
  processId?: string
  intervalMs?: number
}
type QueuedEvent = { kind: string; at: number; streamId?: string }
type Snapshot = Awaited<ReturnType<ReliabilityStore['report']>>
const healthy = (health: ReliabilityHealth) =>
  health.running &&
  health.lastError === undefined &&
  health.lockOwned &&
  health.venueReady &&
  health.lastTickAgeMs !== null &&
  health.lastTickAgeMs <= 15000

/** Durable sampling and bounded schedules, independent of any order admission. */
export class ReliabilityRecorder {
  private timer?: ReturnType<typeof setInterval>
  private watchdog?: ReturnType<typeof setInterval>
  private pollStartedAt?: number
  private unsubscribe?: () => void
  private inFlight?: Promise<void>
  private readonly queue: QueuedEvent[] = []
  private readonly processId: string
  private readonly now: () => number
  private active = false
  private authorityRevoked = false
  private databaseFailedAt?: number
  private overflowAt?: number
  private unhealthySince?: number
  private restartRequested = false
  private cachedSnapshot?: { at: number; value: Snapshot }
  private snapshotTask?: Promise<Snapshot>
  constructor(private readonly options: Options) {
    this.processId = options.processId ?? randomUUID()
    this.now = options.now ?? Date.now
  }
  async start() {
    if (this.active) return
    const run = await this.options.store.ensureRun(this.now(), this.options.flags())
    if (!run || this.now() >= new Date(run.ends_at).getTime()) return
    this.active = true
    if (!this.flagsMatch(run.trading_states)) await this.failClosed('configuration', 'configuration_changed')
    this.unsubscribe = subscribePerplReliability((event) => {
      this.enqueue({ kind: event.kind, at: Date.parse(event.at), streamId: event.streamId })
    })
    this.lifecycle('worker_started')
    this.timer = setInterval(() => {
      void this.pollOnce()
    }, this.options.intervalMs ?? 15000)
    this.timer.unref()
    // Independent of the awaited database work: a stalled promise cannot keep
    // automatic transport authority alive. Persist its incident when storage returns.
    this.watchdog = setInterval(() => {
      if (
        this.active &&
        this.inFlight &&
        this.pollStartedAt !== undefined &&
        this.now() - this.pollStartedAt > 30000 &&
        !this.authorityRevoked
      ) {
        this.databaseFailedAt ??= this.now()
        void this.revokeAuthority()
      }
    }, 1000)
    this.watchdog.unref()
    if (run.automation_paused) await this.revokeAuthority()
  }
  lifecycle(kind: 'lock_acquired' | 'lock_released' | 'lock_lost' | 'worker_started' | 'worker_stopped') {
    if (this.active) this.enqueue({ kind, at: this.now() })
  }
  private enqueue(event: QueuedEvent) {
    if (this.queue.length < 2000) this.queue.push(event)
    else if (this.overflowAt === undefined) {
      this.overflowAt = this.now()
      void this.failClosed('telemetry-overflow', 'invariant_violation', this.overflowAt).catch(() => {
        this.databaseFailedAt ??= this.overflowAt
      })
    }
  }
  private flagsMatch(recorded: Record<string, boolean>) {
    const current = this.options.flags()
    return (
      Object.keys(current).every((name) => recorded[name] === current[name]) &&
      Object.keys(recorded).every((name) => Object.hasOwn(current, name))
    )
  }
  private async flushEvents() {
    while (this.queue.length) {
      const event = this.queue[0]
      await this.options.store.event(
        event.kind,
        event.streamId ?? this.processId,
        event.at,
        event.kind === 'lock_released' ? { clean: true } : undefined,
      )
      if (event.kind === 'websocket_disconnect' && event.streamId)
        await this.options.store.incident(`ws:${event.streamId}`, 'websocket_disconnect', 'mainnet', event.at)
      if ((event.kind === 'websocket_ready' || event.kind === 'websocket_reconnect') && event.streamId)
        await this.options.store.recover(`ws:${event.streamId}`, event.at)
      if (event.kind === 'lock_lost') await this.options.store.incident('lock', 'lock_lost', 'mainnet', event.at)
      if (event.kind === 'lock_acquired') await this.options.store.recover('lock', event.at)
      this.queue.shift()
    }
  }
  private async revokeAuthority() {
    if (this.authorityRevoked) return
    this.authorityRevoked = true
    await this.options.pause().catch(() => {})
  }
  private async failClosed(key: string, kind: string, at = this.now()) {
    await this.revokeAuthority()
    await this.options.store.incident(key, kind, 'mainnet', at)
    await this.options.store.pause(at)
  }
  pollOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.pollStartedAt = this.now()
    this.inFlight = this.poll().finally(() => {
      this.inFlight = undefined
      this.pollStartedAt = undefined
    })
    return this.inFlight
  }
  private async poll() {
    if (!this.active || this.restartRequested) return
    const now = this.now()
    try {
      await this.flushEvents()
      const run = await this.options.store.run()
      if (!run) return
      if (this.overflowAt !== undefined) {
        await this.failClosed('telemetry-overflow', 'invariant_violation', this.overflowAt)
        this.overflowAt = undefined
      }
      if (this.databaseFailedAt !== undefined) {
        await this.failClosed('database', 'database_unavailable', this.databaseFailedAt)
        await this.options.store.recover('database', now)
        this.databaseFailedAt = undefined
      }
      if (!this.flagsMatch(run.trading_states)) await this.failClosed('configuration', 'configuration_changed')
      const health = this.options.health()
      await this.options.store.sample(this.processId, health, now)
      if (this.now() >= new Date(run.ends_at).getTime()) {
        await this.options.store.complete(now)
        this.active = false
        if (this.timer) clearInterval(this.timer)
        if (this.watchdog) clearInterval(this.watchdog)
        this.unsubscribe?.()
        return
      }
      if (!healthy(health)) {
        this.unhealthySince ??= now
        await this.options.store.incident('worker', 'worker_unavailable', 'mainnet', now)
        if (now - this.unhealthySince > 180000)
          await this.failClosed('worker-timeout', 'invariant_violation', this.unhealthySince)
      } else {
        this.unhealthySince = undefined
        await this.options.store.recover('worker', now)
      }
      if (run.restarts_claimed > 0) {
        const recovery = await this.options.store.restartRecovery(
          run.restarts_claimed,
          this.processId,
          now,
          healthy(health),
        )
        if (recovery === 'violated') await this.failClosed('restart-timeout', 'restart_recovery_timeout')
      }
      await this.options.store.ingestBookIncidents(now)
      const report = await this.options.store.report(now)
      if (report && Number(report.books?.duplicateActions ?? 0) > 0)
        await this.failClosed('duplicate', 'duplicate_action')
      if (await this.options.store.claimChaos(now)) {
        await this.options.store.event('chaos_started', this.processId, now, undefined, 'sandbox')
        const results = await this.options.chaos()
        await this.options.store.saveChaos(results, now)
        await this.options.store.event('chaos_completed', this.processId, this.now(), undefined, 'sandbox')
        if (
          results.some(
            (result) =>
              result.status === 'failed' ||
              (result.status === 'passed' && !Object.values(result.invariants).every(Boolean)),
          )
        )
          await this.failClosed('chaos-invariant', 'invariant_violation')
      }
      await this.options.alerts?.flush(run.id)
      if (!this.authorityRevoked && healthy(this.options.health())) {
        const due = await this.options.store.claimRestart(now, this.processId)
        if (due) {
          this.restartRequested = true
          if (this.timer) clearInterval(this.timer)
          // Closing waits for this poll in onClose, so the callback must run after it resolves.
          setTimeout(() => {
            void this.options.restart().catch(() => {
              this.restartRequested = false
            })
          }, 100)
        }
      }
    } catch {
      this.databaseFailedAt ??= now
      await this.revokeAuthority()
    }
  }
  async beforeBookSend(actionId: string) {
    if (!this.active && !this.authorityRevoked) return
    try {
      if (this.authorityRevoked) throw Error('RELIABILITY_AUTOMATION_PAUSED')
      const run = await this.options.store.run()
      if (run && this.now() >= new Date(run.ends_at).getTime() && !this.authorityRevoked) return
      if (run && !this.flagsMatch(run.trading_states)) {
        await this.failClosed('configuration', 'configuration_changed')
        throw Error('RELIABILITY_AUTOMATION_PAUSED')
      }
      await this.options.store.recordBookSend(actionId, this.now())
    } catch (error) {
      const kinds: Record<string, string> = {
        RELIABILITY_UNKNOWN_RESUBMISSION: 'unknown_resubmission',
        RELIABILITY_PARTIAL_RESUBMISSION: 'partial_resubmission',
        RELIABILITY_DUPLICATE_SEND: 'duplicate_action',
      }
      const code = error instanceof Error ? error.message : ''
      await this.failClosed('book-send', kinds[code] ?? 'invariant_violation')
      throw new Error('RELIABILITY_SUBMISSION_BLOCKED')
    }
  }
  async report() {
    const now = this.now()
    let report: Snapshot
    if (this.cachedSnapshot && now - this.cachedSnapshot.at < 5000) report = this.cachedSnapshot.value
    else {
      this.snapshotTask ??= this.options.store
        .report(now)
        .then((value) => {
          this.cachedSnapshot = { at: now, value }
          return value
        })
        .finally(() => {
          this.snapshotTask = undefined
        })
      report = await this.snapshotTask
    }
    if (!report)
      return {
        version: 1,
        run: null,
        observedAt: new Date(this.now()).toISOString(),
        limitations: ['The run has not started.'],
      }
    const alerts = await this.options.alerts?.health()
    const health = this.options.health()
    const limitations = [...report.limitations]
    if (!alerts?.configured)
      limitations.push('Owner Telegram alerts are unavailable until an active owner link is configured.')
    return {
      ...report,
      availability: { ...report.availability, workerTickAgeMs: health.lastTickAgeMs, lockOwned: health.lockOwned },
      alerts: alerts ?? { configured: false, linkedRecipients: 0, reason: 'Alerts are unavailable.' },
      limitations,
    }
  }
  async incidentPage(cursor?: string) {
    return this.options.store.incidentPage(cursor)
  }
  async stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.watchdog) clearInterval(this.watchdog)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.inFlight
    if (this.active) {
      this.lifecycle('worker_stopped')
      await this.flushEvents().catch(() => {})
    }
    this.active = false
  }
}
