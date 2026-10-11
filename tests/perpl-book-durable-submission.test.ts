import { expect, it, vi } from 'vitest'
import type { Action, VenueProgress } from '../packages/domain/src/index.js'
import { PerplLiveAdapter, type ReconciliationContext } from '../packages/perpl/src/live.js'
import { PerplPreSubmissionError } from '../packages/perpl/src/trading.js'

const prepared: VenueProgress = {
  requestId: '45',
  clientSequence: 1,
  admitted: false,
  response: 'PREPARED',
  requestedLastExecBlock: 120,
  sentHeartbeatHead: 100,
  sentHeartbeatSequence: 10,
  streamEpoch: 'synthetic',
  orderStatusReceived: false,
}
const position = {
  bookId: 'book',
  side: 'LONG' as const,
  status: 'OPEN' as const,
  size: 1,
  entryPrice: 100,
  markPrice: 95,
  liquidationPrice: 90,
  leverage: 5,
  unrealizedPnl: -5,
  margin: 20,
}
const context: ReconciliationContext = {
  accountId: 642,
  marketId: 1,
  positionId: 7,
  position,
  headBlock: 100,
  orderTtlBlocks: 20,
  sizeDecimals: 2,
  priceDecimals: 2,
  leverageHundredths: 500,
  collateralDecimals: 6,
}
const makeAction = (): Action => ({
  id: 'action',
  bookId: 'book',
  decisionId: 'decision',
  kind: 'DEFEND',
  amount: 1,
  status: 'SUBMITTING',
  idempotencyKey: 'synthetic',
})
const evidence = async () => ({ orders: [], fills: [], positions: [], accounts: [] })

it('persists exact Book request, bound and verification timestamp before wire; restart reconciles without resending', async () => {
  let durable: Action | undefined
  const send = vi.fn()
  const client = {
    submit: async (
      _action: Action,
      _order: unknown,
      persist: (reference: string, lb: number, progress: VenueProgress) => Promise<void>,
      verify: () => Promise<void>,
    ) => {
      await persist('642:45', 120, prepared)
      expect(durable).toMatchObject({
        venueReference: '642:45',
        venueProgress: prepared,
        submittedAt: new Date(1000).toISOString(),
      })
      await verify()
      send()
      throw new Error('SYNTHETIC_PROCESS_LOST_AFTER_WRITE')
    },
    accountRequestState: async () => ({ lfr: '44', block: 121 }),
  }
  const live = new PerplLiveAdapter(
    client as never,
    async () => context,
    { evidence } as never,
    async (action) => {
      durable = structuredClone(action)
    },
    undefined,
    undefined,
    undefined,
    180_000,
    () => 1000,
  )
  await expect(live.submit(makeAction())).rejects.toThrow('SYNTHETIC_PROCESS_LOST_AFTER_WRITE')
  expect(send).toHaveBeenCalledOnce()
  const restarted = new PerplLiveAdapter(
    client as never,
    async () => context,
    { evidence } as never,
    async () => {},
    undefined,
    undefined,
    undefined,
    180_000,
    () => 2000,
  )
  const result = await restarted.reconcile({ ...durable!, status: 'UNKNOWN' })
  expect(result).toMatchObject({ status: 'FAILED', error: 'PERPL_ORDER_WINDOW_EXPIRED' })
  expect(send).toHaveBeenCalledOnce()
})

it('checks authorization after venue preparation and refuses wire submission', async () => {
  const order: string[] = []
  const client = {
    submit: async (
      _action: Action,
      _order: unknown,
      persist: (reference: string, lb: number, progress: VenueProgress) => Promise<void>,
      verify: () => Promise<void>,
    ) => {
      await persist('642:45', 120, prepared)
      await verify()
      order.push('wire')
    },
  }
  const live = new PerplLiveAdapter(
    client as never,
    async () => context,
    { evidence } as never,
    async () => {
      order.push('durable')
    },
    undefined,
    undefined,
    async () => {
      order.push('venue')
    },
  )
  await expect(
    live.submit(makeAction(), async () => {
      order.push('authorization')
      throw new PerplPreSubmissionError('BOOK_NOT_ACTIVE')
    }),
  ).rejects.toThrow('BOOK_NOT_ACTIVE')
  expect(order).toEqual(['durable', 'venue', 'authorization'])
})
