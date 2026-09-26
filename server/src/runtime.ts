import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { Book, BookCreationReadiness, CapitalSnapshot, Decision, BookPositionSeed, BookTelemetrySeed } from '../../packages/domain/src/index.js'
import { evaluate, evaluateManualAction, telemetryFreshnessFailures } from '../../packages/risk-engine/src/index.js'
import type { VenueAdapter } from '../../packages/perpl/src/index.js'
import { PostgresStore } from './infrastructure/database/postgres-store.js'
import { PostgresExecutionRepository } from './infrastructure/database/execution-repository.js'
import { ExecutionWorker } from './workers/execution-worker.js'
import { MonitorScheduler } from './lifecycle.js'
import { PolicyRejectedError } from './application/errors.js'
import { logger } from './config/index.js'

export type RuntimeVenue = Pick<VenueAdapter, 'submit' | 'reconcile'> & {
  accountId?: number
  validate?(): Promise<'VALID' | 'INVALID' | 'UNAVAILABLE'>
  loadBookSetup?(marketId: number, accountId: number, positionId: number): Promise<{ market: string; position: BookPositionSeed; telemetry: BookTelemetrySeed; reserveAvailable: number }>
  listPositions?(): Promise<Array<{ marketId: number; market: string; accountId: number; positionId: number; position: BookPositionSeed; telemetry?: BookTelemetrySeed; bookCreation: BookCreationReadiness }>>
  capital?(walletAddress?: string): Promise<CapitalSnapshot>
  start?(): Promise<void>
  refresh(book: Book): Promise<void>
  close(): Promise<void>
  ready(): boolean
}

