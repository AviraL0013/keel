import Decimal from 'decimal.js'
import type { Action } from '../../domain/src/index.js'
import { buildPerplOrder, type OrderContext } from './orders.js'
import type { PerplTradingClient } from './trading.js'
import type { PerplHistory } from './history.js'

export type ReconciliationContext = OrderContext & { positionId: number; collateralDecimals: number }
export class PerplLiveAdapter {
  constructor(
    private readonly client: PerplTradingClient,
    private readonly context: (action: Action) => Promise<ReconciliationContext>,
    private readonly history: Pick<PerplHistory, 'evidence'>,
    private readonly persistReference: (action: Action) => Promise<void>,
    private readonly persistEvidence: (action: Action, evidence: unknown) => Promise<void> = async () => undefined,
  ) {}
  async submit(action: Action) {
    const context = await this.context(action)
    return this.client.submit(action, buildPerplOrder(action, context), async reference => {
      action.venueReference = reference
      await this.persistReference(action)
    })
  }
  async reconcile(action: Action): Promise<Action> {
    const context = await this.context(action)
    const reference = action.venueReference?.split(':') ?? []
    const account = Number(reference[0]), requestId = Number(reference[1])
    const unknown = (error: string): Action => ({ ...action, status: 'UNKNOWN', error })
    if (account !== context.accountId || !Number.isSafeInteger(requestId) || requestId <= 0) return unknown('MISSING_DURABLE_VENUE_REFERENCE')
    const evidence = await this.history.evidence(account, requestId, context.marketId, context.positionId)
    const orders = evidence.orders
    const terminal = orders.find(order => [2,3,4,5,6,8,9,10].includes(order.st))
    const executed = terminal && [2,3,4,8,9,10].includes(terminal.st) ? terminal : undefined
    if (!terminal) {
      if (orders.length && orders.every(order => order.st === 7) && evidence.fills.length === 0 && evidence.accounts.length === 0) return { ...action, status: 'FAILED', failedAt: new Date().toISOString(), error: 'VENUE_REJECTED' }
      return unknown('VENUE_OUTCOME_PENDING')
    }
    if (terminal.st === 5) return { ...action, status: 'CANCELED', failedAt: new Date().toISOString(), error: 'VENUE_ORDER_CANCELED' }
    if (terminal.st === 6) return { ...action, status: 'EXPIRED', failedAt: new Date().toISOString(), error: 'VENUE_ORDER_EXPIRED' }
    if (!executed) return unknown('VENUE_OUTCOME_PENDING')
    if (action.kind === 'DEFEND') {
      const increase = evidence.accounts.find(event => event.et === 3 && event.p === context.positionId)
      const after = evidence.positions.find(position => (position.at.b ?? 0) >= (executed.at.b ?? Infinity))
      const minimum = new Decimal(context.position.margin).plus(action.amount)
      if (!increase || !after || new Decimal(after.c).lt(minimum)) return unknown('COLLATERAL_NOT_RECONCILED')
    } else {
      const filled = evidence.fills.reduce((sum, fill) => sum.plus(fill.s), new Decimal(0))
      const required = buildPerplOrder(action, context).s
      const after = evidence.positions.find(position => (position.at.b ?? 0) >= (executed.at.b ?? Infinity))
      if (!after || after.sd !== (context.position.side === 'LONG' ? 1 : 2) || after.s > new Decimal(context.position.size).mul(new Decimal(10).pow(context.sizeDecimals)).toNumber()) return unknown('POSITION_NOT_RECONCILED')
      if (filled.lt(required)) return { ...action, status: 'PARTIAL', confirmedAt: new Date().toISOString(), error: 'PARTIAL_FILL' }
      if (action.kind === 'EXIT' && after.st === 1 && after.s !== 0) return unknown('EXIT_POSITION_REMAINS_OPEN')
    }
    await this.persistEvidence(action, evidence)
    return { ...action, status: 'CONFIRMED', error: undefined, confirmedAt: new Date().toISOString() }
  }
}
