import { describe, expect, it } from 'vitest'
import { buildPerplOrder, type OrderContext } from '../packages/perpl/src/orders.js'
import type { Action } from '../packages/domain/src/index.js'

const context: OrderContext = {
  marketId: 16, accountId: 642, positionId: 4206532886529,
  position: { bookId: 'book', side: 'LONG', status: 'OPEN', size: 0.0001, entryPrice: 80599.3, markPrice: 84038.7, liquidationPrice: 78449.99, leverage: 15, unrealizedPnl: 0.34, margin: 0.54 },
  headBlock: 100, orderTtlBlocks: 20, sizeDecimals: 4, priceDecimals: 1, leverageHundredths: 1500, collateralDecimals: 6,
}

describe('Perpl collateral order', () => {
  it('encodes human AUSD into base units and binds the existing position', () => {
    expect(buildPerplOrder({ kind: 'DEFEND', amount: 0.0294 } as Action, context)).toMatchObject({
      mkt: 16, acc: 642, t: 6, s: 0, a: '29400', lp: 4206532886529, lb: 120,
    })
  })

  it('fails closed on invalid position binding or sub-unit precision', () => {
    expect(() => buildPerplOrder({ kind: 'DEFEND', amount: 1 } as Action, { ...context, positionId: 0 })).toThrow('PERPL_DEFEND_CONTEXT_INVALID')
    expect(() => buildPerplOrder({ kind: 'DEFEND', amount: 0.0000001 } as Action, context)).toThrow('AMOUNT_PRECISION_EXCEEDED')
  })
})
