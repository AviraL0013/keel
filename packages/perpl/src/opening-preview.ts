import Decimal from 'decimal.js'

const Exact = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_UP })
const MAX_AGE_MS = 5000
export type OpeningInput = { side: 'LONG' | 'SHORT'; size: string; leverage: string; slippageBps?: number }
export type OpeningMarketSnapshot = {
  environment: 'mainnet' | 'testnet'
  accountId: number
  marketId: number
  symbol: string
  collateralAsset: string
  priceDecimals: number
  sizeDecimals: number
  collateralDecimals: number
  bidRaw: number
  askRaw: number
  initialMarginBps: number
  takerFeeMicros: number
  minimumNotionalRaw: string
  recycleFeeRaw: string
  marketOpen: boolean
  marketObservedAt: number
  balanceObservedAt: number
  marketBlock: number
  headBlock: number
  headObservedAt: number
  orderTtlBlocks: number
  freeBalance: string
}
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const digits = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value)
function fixed(value: unknown, decimals: number, code: string) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,30})(\.\d{1,18})?$/.test(value)) throw new Error(code)
  const decimal = new Exact(value)
  if (decimal.decimalPlaces() > decimals) throw new Error(code)
  return decimal
}

/** Read-only estimates, not executable orders or authorizations. Confirmation must revalidate and persist intent. */
export function previewOpeningTrade(
  input: OpeningInput,
  snapshot: OpeningMarketSnapshot,
  now = Date.now(),
  ttlMs = 15_000,
) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60_000) throw new Error('PERPL_OPEN_INPUT_INVALID')
  if (
    !['mainnet', 'testnet'].includes(snapshot.environment) ||
    !uint(snapshot.accountId) ||
    !uint(snapshot.marketId) ||
    !uint(snapshot.orderTtlBlocks) ||
    !uint(snapshot.bidRaw) ||
    !uint(snapshot.askRaw) ||
    snapshot.askRaw < snapshot.bidRaw ||
    !snapshot.marketOpen ||
    !uint(snapshot.initialMarginBps) ||
    snapshot.initialMarginBps > 10000 ||
    !Number.isSafeInteger(snapshot.takerFeeMicros) ||
    snapshot.takerFeeMicros < 0 ||
    snapshot.takerFeeMicros > 1_000_000 ||
    !digits(snapshot.minimumNotionalRaw) ||
    !digits(snapshot.recycleFeeRaw) ||
    ![snapshot.priceDecimals, snapshot.sizeDecimals, snapshot.collateralDecimals].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 18,
    ) ||
    !snapshot.symbol ||
    !snapshot.collateralAsset
  )
    throw new Error('PERPL_OPEN_MARKET_UNAVAILABLE')
  const fresh = (time: number) => Number.isSafeInteger(time) && time > 0 && time <= now && now - time <= MAX_AGE_MS
  if (
    !Number.isSafeInteger(now) ||
    !fresh(snapshot.marketObservedAt) ||
    !fresh(snapshot.headObservedAt) ||
    !uint(snapshot.headBlock) ||
    !uint(snapshot.marketBlock) ||
    snapshot.marketBlock > snapshot.headBlock ||
    snapshot.headBlock - snapshot.marketBlock > 3
  )
    throw new Error('PERPL_OPEN_MARKET_STALE')
  if (!fresh(snapshot.balanceObservedAt)) throw new Error('PERPL_FREE_BALANCE_UNAVAILABLE')
  const balance = fixed(snapshot.freeBalance, snapshot.collateralDecimals, 'PERPL_FREE_BALANCE_UNAVAILABLE')
  const slippageBps = input?.slippageBps ?? 50
  if (
    !input ||
    !['LONG', 'SHORT'].includes(input.side) ||
    !Number.isSafeInteger(slippageBps) ||
    slippageBps < 1 ||
    slippageBps > 200
  )
    throw new Error('PERPL_OPEN_INPUT_INVALID')
  const size = fixed(input.size, snapshot.sizeDecimals, 'PERPL_OPEN_INPUT_INVALID')
  const leverage = fixed(input.leverage, 2, 'PERPL_OPEN_INPUT_INVALID')
  const sizeRaw = size.mul(new Exact(10).pow(snapshot.sizeDecimals))
  if (
    sizeRaw.lte(0) ||
    sizeRaw.gt(Number.MAX_SAFE_INTEGER) ||
    leverage.lt(1) ||
    leverage.mul(snapshot.initialMarginBps).gt(10000)
  )
    throw new Error('PERPL_OPEN_INPUT_INVALID')
  const buy = input.side === 'LONG'
  const referenceRaw = new Exact(buy ? snapshot.askRaw : snapshot.bidRaw)
  const priceScale = new Exact(10).pow(snapshot.priceDecimals)
  // Inward rounding preserves the caller's maximum slippage, even with coarse price ticks.
  const limitRaw = referenceRaw
    .mul(10000 + (buy ? 1 : -1) * slippageBps)
    .div(10000)
    .toDecimalPlaces(0, buy ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL)
  if (limitRaw.lte(0) || limitRaw.gt(Number.MAX_SAFE_INTEGER)) throw new Error('PERPL_OPEN_INPUT_INVALID')
  const referencePrice = referenceRaw.div(priceScale)
  const collateralScale = new Exact(10).pow(snapshot.collateralDecimals)
  const notional = size.mul(Exact.max(referenceRaw, limitRaw).div(priceScale))
  if (notional.mul(collateralScale).lt(snapshot.minimumNotionalRaw)) throw new Error('PERPL_OPEN_BELOW_MINIMUM')
  const round = (value: Decimal) => value.toDecimalPlaces(snapshot.collateralDecimals, Decimal.ROUND_CEIL)
  const margin = round(notional.div(leverage))
  const fee = round(notional.mul(snapshot.takerFeeMicros).div(1_000_000))
  const recycle = new Exact(snapshot.recycleFeeRaw).div(collateralScale)
  const required = margin.plus(fee).plus(recycle)
  if (balance.lt(required)) throw new Error('PERPL_FREE_BALANCE_INSUFFICIENT')
  const money = (value: Decimal) => value.toFixed(snapshot.collateralDecimals)
  return {
    authorization: 'PREVIEW_ONLY' as const,
    environment: snapshot.environment,
    accountId: snapshot.accountId,
    marketId: snapshot.marketId,
    market: snapshot.symbol,
    collateralAsset: snapshot.collateralAsset,
    side: input.side,
    size: size.toFixed(snapshot.sizeDecimals),
    sizeRaw: sizeRaw.toNumber(),
    leverage: leverage.toFixed(2),
    leverageHundredths: leverage.mul(100).toNumber(),
    referencePrice: referencePrice.toFixed(snapshot.priceDecimals),
    limitPrice: limitRaw.div(priceScale).toFixed(snapshot.priceDecimals),
    limitPriceRaw: limitRaw.toNumber(),
    slippageBps,
    estimatedNotional: money(round(notional)),
    estimatedMargin: money(margin),
    estimatedTradingFee: money(fee),
    recycleFee: money(recycle),
    estimatedRequiredBalance: money(required),
    negativePnlCollateralBps: 0,
    builderFeePer100K: 0,
    observedBlock: snapshot.marketBlock,
    orderTtlBlocks: snapshot.orderTtlBlocks,
    expiresAt: now + ttlMs,
  }
}
