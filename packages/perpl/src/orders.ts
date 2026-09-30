import type { Action, Position } from '../../domain/src/index.js'
import type { PerplOrder } from './trading.js'
import { encodeAmount, encodeSize } from './units.js'
import Decimal from 'decimal.js'
export type OrderContext = {
  marketId: number
  accountId: number
  positionId: number
  position: Position
  headBlock: number
  orderTtlBlocks: number
  sizeDecimals: number
  priceDecimals: number
  leverageHundredths: number
  collateralDecimals: number
}
export function buildPerplOrder(action: Action, context: OrderContext): PerplOrder {
  if (
    !Number.isInteger(context.marketId) ||
    context.marketId <= 0 ||
    !Number.isInteger(context.accountId) ||
    context.accountId <= 0
  )
    throw new Error('PERPL_ORDER_CONTEXT_INVALID')
  const lastExecBlock = context.headBlock + context.orderTtlBlocks
  if (
    !Number.isSafeInteger(context.headBlock) ||
    context.headBlock <= 0 ||
    !Number.isSafeInteger(context.orderTtlBlocks) ||
    context.orderTtlBlocks <= 0 ||
    !Number.isSafeInteger(lastExecBlock)
  )
    throw new Error('PERPL_ORDER_EXPIRY_UNAVAILABLE')
  if (!Number.isFinite(action.amount) || action.amount < 0) throw new Error('PERPL_ACTION_AMOUNT_INVALID')
  if (action.kind === 'DEFEND') {
    if (!Number.isSafeInteger(context.positionId) || context.positionId <= 0 || action.amount <= 0)
      throw new Error('PERPL_DEFEND_CONTEXT_INVALID')
    return {
      mkt: context.marketId,
      acc: context.accountId,
      t: 6,
      s: 0,
      a: encodeAmount(new Decimal(action.amount).toFixed(), context.collateralDecimals),
      lp: context.positionId,
      lv: context.leverageHundredths,
      lb: lastExecBlock,
      orderTtlBlocks: context.orderTtlBlocks,
    }
  }
  if (!Number.isSafeInteger(context.positionId) || context.positionId <= 0)
    throw new Error('PERPL_POSITION_BINDING_INVALID')
  if (context.position.status !== 'OPEN' || context.position.size <= 0) throw new Error('PERPL_POSITION_NOT_OPEN')
  const fullSize = encodeSize(context.position.size, context.sizeDecimals)
  if (fullSize <= 0 || !new Decimal(fullSize).div(new Decimal(10).pow(context.sizeDecimals)).eq(context.position.size))
    throw new Error('PERPL_POSITION_SIZE_INVALID')
  const size = action.kind === 'REDUCE' ? Math.floor(fullSize / 2) : fullSize
  if (size <= 0) throw new Error('PERPL_REDUCE_MINIMUM_LOT_UNAVAILABLE')
  if (action.kind !== 'REDUCE' && action.kind !== 'EXIT') throw new Error('PERPL_ACTION_KIND_UNSUPPORTED')
  // Close* orders are reduce-only. A reduction must leave at least one venue lot open.
  return {
    mkt: context.marketId,
    acc: context.accountId,
    t: context.position.side === 'LONG' ? 3 : 4,
    p: 0,
    s: size,
    lp: context.positionId,
    lv: 0,
    lb: lastExecBlock,
    orderTtlBlocks: context.orderTtlBlocks,
  }
}
