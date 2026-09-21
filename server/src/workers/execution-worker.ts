import type { Action, AutopsyEvent, Book, Decision, NormalizedTelemetry, Position, Reserve } from '../../../packages/domain/src/index.js'
import { defenseAmount, deriveFeatures, classifyDecision, defaultRiskConfig } from '../../../packages/risk-engine/src/index.js'
import type { VenueAdapter } from '../../../packages/perpl/src/index.js'
export type ExecutionRepository = { getActionByIdempotency?(key: string): Promise<Action | null>; getActiveAction(bookId: string): Promise<Action | null>; saveAction(action: Action): Promise<void>; saveDecision(decision: Decision): Promise<void>; addEvent(event: AutopsyEvent): Promise<void>; getBookContext(bookId: string): Promise<{ book: Book; position: Position; reserve: Reserve; priorDefenseEfficiency: number; telemetry: NormalizedTelemetry }>; finalize?(action: Action): Promise<void>; updateReserve(bookId: string, amount: number, actionId?: string, decisionId?: string): Promise<void> }
export class ExecutionWorker {
  constructor(private readonly repo: ExecutionRepository, private readonly venue: Pick<VenueAdapter, 'submit' | 'reconcile'>, private readonly refreshAfterConfirmation?: (book: Book) => Promise<void>) {}
  async evaluate(bookId: string): Promise<Decision> { const context = await this.repo.getBookContext(bookId); const features = deriveFeatures(context.book, context.position, context.reserve, context.telemetry, Date.now(), defaultRiskConfig, context.priorDefenseEfficiency); const amount = defenseAmount(features, context.position, context.reserve, context.book, context.telemetry); const decision: Decision = { ...classifyDecision(context.book, features, amount, defaultRiskConfig), id: crypto.randomUUID(), bookId, createdAt: new Date().toISOString() }; await this.repo.saveDecision(decision); await this.repo.addEvent({ id: crypto.randomUUID(), bookId, type: 'DECISION_CREATED', payload: { state: decision.state, action: decision.action, reasons: decision.humanReadableReasons, features: decision.riskFeatures }, timestamp: decision.createdAt, block: context.telemetry.block }); return decision }
  async execute(decision: Decision, manualClose = false) {
    if (decision.action === 'HOLD' || decision.action === 'SAFE_MODE') return decision
    const key = `${decision.id}:${decision.action}`; const duplicate = this.repo.getActionByIdempotency ? await this.repo.getActionByIdempotency(key) : null; if (duplicate) return duplicate
    if (await this.repo.getActiveAction(decision.bookId)) throw new Error('ACTION_ALREADY_ACTIVE')
    const context = await this.repo.getBookContext(decision.bookId)
    const features = deriveFeatures(context.book, context.position, context.reserve, context.telemetry, Date.now(), defaultRiskConfig, context.priorDefenseEfficiency)
    if (!features.fresh) throw new Error('STALE_STATE')
    if (context.book.status === 'CLOSED' || (!manualClose && (!context.book.automationEnabled || context.book.status === 'PAUSED'))) throw new Error('AUTOMATION_PAUSED')
    if (manualClose && decision.action !== 'EXIT') throw new Error('INVALID_MANUAL_CLOSE')
    if (decision.action === 'DEFEND' && context.book.stance !== 'DEFEND') throw new Error('POLICY_REJECTED')
    if (!Number.isFinite(decision.amount) || decision.amount < 0) throw new Error('INVALID_ACTION_AMOUNT')
    const refreshed = classifyDecision(context.book, features, defenseAmount(features, context.position, context.reserve, context.book, context.telemetry))
    if ((!manualClose && decision.action !== refreshed.action) || (decision.action === 'DEFEND' && decision.amount !== refreshed.amount)) throw new Error('DECISION_SUPERSEDED')
    if (decision.action === 'DEFEND' && (decision.amount > context.reserve.available || decision.amount > context.book.defenseCap)) throw new Error('RESERVE_CAP_EXCEEDED')
    const action: Action = { id: crypto.randomUUID(), bookId: decision.bookId, decisionId: decision.id, kind: decision.action as Action['kind'], amount: decision.amount, status: 'QUEUED', idempotencyKey: key, beforeState: { position: context.position, reserve: context.reserve, telemetry: context.telemetry } }
    await this.repo.saveAction(action); await this.repo.addEvent({ id: crypto.randomUUID(), bookId: action.bookId, type: `${action.kind}_QUEUED`, payload: { actionId: action.id, amount: action.amount }, timestamp: new Date().toISOString() })
    try {
      action.status = 'VALIDATING'; await this.repo.saveAction(action)
      action.status = 'SUBMITTING'; await this.repo.saveAction(action)
      const submitted = await this.venue.submit(action); action.venueReference = submitted.venueReference; action.submittedAt = new Date().toISOString()
      if (submitted.status === 'FAILED') { action.status = 'FAILED'; action.error = 'VENUE_REJECTED'; if (this.repo.finalize) await this.repo.finalize(action); else { await this.repo.saveAction(action); await this.repo.addEvent(this.event(action, 'ACTION_FAILED', { error: action.error })) }; return action }
      action.status = submitted.status === 'UNKNOWN' ? 'UNKNOWN' : 'SUBMITTED'; if (submitted.status === 'UNKNOWN') action.error = 'VENUE_OUTCOME_UNKNOWN'; await this.repo.saveAction(action)
      action.status = 'VERIFYING'; await this.repo.saveAction(action)
      const reconciledRaw = await this.venue.reconcile(action); const reconciled = reconciledRaw.status === 'VERIFYING' ? { ...reconciledRaw, status: 'UNKNOWN' as const, error: reconciledRaw.error ?? 'VENUE_OUTCOME_UNKNOWN' } : reconciledRaw; if (reconciled.status === 'CONFIRMED') await this.refreshAfterConfirmation?.(context.book); if (this.repo.finalize) { await this.repo.finalize(reconciled); return reconciled }
      await this.repo.saveAction(reconciled)
      if (reconciled.status === 'CONFIRMED' && action.kind === 'DEFEND') await this.repo.updateReserve(action.bookId, action.amount, action.id, action.decisionId)
      await this.repo.addEvent(this.event(action, `${action.kind}_${reconciled.status}`, { venueReference: action.venueReference }))
      return reconciled
    } catch (error) {
      action.status = 'UNKNOWN'; action.error = error instanceof Error ? error.message : 'EXECUTION_UNKNOWN'; if (this.repo.finalize) await this.repo.finalize(action); else { await this.repo.saveAction(action); await this.repo.addEvent(this.event(action, 'RECONCILIATION_FAILURE', { error: action.error })) }; return action
    }
  }
  private event(action: Action, type: string, payload: Record<string, unknown>): AutopsyEvent { return { id: crypto.randomUUID(), bookId: action.bookId, type, payload: { actionId: action.id, ...payload }, timestamp: new Date().toISOString() } }
}

