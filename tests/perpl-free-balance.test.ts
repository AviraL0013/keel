import { describe, expect, it, vi } from 'vitest'
import { assertPerplFreeBalance } from '../server/src/infrastructure/perpl/runtime.js'
import { PerplLiveAdapter } from '../packages/perpl/src/live.js'
import type { Action } from '../packages/domain/src/index.js'

const now = 1_800_000_000_000
const balance = (available: string, locked: string, updatedAt = now) => ({
  available,
  locked,
  decimals: 6,
  updatedAt,
})

describe('Perpl DEFEND free balance', () => {
  it('compares b minus lb exactly at the boundary', () => {
    expect(() => assertPerplFreeBalance(balance('1.180776', '0.200000'), 0.980776, now)).not.toThrow()
    expect(() => assertPerplFreeBalance(balance('1.180775', '0.200000'), 0.980776, now)).toThrow(
      'PERPL_FREE_BALANCE_INSUFFICIENT',
    )
  })

  it.each([
    ['stale', balance('10.000000', '0', now - 10_001)],
    ['missing timestamp', { ...balance('10.000000', '0'), updatedAt: undefined }],
    ['future timestamp', balance('10.000000', '0', now + 1)],
  ])('rejects %s balance before submission', (_name, value) => {
    expect(() => assertPerplFreeBalance(value, 0.980776, now)).toThrow('PERPL_FREE_BALANCE_UNAVAILABLE')
  })

  it('never sends an order when the pre-send balance check fails', async () => {
    const send = vi.fn()
    const client = {
      submit: async (
        action: Action,
        order: unknown,
        persist: (reference: string) => Promise<void>,
        verify: () => Promise<void>,
      ) => {
        await persist('642:45')
        await verify()
        send(action, order)
      },
    }
    const position = {
      bookId: 'book',
      side: 'LONG',
      status: 'OPEN',
      size: 0.03,
      entryPrice: 2600,
      markPrice: 2700,
      liquidationPrice: 2500,
      leverage: 12,
      unrealizedPnl: 0,
      margin: 6.7,
    }
    const live = new PerplLiveAdapter(
      client as never,
      async () =>
        ({
          marketId: 32,
          accountId: 642,
          positionId: 77,
          position,
          headBlock: 100,
          orderTtlBlocks: 20,
          sizeDecimals: 3,
          priceDecimals: 1,
          leverageHundredths: 1200,
          collateralDecimals: 6,
        }) as never,
      {
        evidence: async () => {
          throw new Error('NOT_USED')
        },
      } as never,
      async () => undefined,
      undefined,
      undefined,
      async (action) => assertPerplFreeBalance(balance('0.980775', '0'), action.amount, now),
    )
    await expect(
      live.submit({
        id: 'action',
        bookId: 'book',
        decisionId: 'decision',
        kind: 'DEFEND',
        amount: 0.980776,
        status: 'SUBMITTING',
        idempotencyKey: 'once',
      }),
    ).rejects.toThrow('PERPL_FREE_BALANCE_INSUFFICIENT')
    expect(send).not.toHaveBeenCalled()
  })
})
