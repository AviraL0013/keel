import { expect, it } from 'vitest'
import { deriveEvent } from '../packages/analytics/src/aggregate.js'
import type { DecodedExchangeEvent } from '../packages/analytics/src/decoder.js'

const markets = new Map([[1, { marketId: 1, priceDecimals: 1, sizeDecimals: 4 }]])
const liquidation = (remaining: string, liquidated: string): DecodedExchangeEvent =>
  ({
    eventName: 'PositionLiquidated',
    args: {
      perpId: '1',
      posAccountId: '5438',
      positionType: '0',
      liqPricePNS: '825000',
      liqLotLNS: liquidated,
      posLotLNS: remaining,
      deltaPnlCNS: '-100000',
      fundingCNS: '1000',
    },
  }) as DecodedExchangeEvent

it('uses post-liquidation position lot as remaining size, including a full close at zero', () => {
  const closed = deriveEvent(liquidation('0', '48717'), markets)
  const partial = deriveEvent(liquidation('100', '200'), markets)
  expect(closed).toMatchObject({ kind: 'liquidation', lotRaw: 48717n, remainingLotRaw: 0n })
  expect(partial).toMatchObject({ kind: 'liquidation', lotRaw: 200n, remainingLotRaw: 100n })
})
