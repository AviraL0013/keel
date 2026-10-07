import { formatMoney } from '../../ausd/src/money.js'
import type { DecodedExchangeEvent } from './decoder.js'

export interface MarketPrecision {
  marketId: number
  priceDecimals: number
  sizeDecimals: number
}
export type DerivedEvent =
  | { kind: 'account'; accountId: string; address: string }
  | { kind: 'flow'; accountId: string; direction: 'deposit' | 'withdrawal'; amountMicros: bigint }
  | {
      kind: 'fill'
      accountId: string
      marketId: number
      priceRaw: bigint
      sizeRaw: bigint
      notionalMicros: bigint
      feeMicros: bigint
      builderFeeMicros: bigint
    }
  | { kind: 'taker_fee'; feeMicros: bigint; builderFeeMicros: bigint }
  | {
      kind: 'liquidation'
      accountId: string
      marketId: number
      side: 'long' | 'short'
      lotRaw: bigint
      remainingLotRaw: bigint
      priceRaw: bigint
      notionalMicros: bigint
      realizedPnlMicros: bigint
    }
  | {
      kind: 'position'
      accountId: string
      marketId: number
      side: 'long' | 'short'
      action: 'open' | 'increase' | 'reduce' | 'close' | 'liquidation' | 'invert'
      sizeRaw: bigint | null
      entryPriceRaw: bigint | null
      leverageHundredths: bigint | null
      collateralMicros: bigint | null
      realizedPnlMicros: bigint | null
      protocolFeeMicros: bigint | null
    }

function integer(args: DecodedExchangeEvent['args'], key: string): bigint {
  const value = args[key]
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error(`INVALID_EVENT_${key}`)
  return BigInt(value)
}
function side(args: DecodedExchangeEvent['args']): 'long' | 'short' {
  const value = integer(args, 'positionType')
  if (value === 0n) return 'long'
  if (value === 1n) return 'short'
  throw new Error('INVALID_POSITION_SIDE')
}
function precisionFor(event: DecodedExchangeEvent, markets: Map<number, MarketPrecision>): MarketPrecision {
  const marketId = Number(integer(event.args, 'perpId'))
  const precision = markets.get(marketId)
  if (!precision || !Number.isSafeInteger(marketId)) throw new Error('UNKNOWN_MARKET_PRECISION')
  return precision
}

/** Price and lot are scaled integers. Round each settlement to nearest AUSD micro. */
export function notionalMicros(priceRaw: bigint, sizeRaw: bigint, priceDecimals: number, sizeDecimals: number): bigint {
  if (
    priceRaw < 0n ||
    sizeRaw < 0n ||
    !Number.isInteger(priceDecimals) ||
    !Number.isInteger(sizeDecimals) ||
    priceDecimals < 0 ||
    sizeDecimals < 0 ||
    priceDecimals > 18 ||
    sizeDecimals > 18
  )
    throw new Error('INVALID_NOTIONAL')
  const divisor = 10n ** BigInt(priceDecimals + sizeDecimals)
  return (priceRaw * sizeRaw * 1_000_000n + divisor / 2n) / divisor
}
export function signedMoney(micros: bigint): string {
  return micros < 0n ? `-${formatMoney(-micros)}` : formatMoney(micros)
}
export function sumMicros(values: Iterable<bigint>): bigint {
  let result = 0n
  for (const value of values) result += value
  return result
}

