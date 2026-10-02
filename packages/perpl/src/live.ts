import Decimal from 'decimal.js'
import type { Action } from '../../domain/src/index.js'
import { buildPerplOrder, type OrderContext } from './orders.js'
import type { PerplTradingClient } from './trading.js'
import { PerplPreSubmissionError } from './trading.js'
import type { PerplHistory } from './history.js'
import type { WirePosition } from './decoder.js'
import { requestId } from './request-id.js'

export type ReconciliationContext = OrderContext & { positionId: number; collateralDecimals: number }
function reconstructionExpiry(action: Action, context: ReconciliationContext) {
  const head = action.venueProgress?.sentHeartbeatHead
  const last = action.venueProgress?.requestedLastExecBlock
  if (Number.isSafeInteger(head) && Number.isSafeInteger(last) && last! > head!)
    return { headBlock: head!, orderTtlBlocks: last! - head! }
  return { headBlock: context.headBlock, orderTtlBlocks: context.orderTtlBlocks }
}

export class PerplLiveAdapter {
  constructor(
    private readonly client: PerplTradingClient,
    private readonly context: (action: Action) => Promise<ReconciliationContext>,
    private readonly history: Pick<PerplHistory, 'evidence'> & Partial<Pick<PerplHistory, 'verifiedRequestOperations'>>,
    private readonly persistReference: (action: Action) => Promise<void>,
    private readonly persistEvidence: (
      action: Action,
      evidence: unknown,
      verifiedPosition?: WirePosition,
      context?: ReconciliationContext,
      expectedSizeRaw?: bigint,
    ) => Promise<void> = async () => undefined,
    private readonly referenceConflicts: (action: Action) => Promise<boolean> = async () => false,
    private readonly verifyBeforeSend: (
      action: Action,
      order: ReturnType<typeof buildPerplOrder>,
    ) => Promise<void> = async () => undefined,
    private readonly verificationTimeoutMs = 180_000,
    private readonly now: () => number = Date.now,
  ) {}
  async submit(action: Action) {
    let order: ReturnType<typeof buildPerplOrder>
    try {
      const context = await this.context(action)
      if (
        (action.kind === 'REDUCE' || action.kind === 'EXIT') &&
        (!action.beforeState?.position ||
          action.beforeState.position.status !== 'OPEN' ||
          action.beforeState.position.side !== context.position.side)
      )
        throw new Error('CLOSE_BASELINE_UNAVAILABLE')
      order = buildPerplOrder(action, context)
    } catch (error) {
      throw new PerplPreSubmissionError(error instanceof Error ? error.message : 'PERPL_ORDER_CONTEXT_FAILED')
    }
    return this.client.submit(
      action,
      order,
      async (reference) => {
        try {
          action.venueReference = reference
          await this.persistReference(action)
        } catch (error) {
          throw new PerplPreSubmissionError(error instanceof Error ? error.message : 'PERPL_REFERENCE_PERSIST_FAILED')
        }
      },
      async () => this.verifyBeforeSend(action, order),
    )
  }
  async reconcile(action: Action): Promise<Action> {
    const unknown = (error: string): Action => ({ ...action, status: 'UNKNOWN', error })
    const lastExecBlock = action.venueProgress?.requestedLastExecBlock
    const bounded = Number.isSafeInteger(lastExecBlock) && lastExecBlock! > 0
    const submittedAt = Date.parse(action.submittedAt ?? '')
    const pending = (error: string): Action =>
      bounded && Number.isFinite(submittedAt) && this.now() - submittedAt < this.verificationTimeoutMs
        ? { ...action, status: 'VERIFYING', error: undefined }
        : unknown(error)
    if (await this.referenceConflicts(action)) return unknown('VENUE_REFERENCE_COLLISION')
    const context = await this.context(action)
    const reference = action.venueReference?.split(':') ?? []
    const account = Number(reference[0]),
      rq = reference[1]
    if (account !== context.accountId || !rq) return unknown('MISSING_DURABLE_VENUE_REFERENCE')
    try {
      if (requestId(rq) === 0n) return unknown('MISSING_DURABLE_VENUE_REFERENCE')
    } catch {
      return unknown('MISSING_DURABLE_VENUE_REFERENCE')
    }
    if (bounded && action.venueProgress?.requestId !== rq) return unknown('VENUE_PROGRESS_REQUEST_MISMATCH')
    const minBlock = action.beforeState?.telemetry.block
    let accountState: { lfr: string; block: number } | undefined
    if (bounded && typeof this.client.accountRequestState === 'function') {
      try {
        accountState = await this.client.accountRequestState(account)
      } catch {
        // An unavailable account snapshot never proves expiry.
      }
    }
    const streamAccount = this.client.stateSnapshot?.().accounts.find((item) => item.id === account)
    const currentLfr = accountState?.lfr ?? (streamAccount ? String(streamAccount.lfr) : undefined)
    if (
      (action.status === 'UNKNOWN' || action.status === 'VERIFYING') &&
      this.history.verifiedRequestOperations &&
      currentLfr &&
      requestId(currentLfr) >= requestId(rq)
    ) {
      let operations: Awaited<ReturnType<PerplHistory['verifiedRequestOperations']>> = []
      try {
        operations = await this.history.verifiedRequestOperations(account, rq, minBlock)
      } catch (error) {
        if (!bounded && (action.kind !== 'DEFEND' || action.status !== 'VERIFYING')) throw error
      }
      let expected: ReturnType<typeof buildPerplOrder> | undefined
      try {
        expected = buildPerplOrder(action, {
          ...context,
          position: action.beforeState?.position ?? context.position,
          ...reconstructionExpiry(action, context),
        })
      } catch {
        // Type and binding mismatches can still be proven without a size estimate.
      }
      const mismatch = operations.find(
        (operation) =>
          (bounded && operation.block !== undefined && operation.block > lastExecBlock!) ||
          operation.type !==
            (action.kind === 'DEFEND'
              ? 6
              : (action.beforeState?.position.side ?? context.position.side) === 'LONG'
                ? 3
                : 4) ||
          operation.marketId !== context.marketId ||
          (operation.positionId !== undefined && operation.positionId !== context.positionId) ||
          (operation.type === 6 && expected?.a !== undefined && operation.amountRaw !== expected.a) ||
          (operation.type !== 6 && expected?.s !== undefined && operation.sizeRaw !== String(expected.s)),
      )
      if (mismatch)
        return {
          ...action,
          status: 'FAILED',
          error: 'PERPL_REQUEST_ID_SUPERSEDED',
          failedAt: new Date(this.now()).toISOString(),
          venueProgress: action.venueProgress && { ...action.venueProgress, supersededBy: mismatch },
        }
    }
    let evidence: Awaited<ReturnType<PerplHistory['evidence']>>
    try {
      evidence = await this.history.evidence(
        account,
        rq,
        context.marketId,
        context.positionId,
        action.kind === 'DEFEND'
          ? { amount: action.amount, decimals: context.collateralDecimals, minBlock: minBlock ?? 0 }
          : undefined,
        minBlock,
      )
    } catch (error) {
      if (bounded) return pending('VENUE_EVIDENCE_UNAVAILABLE')
      if (
        action.kind === 'DEFEND' &&
        action.status === 'VERIFYING' &&
        this.client.verificationPending(action.venueProgress)
      )
        return action
      throw error
    }
    if (bounded && evidence.collateralSuccess && evidence.collateralSuccess.block > lastExecBlock!)
      return {
        ...action,
        status: 'FAILED',
        error: 'PERPL_REQUEST_ID_SUPERSEDED',
        failedAt: new Date(this.now()).toISOString(),
        venueProgress: action.venueProgress && {
          ...action.venueProgress,
          supersededBy: {
            requestId: rq,
            type: 6,
            marketId: context.marketId,
            positionId: context.positionId,
            block: evidence.collateralSuccess.block,
            txHash: evidence.collateralSuccess.txHash,
          },
        },
      }
    if (action.kind === 'DEFEND' && evidence.collateralSuccess) {
      await this.persistEvidence(action, evidence)
      return {
        ...action,
        venueReference: `${account}:${rq}:${evidence.collateralSuccess.txHash}`,
        status: 'CONFIRMED',
        error: undefined,
        failedAt: undefined,
        confirmedAt: new Date().toISOString(),
      }
    }
    const noEvidence =
      evidence.orders.length === 0 &&
      evidence.accounts.length === 0 &&
      evidence.fills.length === 0 &&
      !evidence.positions.some((position) => String(position.rq) === rq)
    if (bounded && noEvidence) {
      if (accountState && accountState.block >= lastExecBlock! && requestId(accountState.lfr) < requestId(rq))
        return {
          ...action,
          status: 'FAILED',
          failedAt: new Date(this.now()).toISOString(),
          error: 'PERPL_ORDER_WINDOW_EXPIRED',
        }
      return pending('VENUE_OUTCOME_UNVERIFIED')
    }
    if (action.kind === 'DEFEND' && evidence.orders.length && evidence.orders.every((order) => order.st === 7))
      return bounded ? pending('COLLATERAL_OUTCOME_UNVERIFIED') : unknown('COLLATERAL_OUTCOME_UNVERIFIED')
    if (
      action.kind === 'DEFEND' &&
      action.status === 'VERIFYING' &&
      this.client.verificationPending(action.venueProgress)
    )
      return { ...action, error: undefined }
    if (action.kind === 'REDUCE' || action.kind === 'EXIT') {
      const before = action.beforeState?.position
      if (!before || before.status !== 'OPEN' || before.side !== context.position.side)
        return unknown('CLOSE_BASELINE_UNAVAILABLE')
      let requested: ReturnType<typeof buildPerplOrder>
      let beforeSize: number
      try {
        requested = buildPerplOrder(action, { ...context, position: before, ...reconstructionExpiry(action, context) })
        beforeSize = buildPerplOrder(
          { ...action, kind: 'EXIT' },
          { ...context, position: before, ...reconstructionExpiry(action, context) },
        ).s
      } catch {
        return unknown('CLOSE_ORDER_UNVERIFIABLE')
      }
      const matching = evidence.orders.filter(
        (order) =>
          order.t === requested.t &&
          order.os === requested.s &&
          (order.lp === undefined || order.lp === context.positionId),
      )
      if (!matching.length) {
        const positionChanged = evidence.positions.some((position) => String(position.rq) === rq)
        if (
          evidence.orders.length &&
          evidence.orders.every((order) => order.st === 7 && order.fs === 0) &&
          !evidence.fills.length &&
          !evidence.accounts.length &&
          !positionChanged
        ) {
          return {
            ...action,
            status: 'FAILED',
            failedAt: new Date().toISOString(),
            error: evidence.orders.some((order) => order.sr === 11)
              ? 'CLOSE_ORDER_POSITION_MISMATCH'
              : 'CLOSE_ORDER_MISMATCH',
          }
        }
        return unknown(evidence.orders.length ? 'CLOSE_ORDER_MISMATCH' : 'VENUE_OUTCOME_PENDING')
      }
      const order = matching
        .filter((item) => item.st !== 7)
        .sort(
          (a, b) => (b.at.b ?? 0) - (a.at.b ?? 0) || (b.at.tx ?? 0) - (a.at.tx ?? 0) || (b.at.l ?? 0) - (a.at.l ?? 0),
        )[0]
      if (!order)
        return evidence.fills.length || evidence.positions.some((position) => String(position.rq) === rq)
          ? unknown('CLOSE_OUTCOME_UNVERIFIED')
          : {
              ...action,
              status: 'FAILED',
              failedAt: new Date().toISOString(),
              error: matching.some((item) => item.sr === 32) ? 'ORDER_REQUEST_ID_TOO_LOW' : 'VENUE_REJECTED',
            }
      const fills = evidence.fills.filter((fill) => fill.oid === order.oid && fill.t === requested.t)
      if (!fills.length) {
        if (order.st === 5 || order.st === 6)
          return {
            ...action,
            status: order.st === 5 ? 'CANCELED' : 'EXPIRED',
            failedAt: new Date().toISOString(),
            error: order.st === 5 ? 'VENUE_ORDER_CANCELED' : 'VENUE_ORDER_EXPIRED',
          }
        return pending('CLOSE_FILL_PENDING')
      }
      if (fills.some((fill) => !Number.isSafeInteger(fill.s) || fill.s <= 0)) return unknown('CLOSE_FILL_INVALID')
      const filled = fills.reduce((sum, fill) => sum + BigInt(fill.s), 0n)
      if (filled > BigInt(requested.s) || !Number.isSafeInteger(order.fs) || filled !== BigInt(order.fs))
        return unknown('CLOSE_FILL_MISMATCH')
      const remaining = BigInt(beforeSize) - filled
      const lastFillBlock = Math.max(...fills.map((fill) => fill.at.b ?? 0))
      const after = evidence.positions
        .filter(
          (position) =>
            position.pid === context.positionId &&
            String(position.rq) === rq &&
            position.oid === order.oid &&
            (position.at.b ?? 0) >= lastFillBlock,
        )
        .sort(
          (a, b) => (b.at.b ?? 0) - (a.at.b ?? 0) || (b.at.tx ?? 0) - (a.at.tx ?? 0) || (b.at.l ?? 0) - (a.at.l ?? 0),
        )[0]
      if (!after || !Number.isSafeInteger(after.s) || after.s < 0 || remaining < 0n)
        return pending('POSITION_NOT_RECONCILED')
      if (after.sd !== (before.side === 'LONG' ? 1 : 2)) return unknown('CLOSE_SIDE_MISMATCH')
      if (filled < BigInt(requested.s) || order.st === 3 || order.st === 5 || order.st === 6) {
        if (after.st !== 1 || remaining <= 0n) return unknown('PARTIAL_POSITION_UNVERIFIED')
        return { ...action, status: 'PARTIAL', error: 'PARTIAL_CLOSE_REQUIRES_REVIEW' }
      }
      if (![4, 10].includes(order.st)) return unknown('CLOSE_ORDER_NOT_TERMINAL')
      if (action.kind === 'REDUCE' && (after.st !== 1 || remaining <= 0n)) return unknown('REDUCE_POSITION_NOT_OPEN')
      if (action.kind === 'EXIT' && (after.st !== 2 || remaining !== 0n)) return unknown('EXIT_POSITION_REMAINS_OPEN')
      await this.persistEvidence(action, evidence, after, context, remaining)
      return { ...action, status: 'CONFIRMED', error: undefined, confirmedAt: new Date().toISOString() }
    }
    const orders = evidence.orders
    const terminal = orders.find((order) => [2, 3, 4, 5, 6, 8, 9, 10].includes(order.st))
    const executed = terminal && [2, 3, 4, 8, 9, 10].includes(terminal.st) ? terminal : undefined
    if (!terminal) {
      if (
        orders.length &&
        orders.every((order) => order.st === 7) &&
        evidence.fills.length === 0 &&
        evidence.accounts.length === 0
      )
        return {
          ...action,
          status: 'FAILED',
          failedAt: new Date().toISOString(),
          error: orders.some((order) => order.sr === 32) ? 'ORDER_REQUEST_ID_TOO_LOW' : 'VENUE_REJECTED',
        }
      return unknown('VENUE_OUTCOME_PENDING')
    }
    if (terminal.st === 5)
      return { ...action, status: 'CANCELED', failedAt: new Date().toISOString(), error: 'VENUE_ORDER_CANCELED' }
    if (terminal.st === 6)
      return { ...action, status: 'EXPIRED', failedAt: new Date().toISOString(), error: 'VENUE_ORDER_EXPIRED' }
    if (!executed) return unknown('VENUE_OUTCOME_PENDING')
    const increase = evidence.accounts.find((event) => event.et === 3 && event.p === context.positionId)
    const after = evidence.positions.find((position) => (position.at.b ?? 0) >= (executed.at.b ?? Infinity))
    const minimum = new Decimal(context.position.margin).plus(action.amount)
    if (!increase || !after || new Decimal(after.c).lt(minimum)) return unknown('COLLATERAL_NOT_RECONCILED')
    await this.persistEvidence(action, evidence)
    return { ...action, status: 'CONFIRMED', error: undefined, confirmedAt: new Date().toISOString() }
  }
}
