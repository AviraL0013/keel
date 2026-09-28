import { describe, expect, it, vi } from 'vitest'
import { PerplLiveAdapter } from '../packages/perpl/src/live.js'
import type { Action } from '../packages/domain/src/index.js'

const rq = '1791001362440'
const before = {
  bookId: 'book',
  side: 'LONG' as const,
  status: 'OPEN' as const,
  size: 0.0005,
  entryPrice: 2700,
  markPrice: 2680,
  liquidationPrice: 2600,
  leverage: 12,
  unrealizedPnl: -0.01,
  margin: 0.12,
}
const context = {
  marketId: 32,
  accountId: 642,
  positionId: 4320379535360,
  position: before,
  headBlock: 100,
  orderTtlBlocks: 20,
  sizeDecimals: 4,
  priceDecimals: 2,
  leverageHundredths: 1200,
  collateralDecimals: 6,
}
const action = (kind: 'REDUCE' | 'EXIT'): Action => ({
  id: 'action',
  bookId: 'book',
  decisionId: 'decision',
  kind,
  amount: 0,
  status: 'UNKNOWN',
  idempotencyKey: 'decision:close',
  venueReference: `642:${rq}`,
  beforeState: { position: before, reserve: {} as never, telemetry: {} as never },
})
const order = (size: number, filled = size, status = 4) => ({
  acc: 642,
  mkt: 32,
  oid: 77,
  rq,
  t: 3,
  os: size,
  fs: filled,
  st: status,
  sr: 0,
  at: { b: 200 },
})
const fill = (size: number) => ({ acc: 642, mkt: 32, oid: 77, t: 3, s: size, at: { b: 201 }, f: '0' })
const position = (size: number, status = 1, id = context.positionId) => ({
  acc: 642,
  mkt: 32,
  pid: id,
  rq,
  oid: 77,
  s: size,
  st: status,
  sd: 1,
  at: { b: 201 },
})
const evidence = (orders: unknown[], fills: unknown[], positions: unknown[]) => ({
  orders,
  fills,
  positions,
  accounts: [],
  collateralSuccess: undefined,
})
const adapter = (result: ReturnType<typeof evidence>) =>
  new PerplLiveAdapter(
    {} as never,
    async () => context,
    { evidence: vi.fn(async () => result) } as never,
    async () => undefined,
  )

describe('Perpl REDUCE and EXIT reconciliation', () => {
  it('confirms REDUCE only after matching fill and smaller open position', async () => {
    const result = await adapter(evidence([order(2)], [fill(2)], [position(2)])).reconcile(action('REDUCE'))
    expect(result).toMatchObject({ status: 'CONFIRMED', error: undefined })
  })

  it('confirms EXIT only after matching full fill and closed position', async () => {
    const result = await adapter(evidence([order(5)], [fill(5)], [position(5, 2)])).reconcile(action('EXIT'))
    expect(result).toMatchObject({ status: 'CONFIRMED', error: undefined })
  })

  it('passes only a verified post-close position to durable state persistence', async () => {
    const persist = vi.fn(async () => undefined)
    const live = new PerplLiveAdapter(
      {} as never,
      async () => context,
      { evidence: vi.fn(async () => evidence([order(5)], [fill(5)], [position(5, 2)])) } as never,
      async () => undefined,
      persist,
    )
    expect(await live.reconcile(action('EXIT'))).toMatchObject({ status: 'CONFIRMED' })
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'EXIT' }),
      expect.anything(),
      expect.objectContaining({ st: 2, s: 5, rq }),
      context,
      0n,
    )
  })

  it('does not mistake later duplicate sr:32 for a failed successful close', async () => {
    const failed = { ...order(2, 0, 7), oid: 78, sr: 32 }
    expect(
      await adapter(evidence([failed, order(2)], [fill(2)], [position(2)])).reconcile(action('REDUCE')),
    ).toMatchObject({ status: 'CONFIRMED' })
  })

  it('keeps incomplete and unbound outcomes unresolved', async () => {
    expect(await adapter(evidence([order(2)], [fill(2)], [position(-1)])).reconcile(action('REDUCE'))).toMatchObject({
      status: 'UNKNOWN',
      error: 'POSITION_NOT_RECONCILED',
    })
    expect(
      await adapter(evidence([order(2)], [fill(2)], [position(3, 1, 999)])).reconcile(action('REDUCE')),
    ).toMatchObject({ status: 'UNKNOWN', error: 'POSITION_NOT_RECONCILED' })
    expect(await adapter(evidence([order(5)], [fill(5)], [position(5, 1)])).reconcile(action('EXIT'))).toMatchObject({
      status: 'UNKNOWN',
      error: 'EXIT_POSITION_REMAINS_OPEN',
    })
    expect(await adapter(evidence([order(2, 0, 2)], [], [])).reconcile(action('REDUCE'))).toMatchObject({
      status: 'UNKNOWN',
      error: 'CLOSE_FILL_PENDING',
    })
    expect(await adapter(evidence([order(5)], [fill(2)], [position(2)])).reconcile(action('EXIT'))).toMatchObject({
      status: 'UNKNOWN',
      error: 'CLOSE_FILL_MISMATCH',
    })
  })

  it('preserves partial, canceled and failed outcomes distinctly', async () => {
    expect(await adapter(evidence([order(5, 2, 3)], [fill(2)], [position(2)])).reconcile(action('EXIT'))).toMatchObject(
      { status: 'PARTIAL', error: 'PARTIAL_CLOSE_REQUIRES_REVIEW' },
    )
    expect(await adapter(evidence([order(2, 0, 5)], [], [])).reconcile(action('REDUCE'))).toMatchObject({
      status: 'CANCELED',
    })
    expect(await adapter(evidence([{ ...order(2, 0, 7), sr: 32 }], [], [])).reconcile(action('REDUCE'))).toMatchObject({
      status: 'FAILED',
      error: 'ORDER_REQUEST_ID_TOO_LOW',
    })
    expect(
      await adapter(evidence([{ ...order(2, 0, 7), t: 4, sr: 11 }], [], [])).reconcile(action('REDUCE')),
    ).toMatchObject({ status: 'FAILED', error: 'CLOSE_ORDER_POSITION_MISMATCH' })
    expect(
      await adapter(evidence([order(5)], [fill(5)], [position(5, 2)])).reconcile({
        ...action('EXIT'),
        beforeState: undefined,
      }),
    ).toMatchObject({ status: 'UNKNOWN', error: 'CLOSE_BASELINE_UNAVAILABLE' })
  })

  it('rejects a side mismatch before invoking the trading client', async () => {
    const submit = vi.fn()
    const live = new PerplLiveAdapter(
      { submit } as never,
      async () => ({ ...context, position: { ...before, side: 'SHORT' } }),
      {} as never,
      async () => undefined,
    )
    await expect(live.submit(action('REDUCE'))).rejects.toThrow('CLOSE_BASELINE_UNAVAILABLE')
    expect(submit).not.toHaveBeenCalled()
  })
})