/** Return only fields supported by decoded on-chain evidence. */
export function deriveEvent(event: DecodedExchangeEvent, markets: Map<number, MarketPrecision>): DerivedEvent | null {
  const a = event.args
  switch (event.eventName) {
    case 'AccountCreated': {
      if (typeof a.account !== 'string') throw new Error('INVALID_ACCOUNT_ADDRESS')
      return { kind: 'account', accountId: integer(a, 'id').toString(), address: a.account.toLowerCase() }
    }
    case 'CollateralDeposit':
    case 'CollateralWithdrawal':
      return {
        kind: 'flow',
        accountId: integer(a, 'accountId').toString(),
        direction: event.eventName === 'CollateralDeposit' ? 'deposit' : 'withdrawal',
        amountMicros: integer(a, 'amountCNS'),
      }
    case 'MakerOrderFilled':
    case 'MakerOrderFilledV2': {
      const market = precisionFor(event, markets)
      const priceRaw = integer(a, 'pricePNS')
      const sizeRaw = integer(a, 'lotLNS')
      return {
        kind: 'fill',
        accountId: integer(a, 'accountId').toString(),
        marketId: market.marketId,
        priceRaw,
        sizeRaw,
        notionalMicros: notionalMicros(priceRaw, sizeRaw, market.priceDecimals, market.sizeDecimals),
        feeMicros: integer(a, 'feeCNS'),
        builderFeeMicros: a.builderFeeCNS ? integer(a, 'builderFeeCNS') : 0n,
      }
    }
    case 'TakerOrderFilled':
    case 'TakerOrderFilledV2':
      return {
        kind: 'taker_fee',
        feeMicros: integer(a, 'feeCNS'),
        builderFeeMicros: a.builderFeeCNS ? integer(a, 'builderFeeCNS') : 0n,
      }
    case 'PositionLiquidated': {
      const market = precisionFor(event, markets)
      const priceRaw = integer(a, 'liqPricePNS')
      const lotRaw = integer(a, 'liqLotLNS')
      const remainingLotRaw = integer(a, 'posLotLNS') - lotRaw
      if (remainingLotRaw < 0n) throw new Error('INVALID_LIQUIDATION_SIZE')
      return {
        kind: 'liquidation',
        accountId: integer(a, 'posAccountId').toString(),
        marketId: market.marketId,
        side: side(a),
        lotRaw,
        remainingLotRaw,
        priceRaw,
        notionalMicros: notionalMicros(priceRaw, lotRaw, market.priceDecimals, market.sizeDecimals),
        realizedPnlMicros: integer(a, 'deltaPnlCNS') + integer(a, 'fundingCNS'),
      }
    }
    case 'PositionInverted': {
      const market = precisionFor(event, markets)
      return {
        kind: 'position',
        accountId: integer(a, 'accountId').toString(),
        marketId: market.marketId,
        side: side(a),
        action: 'invert',
        sizeRaw: integer(a, 'endLotLNS'),
        entryPriceRaw: integer(a, 'pricePNS'),
        leverageHundredths: integer(a, 'leverageHdths'),
        collateralMicros: integer(a, 'endDepositCNS'),
        realizedPnlMicros: integer(a, 'deltaPnlCNS') + integer(a, 'fundingCNS'),
        protocolFeeMicros: integer(a, 'protFeeCNS'),
      }
    }
    case 'PositionOpened':
    case 'PositionOpenedV2':
    case 'PositionIncreased':
    case 'PositionIncreasedV2':
    case 'PositionDecreased':
    case 'PositionClosed': {
      const market = precisionFor(event, markets)
      const open = event.eventName.startsWith('PositionOpened')
      const increase = event.eventName.startsWith('PositionIncreased')
      const reduce = event.eventName === 'PositionDecreased'
      return {
        kind: 'position',
        accountId: integer(a, 'accountId').toString(),
        marketId: market.marketId,
        side: side(a),
        action: open ? 'open' : increase ? 'increase' : reduce ? 'reduce' : 'close',
        sizeRaw: open ? integer(a, 'lotLNS') : increase || reduce ? integer(a, 'endLotLNS') : null,
        entryPriceRaw: open ? integer(a, 'pricePNS') : null,
        leverageHundredths: open || increase ? integer(a, 'leverageHdths') : null,
        collateralMicros: open ? integer(a, 'depositCNS') : increase || reduce ? integer(a, 'endDepositCNS') : null,
        realizedPnlMicros:
          reduce || event.eventName === 'PositionClosed' ? integer(a, 'deltaPnlCNS') + integer(a, 'fundingCNS') : null,
        protocolFeeMicros: open || increase ? integer(a, 'protFeeCNS') : null,
      }
    }
    default:
      return null
  }
}