/** A single PostgreSQL advisory-lock owner drives persisted Books. */
export class KeelRuntime {
  private readonly repository: PostgresExecutionRepository
  private readonly scheduler: MonitorScheduler
  private readonly reconciliationSchedule = new Map<string, { nextAt: number; rateLimitFailures: number }>()
  private lease?: PoolClient
  constructor(private readonly store: PostgresStore, private readonly venue?: RuntimeVenue) {
    this.repository = new PostgresExecutionRepository(store)
    this.scheduler = new MonitorScheduler({ tick: () => this.tick() }, 1000)
  }
  async start() {
    await this.venue?.start?.()
    this.lease = await this.store.pool.connect()
    const result = await this.lease.query('SELECT pg_try_advisory_lock(187471,1) AS owned')
    if (!result.rows[0].owned) { this.lease.release(); this.lease = undefined; throw new Error('WORKER_ALREADY_RUNNING') }
    this.lease.on('error', () => { void this.scheduler.stop(); this.lease = undefined })
    this.scheduler.start()
  }
  health() { return { ...this.scheduler.health(), executionReady: Boolean(this.lease && this.venue?.ready()) } }
  async stop() {
    await this.scheduler.stop()
    await this.venue?.close()
    if (this.lease) { await this.lease.query('SELECT pg_advisory_unlock(187471,1)'); this.lease.release(); this.lease = undefined }
  }
  private async tick() {
    if (!this.lease) return
    await this.lease.query('SELECT 1')
    const rows = await this.store.pool.query("SELECT b.id,b.user_id FROM books b WHERE (b.automation_enabled AND b.status!='CLOSED') OR EXISTS (SELECT 1 FROM actions a WHERE a.book_id=b.id AND a.status IN ('QUEUED','VALIDATING','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN')) ORDER BY b.created_at")
    for (const row of rows.rows) {
      const book = await this.store.getBook(row.user_id, row.id)
      if (!book) continue
      try {
        const active = await this.repository.getActiveAction(book.id)
        if (active) {
          // Recovery never re-submits an existing action, including after restart.
          if (!active.venueReference) continue // Manual submission may still be persisting its reference.
          if (Date.now() < (this.reconciliationSchedule.get(book.id)?.nextAt ?? 0)) continue
          if (!this.venue) throw new Error('VENUE_NOT_CONFIGURED')
          const result = await this.venue.reconcile(active)
          if (result.status === 'UNKNOWN') {
            if (result.error === 'VENUE_REFERENCE_COLLISION' && active.error !== result.error) await this.repository.saveAction(result)
            this.reconciliationSchedule.set(book.id, { nextAt: Date.now() + 30_000, rateLimitFailures: 0 })
            continue
          }
          if (result.status === 'CONFIRMED') await this.venue.refresh(book)
          await this.repository.finalize(result)
          this.reconciliationSchedule.delete(book.id)
          continue
        }
        this.reconciliationSchedule.delete(book.id)
        if (!book.automationEnabled || book.status !== 'ACTIVE') continue
        if (!this.venue?.ready()) throw new Error('VENUE_NOT_CONNECTED')
        await this.venue.refresh(book)
        const context = await this.repository.getBookContext(book.id)
        const decision = { ...evaluate(context.book, context.position, context.reserve, context.telemetry, context.priorDefenseEfficiency, Date.now()), id: randomUUID() }
        const isNew = await this.recordDecision(decision)
        if (isNew && !['HOLD','SAFE_MODE'].includes(decision.action)) await new ExecutionWorker(this.repository, this.venue, current => this.venue!.refresh(current)).execute(decision)
      } catch (error) {
        if (await this.repository.getActiveAction(book.id)) {
          const priorFailures = this.reconciliationSchedule.get(book.id)?.rateLimitFailures ?? 0
          const rateLimited = error instanceof Error && error.message === 'VENUE_HTTP_429'
          const retryMs = rateLimited ? Math.min(300_000, 60_000 * 2 ** Math.min(priorFailures, 3)) : 30_000
          this.reconciliationSchedule.set(book.id, { nextAt: Date.now() + retryMs, rateLimitFailures: rateLimited ? priorFailures + 1 : 0 })
          logger.warn({ bookId: book.id, error: error instanceof Error ? error.message : 'RECONCILIATION_FAILED', retryMs }, 'Existing execution reconciliation deferred')
          continue
        }
        await this.safeMode(book, error instanceof Error ? error.message : 'RUNTIME_FAILURE')
      }
    }
  }
  private async recordDecision(decision: Decision) {
    const fingerprint = JSON.stringify([decision.state, decision.action, decision.amount, decision.reasonCodes])
    const client = await this.store.pool.connect()
    try {
      await client.query('BEGIN')
      const bookRow = await client.query('SELECT id,status FROM books WHERE id=$1 FOR UPDATE', [decision.bookId])
      if (!bookRow.rows.length) throw new Error('BOOK_NOT_FOUND')
      if (bookRow.rows[0].status === 'CLOSED') throw new Error('BOOK_CLOSED')
      const prior = await client.query('SELECT state,fingerprint FROM decisions WHERE book_id=$1 ORDER BY created_at DESC LIMIT 1', [decision.bookId])
      if (prior.rows[0]?.fingerprint === fingerprint) { await client.query('COMMIT'); return false }
      await client.query(`INSERT INTO decisions(id,book_id,state,action,amount,reason_codes,human_readable_reasons,risk_features,fingerprint,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [decision.id, decision.bookId, decision.state, decision.action, decision.amount, JSON.stringify(decision.reasonCodes), JSON.stringify(decision.humanReadableReasons), JSON.stringify(decision.riskFeatures), fingerprint, decision.createdAt])
      const types = ['DECISION_CREATED', ...(decision.reasonCodes.includes('DEFENSE_REFUSED') ? ['DEFENSE_REFUSED'] : []), ...(decision.state === 'SAFE_MODE' ? ['SAFE_MODE_ENTERED'] : prior.rows[0]?.state === 'SAFE_MODE' ? ['SAFE_MODE_EXITED'] : [])]
      for (const type of types) await client.query('INSERT INTO autopsy_events(book_id,type,payload) VALUES($1,$2,$3)', [decision.bookId,type,JSON.stringify(decision)])
      await client.query("UPDATE books SET status=$2,updated_at=now() WHERE id=$1", [decision.bookId,decision.state === 'SAFE_MODE' ? 'SAFE_MODE' : 'ACTIVE'])
      if (decision.state !== 'HOLD') await client.query(`INSERT INTO notifications(user_id,kind,title,body,dedupe_key) SELECT user_id,$2,$2,$3,$4 FROM books WHERE id=$1 ON CONFLICT(dedupe_key) DO NOTHING`, [decision.bookId,decision.state,decision.humanReadableReasons.join(' '),decision.id])
      await client.query('COMMIT'); return true
    } catch(error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  private async safeMode(book: Book, reason: string) {
    await this.recordDecision({ id: randomUUID(), bookId: book.id, state:'SAFE_MODE', action:'SAFE_MODE', amount:0, reasonCodes:[reason], humanReadableReasons:['Automation cannot trust venue or execution state. Reconciliation is required.'], createdAt:new Date().toISOString(), riskFeatures:{liquidationDistance:0,fundingPressure:0,spreadBps:0,depthCoverage:0,volatility:0,reserveHeadroom:0,capUtilization:0,timeRemainingMs:0,defenseEfficiency:0,fresh:false} })
  }
  private manualAuthorityRejected(bookId: string, code: string | string[], reason: string): Decision {
    return { id: randomUUID(), bookId, state: 'SAFE_MODE', action: 'SAFE_MODE', amount: 0, reasonCodes: Array.isArray(code) ? code : [code], humanReadableReasons: [reason], createdAt: new Date().toISOString(), riskFeatures: { liquidationDistance: 0, fundingPressure: 0, spreadBps: 0, depthCoverage: 0, volatility: 0, reserveHeadroom: 0, capUtilization: 0, timeRemainingMs: 0, defenseEfficiency: 0, fresh: false } }
  }
  async closeBook(userId: string, bookId: string): Promise<{ actionId: string; status: string }> {
    const book = await this.store.getBook(userId,bookId)
    if (!book) throw new Error('BOOK_NOT_FOUND')
    if (!this.venue?.ready()) throw new Error('VENUE_NOT_CONNECTED')
    const active = await this.repository.getActiveAction(bookId)
    if (active) return {actionId:active.id,status:active.status}
    await this.venue.refresh(book)
    const context = await this.repository.getBookContext(bookId)
    const decision = { ...evaluate({...context.book,stance:'KILL',automationEnabled:true,status:'ACTIVE'},context.position,context.reserve,context.telemetry,context.priorDefenseEfficiency,Date.now()),id:randomUUID() }
    if (decision.state === 'SAFE_MODE') throw new Error('STALE_STATE')
    const closeDecision: Decision = { ...decision, action: 'EXIT', state: 'EXIT', amount: 0, reasonCodes: ['USER_CLOSE'], humanReadableReasons: ['User requested a reduce-only position close.'] }
    await this.repository.saveDecision(closeDecision)
    const result = await new ExecutionWorker(this.repository, this.venue, current => this.venue!.refresh(current)).execute(closeDecision, true)
    if (!result || !('status' in result)) throw new Error('CLOSE_ACTION_NOT_CREATED')
    return { actionId: result.id, status: result.status }
  }
  async executeAction(userId: string, bookId: string, kind: 'DEFEND' | 'REDUCE'): Promise<{ actionId: string; status: string }> {
    const book = await this.store.getBook(userId, bookId)
    if (!book) throw new Error('BOOK_NOT_FOUND')
    if (!this.venue?.ready()) throw new PolicyRejectedError(kind, this.manualAuthorityRejected(bookId, 'VENUE_UNAVAILABLE', 'Venue authority is unavailable; manual action is blocked.'))
    if (await this.repository.getActiveAction(bookId)) throw new Error('ACTION_ALREADY_ACTIVE')
    if (await this.repository.getConflictingPositionAction(bookId)) throw new PolicyRejectedError(kind, this.manualAuthorityRejected(bookId, 'POSITION_EXECUTION_UNRESOLVED', 'Another Book has an unresolved execution for this Perpl position.'))
    try { await this.venue.refresh(book) } catch { throw new PolicyRejectedError(kind, this.manualAuthorityRejected(bookId, 'VENUE_UNAVAILABLE', 'Venue authority could not refresh the current state.')) }
    const context = await this.repository.getBookContext(bookId)
    const now = Date.now()
    const telemetryFailures = telemetryFreshnessFailures(context.telemetry, context.position, now)
    logger.info({ bookId, action: kind, telemetry: { market: context.telemetry.freshness?.market, position: context.telemetry.freshness?.position, funding: context.telemetry.freshness?.funding, orderbook: context.telemetry.freshness?.orderbook }, failures: telemetryFailures.codes }, 'Manual action telemetry gate')
    const decision = { ...evaluateManualAction(context.book, context.position, context.reserve, context.telemetry, kind, context.priorDefenseEfficiency, now), id: randomUUID() }
    if (decision.action !== kind) throw new PolicyRejectedError(kind, decision)
    await this.recordDecision(decision)
    let result
    try {
      result = await new ExecutionWorker(this.repository, this.venue, current => this.venue!.refresh(current)).execute(decision, false, true)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MANUAL_POLICY_REEVALUATION_FAILED'
      const codes = code.split(',').filter(Boolean)
      if (['STALE_STATE', 'DECISION_SUPERSEDED', 'BOOK_NOT_ACTIVE', 'RESERVE_CAP_EXCEEDED', 'INVALID_ACTION_AMOUNT', 'TELEMETRY_INVALID', 'POSITION_EXECUTION_UNRESOLVED'].includes(code) || codes.every(value => /^(MARKET|POSITION|FUNDING|DEPTH)_(STALE|UNKNOWN)$|^BOTH_STALE$/.test(value))) {
        throw new PolicyRejectedError(kind, this.manualAuthorityRejected(bookId, codes, 'Current Book telemetry or state changed before manual action could be submitted.'))
      }
      throw error
    }
    if (!result || !('status' in result)) throw new Error('ACTION_NOT_CREATED')
    return { actionId: result.id, status: result.status }
  }
}

