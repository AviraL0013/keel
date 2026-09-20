import type { Action, Position } from '../../domain/src/index.js'
import type { PerplOrder } from './trading.js'
import { encodeSize } from './units.js'
import Decimal from 'decimal.js'
export type OrderContext = { marketId: number; accountId: number; position: Position; headBlock: number; orderTtlBlocks: number; sizeDecimals: number; priceDecimals: number; leverageHundredths: number; collateralDecimals: number }
export function buildPerplOrder(action: Action, context: OrderContext): PerplOrder {
  if (!Number.isInteger(context.marketId) || context.marketId <= 0 || !Number.isInteger(context.accountId) || context.accountId <= 0) throw new Error('PERPL_ORDER_CONTEXT_INVALID')
  if (!Number.isFinite(action.amount) || action.amount < 0) throw new Error('PERPL_ACTION_AMOUNT_INVALID')
  const expiry = context.headBlock + context.orderTtlBlocks
  if (action.kind === 'DEFEND') return { mkt: context.marketId, acc: context.accountId, t: 6, s: 0, a: new Decimal(action.amount).toFixed(context.collateralDecimals), lv: context.leverageHundredths, lb: expiry }
  if (context.position.status !== 'OPEN' || context.position.size <= 0) throw new Error('PERPL_POSITION_NOT_OPEN')
  const size = encodeSize(context.position.size, context.sizeDecimals)
  if (size <= 0) throw new Error('PERPL_REDUCE_SIZE_INVALID')
  return { mkt: context.marketId, acc: context.accountId, t: context.position.side === 'LONG' ? 3 : 4, s: size, lv: context.leverageHundredths, lb: expiry, ms: 0 }
}
