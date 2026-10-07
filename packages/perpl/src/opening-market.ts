import Decimal from 'decimal.js'
import type { OpeningMarketSnapshot } from './opening-preview.js'
import type { PerplBalance } from './index.js'

type Market = {
  id: number
  symbol: string
  instance_id?: number
  order_ttl_blocks?: number
  config: Record<string, unknown>
  state: Record<string, unknown>
}
type Context = {
  instances: Array<{ id: number; collateral_token_id: number }>
  tokens: Array<{ id?: number; symbol?: string; decimals: number }>
  markets: Market[]
}
type Head = { head: number; observedAt: number }
export type OpeningMarketDetail = OpeningMarketSnapshot & {
  markRaw: number
  priceTick: string
  sizeStep: string
  minimumSize: string
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const positive = (value: unknown): value is number => integer(value) && value > 0
const raw = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)

export function listOpeningMarkets(context: Context) {
  if (
    !Array.isArray(context.markets) ||
    context.markets.some(
      (market) => !positive(market.id) || !market.symbol || typeof market.config?.is_open !== 'boolean',
    )
  )
    throw new Error('PERPL_OPEN_MARKET_UNAVAILABLE')
  return context.markets.map((market) => ({
    id: market.id,
    symbol: market.symbol,
    status: market.config.is_open ? ('OPEN' as const) : ('CLOSED' as const),
  }))
}

/** Derives a user-account quote from freshly observed venue context and signed wallet state. */
export function openingMarketSnapshot(
  context: Context,
  marketId: number,
  accountId: number,
  environment: 'testnet' | 'mainnet',
  balance: PerplBalance,
  head: Head,
  feeTier: number,
  now = Date.now(),
): OpeningMarketDetail {
  const market = context.markets.find((item) => item.id === marketId)
  const config = market?.config,
    state = market?.state
  const instance = context.instances.find((item) => item.id === market?.instance_id)
  const token = context.tokens.find((item) => item.id === instance?.collateral_token_id)
  const stamp = state?.at as { b?: unknown } | undefined
  const priceDecimals = config?.price_decimals,
    sizeDecimals = config?.size_decimals
  const minimum = config?.min_settle_amount,
    posting = config?.min_posting_amount
  const fees = config?.taker_fees
  const fee = Array.isArray(fees) ? fees[feeTier] : config?.taker_fee
  if (
    !market ||
    !positive(accountId) ||
    !token?.symbol ||
    !integer(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 18 ||
    !integer(priceDecimals) ||
    priceDecimals < 0 ||
    priceDecimals > 18 ||
    !integer(sizeDecimals) ||
    sizeDecimals < 0 ||
    sizeDecimals > 18 ||
    !positive(market.order_ttl_blocks) ||
    typeof config?.is_open !== 'boolean' ||
    !positive(config.initial_margin) ||
    config.initial_margin > 10000 ||
    !integer(fee) ||
    fee < 0 ||
    fee > 1_000_000 ||
    !raw(minimum) ||
    !raw(posting) ||
    !raw(config.recycle_fee) ||
    !positive(state?.bid) ||
    !positive(state?.ask) ||
    !positive(state?.mrk) ||
    state.ask < state.bid ||
    !integer(feeTier) ||
    feeTier < 0
  )
    throw new Error('PERPL_OPEN_MARKET_UNAVAILABLE')
  const fresh = (time: unknown) => integer(time) && time > 0 && time <= now && now - time <= 5000
  if (
    !fresh(head.observedAt) ||
    !positive(head.head) ||
    !positive(stamp?.b) ||
    stamp.b > head.head ||
    head.head - stamp.b > 3
  )
    throw new Error('PERPL_OPEN_MARKET_STALE')
  if (
    !fresh(balance.updatedAt) ||
    !positive(balance.observedBlock) ||
    balance.observedBlock > head.head ||
    head.head - balance.observedBlock > 3 ||
    balance.decimals !== token.decimals
  )
    throw new Error('PERPL_FREE_BALANCE_UNAVAILABLE')
  let free: Decimal
  try {
    free = new Decimal(balance.available).minus(new Decimal(balance.locked))
    if (!free.isFinite() || free.lt(0) || free.decimalPlaces() > token.decimals) throw new Error()
  } catch {
    throw new Error('PERPL_FREE_BALANCE_UNAVAILABLE')
  }
  const minimumRaw = BigInt(minimum) > BigInt(posting) ? BigInt(minimum) : BigInt(posting)
  const sizeScale = 10n ** BigInt(sizeDecimals)
  const priceScale = 10n ** BigInt(priceDecimals)
  const collateralScale = 10n ** BigInt(token.decimals)
  const minSizeRaw =
    (minimumRaw * sizeScale * priceScale + BigInt(state.ask) * collateralScale - 1n) /
    (BigInt(state.ask) * collateralScale)
  if (minSizeRaw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PERPL_OPEN_MARKET_UNAVAILABLE')
  const step = (decimals: number) => new Decimal(1).div(new Decimal(10).pow(decimals)).toFixed(decimals)
  return {
    environment,
    accountId,
    marketId,
    symbol: market.symbol,
    collateralAsset: token.symbol,
    priceDecimals,
    sizeDecimals,
    collateralDecimals: token.decimals,
    bidRaw: state.bid,
    askRaw: state.ask,
    markRaw: state.mrk,
    initialMarginBps: config.initial_margin,
    takerFeeMicros: fee,
    minimumNotionalRaw: minimumRaw.toString(),
    recycleFeeRaw: config.recycle_fee,
    marketOpen: config.is_open,
    marketObservedAt: now,
    balanceObservedAt: balance.updatedAt!,
    marketBlock: stamp.b,
    headBlock: head.head,
    headObservedAt: head.observedAt,
    orderTtlBlocks: market.order_ttl_blocks,
    freeBalance: free.toFixed(token.decimals),
    priceTick: step(priceDecimals),
    sizeStep: step(sizeDecimals),
    minimumSize: new Decimal(minSizeRaw.toString()).div(sizeScale.toString()).toFixed(sizeDecimals),
  }
}
