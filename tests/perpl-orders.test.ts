import { describe, expect, it } from 'vitest'
import { buildPerplOrder, type OrderContext } from '../packages/perpl/src/orders.js'
import type { Action } from '../packages/domain/src/index.js'

const context: OrderContext = {
  marketId: 16,
  accountId: 642,
  positionId: 4206532886529,
  position: {
    bookId: 'book',
    side: 'LONG',
    status: 'OPEN',
    size: 0.0001,
    entryPrice: 80599.3,
    markPrice: 84038.7,
    liquidationPrice: 78449.99,
    leverage: 15,
    unrealizedPnl: 0.34,
    margin: 0.54,
  },
  headBlock: 100,
  orderTtlBlocks: 20,
  sizeDecimals: 4,
  priceDecimals: 1,
  leverageHundredths: 1500,
  collateralDecimals: 6,
}

describe('Perpl collateral order', () => {
  it('encodes human AUSD into base units and binds the existing position', () => {
    expect(buildPerplOrder({ kind: 'DEFEND', amount: 0.0294 } as Action, context)).toMatchObject({
      mkt: 16,
      acc: 642,
      t: 6,
      s: 0,
      a: '29400',
      lp: 4206532886529,
      lb: 0,
    })
  })

  it('fails closed on invalid position binding or sub-unit precision', () => {
    expect(() => buildPerplOrder({ kind: 'DEFEND', amount: 1 } as Action, { ...context, positionId: 0 })).toThrow(
      'PERPL_DEFEND_CONTEXT_INVALID',
    )
    expect(() => buildPerplOrder({ kind: 'DEFEND', amount: 0.0000001 } as Action, context)).toThrow(
      'AMOUNT_PRECISION_EXCEEDED',
    )
  })
})

describe('Perpl close orders', () => {
  const multiLot = { ...context, position: { ...context.position, size: 0.0005 } }

  it('REDUCE closes a bounded half, leaving venue lots open', () => {
    expect(buildPerplOrder({ kind: 'REDUCE', amount: 0 } as Action, multiLot)).toMatchObject({
      mkt: 16,
      acc: 642,
      t: 3,
      p: 0,
      s: 2,
      lp: 4206532886529,
      lv: 0,
      lb: 0,
    })
    expect(
      buildPerplOrder({ kind: 'REDUCE', amount: 0 } as Action, {
        ...multiLot,
        position: { ...multiLot.position, side: 'SHORT' },
      }),
    ).toMatchObject({ t: 4, s: 2 })
  })

  it('EXIT requests the full position through a reduce-only close', () => {
    expect(buildPerplOrder({ kind: 'EXIT', amount: 0 } as Action, multiLot)).toMatchObject({
      t: 3,
      s: 5,
      lp: 4206532886529,
      lv: 0,
      lb: 0,
    })
  })

  it('does not turn a one-lot REDUCE into a full EXIT', () => {
    expect(() => buildPerplOrder({ kind: 'REDUCE', amount: 0 } as Action, context)).toThrow(
      'PERPL_REDUCE_MINIMUM_LOT_UNAVAILABLE',
    )
    expect(buildPerplOrder({ kind: 'EXIT', amount: 0 } as Action, context).s).toBe(1)
  })

  it('rejects rounded position sizes and missing position binding', () => {
    expect(() =>
      buildPerplOrder({ kind: 'EXIT', amount: 0 } as Action, {
        ...multiLot,
        position: { ...multiLot.position, size: 0.00051 },
      }),
    ).toThrow('PERPL_POSITION_SIZE_INVALID')
    expect(() => buildPerplOrder({ kind: 'EXIT', amount: 0 } as Action, { ...multiLot, positionId: 0 })).toThrow(
      'PERPL_POSITION_BINDING_INVALID',
    )
  })
})
