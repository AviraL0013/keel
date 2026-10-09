import { describe, expect, it } from 'vitest'
import { PerplLiveAdapter } from '../packages/perpl/src/live.js'
import type { Action } from '../packages/domain/src/index.js'

const started = Date.parse('2026-10-01T18:04:48.908Z')
let now = started + 15_000
const position = {
  bookId: 'book',
  side: 'LONG',
  size: 0.05,
  status: 'OPEN',
  entryPrice: 2686.54,
  markPrice: 2700,
  liquidationPrice: 2596.9887,
  leverage: 12,
  unrealizedPnl: 0,
  margin: 11.193917,
}
const context = {
  accountId: 642,
  marketId: 32,
  positionId: 4393264152576,
  collateralDecimals: 6,
  sizeDecimals: 3,
  priceDecimals: 1,
  headBlock: 0,
  orderTtlBlocks: 20,
  leverageHundredths: 1200,
  position,
}
const progress = {
  requestId: '1791001362471',
  clientSequence: 2,
  admitted: false,
  requestedLastExecBlock: 67324083,
  sentHeartbeatHead: 67324063,
  sentHeartbeatSequence: 67324063,
  streamEpoch: 'disconnected',
  orderStatusReceived: false,
  response: 'TRANSPORT_AMBIGUOUS',
} as const
const baseAction = (kind: 'DEFEND' | 'EXIT' = 'DEFEND'): Action => ({
  id: 'action',
  bookId: 'book',
  decisionId: 'decision',
  kind,
  amount: kind === 'DEFEND' ? 0.980776 : 0,
  status: 'VERIFYING',
  idempotencyKey: 'once',
  venueReference: `642:${progress.requestId}`,
  venueProgress: { ...progress },
  submittedAt: new Date(started).toISOString(),
  beforeState: { position, telemetry: { block: 67324063 } } as Action['beforeState'],
})
const empty = () => ({ orders: [], accounts: [], positions: [], fills: [], collateralSuccess: undefined })
function setup(lfr: string, observedBlock = 67324090) {
  let evidence = empty()
  const client = {
    accountRequestState: async () => ({ lfr, block: observedBlock }),
    stateSnapshot: () => ({ accounts: [{ id: 642, lfr }] }),
    verificationPending: () => false,
    expiryProven: () => true,
  }
  const history = {
    evidence: async () => evidence,
    verifiedRequestOperations: async () => [],
  }
  const live = new PerplLiveAdapter(
    client as never,
    async () => context as never,
    history as never,
    async () => undefined,
    async () => undefined,
    async () => false,
    async () => undefined,
    180_000,
    () => now,
  )
  return {
    live,
    setEvidence: (value: ReturnType<typeof empty>) => {
      evidence = value
    },
  }
}

describe('bounded Perpl reconciliation', () => {
  it('keeps a real low-word lfr 45 DEFEND VERIFYING until delayed collateral history confirms it', async () => {
    now = started + 15_000
    const { live, setEvidence } = setup('45')
    expect((await live.reconcile(baseAction())).status).toBe('VERIFYING')
    now = started + 60_000
    setEvidence({ ...empty(), collateralSuccess: { txHash: `0x${'a'.repeat(64)}`, block: 67324070 } } as never)
    const confirmed = await live.reconcile(baseAction())
    expect(confirmed.status).toBe('CONFIRMED')
    expect(confirmed.venueProgress?.confirmedExecutionBlock).toBe(67324070)
  })

  it('does not expire the transport-ambiguous EXIT when low-word lfr 45 has passed its rq', async () => {
    now = started + 60_000
    const { live } = setup('45')
    expect((await live.reconcile(baseAction('EXIT'))).status).toBe('VERIFYING')
    now = started + 180_001
    expect((await live.reconcile(baseAction('EXIT'))).status).toBe('UNKNOWN')
  })

  it('keeps t:6 VERIFYING beyond a 20-block window while history lags 60 seconds, then confirms', async () => {
    now = started + 15_000
    const { live, setEvidence } = setup('1791001362471')
    expect((await live.reconcile(baseAction())).status).toBe('VERIFYING')
    now = started + 60_000
    setEvidence({ ...empty(), collateralSuccess: { txHash: `0x${'a'.repeat(64)}`, block: 67324070 } } as never)
    expect((await live.reconcile(baseAction())).status).toBe('CONFIRMED')
  })

  it('fails only when lfr below rq is observed after lb', async () => {
    now = started + 15_000
    expect(await setup('1791001362470').live.reconcile(baseAction())).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_ORDER_WINDOW_EXPIRED',
    })
    expect((await setup('1791001362470', 67324080).live.reconcile(baseAction())).status).toBe('VERIFYING')
  })

  it('waits for evidence when lfr reached rq, then enters UNKNOWN at three minutes', async () => {
    now = started + 15_000
    const { live } = setup('1791001362471')
    expect((await live.reconcile(baseAction())).status).toBe('VERIFYING')
    now = started + 180_001
    expect((await live.reconcile(baseAction())).status).toBe('UNKNOWN')
  })

  it('confirms transport-ambiguous EXIT after reconnect from matching close evidence', async () => {
    now = started + 60_000
    const { live, setEvidence } = setup('1791001362471')
    setEvidence({
      ...empty(),
      orders: [
        {
          acc: 642,
          mkt: 32,
          rq: progress.requestId,
          oid: 8,
          t: 3,
          os: 50,
          fs: 50,
          st: 4,
          at: { b: 67324070 },
          lp: context.positionId,
        },
      ],
      fills: [{ acc: 642, mkt: 32, oid: 8, t: 3, s: 50, at: { b: 67324070 } }],
      positions: [
        {
          acc: 642,
          mkt: 32,
          pid: context.positionId,
          oid: 8,
          rq: progress.requestId,
          st: 2,
          sd: 1,
          s: 0,
          at: { b: 67324071 },
        },
      ],
    } as never)
    expect((await live.reconcile(baseAction('EXIT'))).status).toBe('CONFIRMED')
  })

  it('fails transport-ambiguous EXIT when lfr remains below rq after lb', async () => {
    now = started + 60_000
    expect(await setup('1791001362470').live.reconcile(baseAction('EXIT'))).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_ORDER_WINDOW_EXPIRED',
    })
  })
})
