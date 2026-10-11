import { getAddress } from 'viem'
import { formatMoney } from '../../../../packages/ausd/src/money.js'
import { notionalMicros, signedMoney, type MarketPrecision } from '../../../../packages/analytics/src/aggregate.js'
import type { Trade, TradePage } from '../../../../packages/analytics/src/contract.js'
import {
  decodeExchangeLog,
  EXCHANGE,
  type ChainLog,
  type DecodedExchangeEvent,
} from '../../../../packages/analytics/src/decoder.js'
import { scaledText } from './perpl-public.js'
import type { HistoricalOwnerProof } from './owner-proof.js'

const hashPattern = /^0x[0-9a-f]{64}$/i
const integer = (args: DecodedExchangeEvent['args'], key: string): bigint => {
  const raw = args[key]
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) throw Error(`ANALYTICS_HISTORY_${key}_INVALID`)
  return BigInt(raw)
}

export interface WalletReceiptEvidence {
  status: 'success' | 'reverted'
  blockNumber: bigint
  blockHash: string
  blockTimestamp: bigint // seconds, from a matching canonical block header
  transactionHash: string
  transactionIndex: number
  logs: ChainLog[] // complete eth_getTransactionReceipt.logs, including other contracts
}

export interface AttributedTakerFill {
  accountId: bigint
  marketId: number
  action: 'open' | 'increase' | 'reduce'
  side: 'long' | 'short'
  block: bigint
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
  at: string
  sizeRaw: bigint
  priceRaw: bigint
  notionalMicros: bigint
  feeMicros: bigint
  builderFeeMicros: bigint
  realizedPnlMicros: bigint | null // delta + funding, before trading fees
  sizeDecimals: number
  priceDecimals: number
}

export interface AttributedReceipt {
  fills: AttributedTakerFill[]
  unresolvedLogIndexes: number[]
}

/** Gross settlement delta + funding. An unwind has no equivalent published fields. */
export function settlementEvidence(event: DecodedExchangeEvent): {
  accountId: bigint
  marketId: bigint
  kind: 'reduce' | 'close' | 'invert' | 'liquidation' | 'deleveraging' | 'unwinding'
  grossRealizedMicros: bigint | null
} | null {
  const names = {
    PositionDecreased: 'reduce',
    PositionClosed: 'close',
    PositionInverted: 'invert',
    PositionLiquidated: 'liquidation',
    PositionDeleveraged: 'deleveraging',
    PositionDeleveragedV2: 'deleveraging',
    PositionUnwound: 'unwinding',
    PositionUnwoundV2: 'unwinding',
  } as const
  const kind = names[event.eventName as keyof typeof names]
  if (!kind) return null
  const accountId = integer(event.args, kind === 'liquidation' ? 'posAccountId' : 'accountId')
  const marketId = integer(event.args, 'perpId')
  if (accountId <= 0n || marketId <= 0n) throw Error('ANALYTICS_SETTLEMENT_ID_INVALID')
  return {
    accountId,
    marketId,
    kind,
    grossRealizedMicros:
      kind === 'unwinding' ? null : integer(event.args, 'deltaPnlCNS') + integer(event.args, 'fundingCNS'),
  }
}

function checkedReceipt(receipt: WalletReceiptEvidence): Array<DecodedExchangeEvent | null> {
  if (
    receipt.status !== 'success' ||
    receipt.blockNumber <= 0n ||
    !Number.isSafeInteger(Number(receipt.blockNumber)) ||
    !hashPattern.test(receipt.blockHash) ||
    !hashPattern.test(receipt.transactionHash) ||
    !Number.isSafeInteger(receipt.transactionIndex) ||
    receipt.transactionIndex < 0 ||
    !Number.isSafeInteger(Number(receipt.blockTimestamp) * 1000) ||
    receipt.blockTimestamp < 0n ||
    Number(receipt.blockTimestamp) * 1000 > Date.now() + 30_000
  )
    throw Error('ANALYTICS_RECEIPT_UNVERIFIED')
  let previous = -1
  return receipt.logs.map((log) => {
    const logIndex = Number(BigInt(log.logIndex))
    if (
      log.removed ||
      BigInt(log.blockNumber) !== receipt.blockNumber ||
      log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
      Number(BigInt(log.transactionIndex)) !== receipt.transactionIndex ||
      !Number.isSafeInteger(logIndex) ||
      logIndex <= previous
    )
      throw Error('ANALYTICS_RECEIPT_LOG_MISMATCH')
    previous = logIndex
    return log.address.toLowerCase() === EXCHANGE.toLowerCase() ? decodeExchangeLog(log) : null
  })
}

function positionDelta(event: DecodedExchangeEvent): { action: AttributedTakerFill['action']; size: bigint } | null {
  const a = event.args
  switch (event.eventName) {
    case 'PositionOpened':
    case 'PositionOpenedV2':
      return { action: 'open', size: integer(a, 'lotLNS') }
    case 'PositionIncreased':
    case 'PositionIncreasedV2':
      return { action: 'increase', size: integer(a, 'endLotLNS') - integer(a, 'startLotLNS') }
    case 'PositionDecreased':
      return { action: 'reduce', size: integer(a, 'startLotLNS') - integer(a, 'endLotLNS') }
    default:
      return null
  }
}

/** Attribute only adjacent, size-matched taker settlement pairs in a complete successful receipt. */
export function attributeTakerFills(
  receipt: WalletReceiptEvidence,
  markets: Map<number, MarketPrecision>, // keyed by Exchange perpetual ID
): AttributedReceipt {
  const decoded = checkedReceipt(receipt)
  const fills: AttributedTakerFill[] = []
  const unresolvedLogIndexes: number[] = []
  for (let i = 0; i < decoded.length; i++) {
    const taker = decoded[i]
    if (taker?.eventName !== 'TakerOrderFilled' && taker?.eventName !== 'TakerOrderFilledV2') continue
    const position = decoded[i - 1]
    const delta = position && positionDelta(position)
    const marketRaw = position?.args.perpId
    const marketId = typeof marketRaw === 'string' && /^\d+$/.test(marketRaw) ? Number(marketRaw) : NaN
    const market = markets.get(marketId)
    const size = integer(taker.args, 'lotLNS')
    const price = integer(taker.args, 'entryPricePNS')
    const fee = integer(taker.args, 'feeCNS')
    const builderFee = taker.eventName === 'TakerOrderFilledV2' ? integer(taker.args, 'builderFeeCNS') : 0n
    if (
      !position ||
      position.logIndex + 1 !== taker.logIndex ||
      !delta ||
      delta.size !== size ||
      size <= 0n ||
      price <= 0n ||
      fee < 0n ||
      builderFee < 0n ||
      builderFee > fee ||
      !market ||
      !Number.isSafeInteger(marketId) ||
      !Number.isSafeInteger(market.marketId) ||
      ((delta.action === 'open' || delta.action === 'increase') &&
        integer(position.args, 'insFeeCNS') + integer(position.args, 'protFeeCNS') !== fee) ||
      (delta.action === 'open' && integer(position.args, 'pricePNS') !== price)
    ) {
      unresolvedLogIndexes.push(taker.logIndex)
      continue
    }
    const accountId = integer(position.args, 'accountId')
    const side = integer(position.args, 'positionType')
    if (accountId <= 0n || (side !== 0n && side !== 1n)) {
      unresolvedLogIndexes.push(taker.logIndex)
      continue
    }
    fills.push({
      accountId,
      marketId: market.marketId,
      action: delta.action,
      side: side === 0n ? 'long' : 'short',
      block: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      transactionHash: receipt.transactionHash.toLowerCase(),
      transactionIndex: receipt.transactionIndex,
      logIndex: taker.logIndex,
      at: new Date(Number(receipt.blockTimestamp) * 1000).toISOString(),
      sizeRaw: size,
      priceRaw: price,
      notionalMicros: notionalMicros(price, size, market.priceDecimals, market.sizeDecimals),
      feeMicros: fee,
      builderFeeMicros: builderFee,
      realizedPnlMicros:
        delta.action === 'reduce' ? integer(position.args, 'deltaPnlCNS') + integer(position.args, 'fundingCNS') : null,
      sizeDecimals: market.sizeDecimals,
      priceDecimals: market.priceDecimals,
    })
  }
  return { fills, unresolvedLogIndexes }
}

export interface VerifiedHistoryTrade {
  trade: Trade
  block: bigint
  transactionIndex: number
  logIndex: number
}

/** Every fill gets its own exact-block owner proof. No account ID timeline is inferred. */
export async function walletTakerTrades(
  address: string,
  fills: AttributedTakerFill[],
  ownerAt: (accountId: bigint, block: bigint, hash: string) => Promise<HistoricalOwnerProof>,
): Promise<VerifiedHistoryTrade[]> {
  const target = getAddress(address)
  const trades: VerifiedHistoryTrade[] = []
  const transactionBlocks = new Map<string, string>()
  for (const fill of fills) {
    const blockIdentity = `${fill.block}:${fill.blockHash.toLowerCase()}`
    const prior = transactionBlocks.get(fill.transactionHash.toLowerCase())
    if (prior && prior !== blockIdentity) throw Error('ANALYTICS_HISTORY_TX_REORG')
    transactionBlocks.set(fill.transactionHash.toLowerCase(), blockIdentity)
    const proof = await ownerAt(fill.accountId, fill.block, fill.blockHash)
    if (
      proof.accountId !== String(fill.accountId) ||
      proof.block !== String(fill.block) ||
      proof.blockHash.toLowerCase() !== fill.blockHash.toLowerCase()
    )
      throw Error('ANALYTICS_HISTORY_OWNER_MISMATCH')
    if (getAddress(proof.address) !== target) continue
    trades.push({
      block: fill.block,
      transactionIndex: fill.transactionIndex,
      logIndex: fill.logIndex,
      trade: {
        id: `${fill.block}:${fill.transactionHash}:${fill.logIndex}`,
        time: fill.at,
        marketId: fill.marketId,
        side: fill.side,
        action: fill.action,
        size: scaledText(fill.sizeRaw, fill.sizeDecimals),
        price: scaledText(fill.priceRaw, fill.priceDecimals),
        notional: formatMoney(fill.notionalMicros),
        fee: formatMoney(fill.feeMicros),
        realizedPnl: fill.realizedPnlMicros === null ? null : signedMoney(fill.realizedPnlMicros),
        transactionHash: fill.transactionHash,
      },
    })
  }
  return trades
}

const before = (left: readonly [bigint, number, number], right: readonly [bigint, number, number]) =>
  left[0] < right[0] || (left[0] === right[0] && (left[1] < right[1] || (left[1] === right[1] && left[2] < right[2])))

/** Page a complete candidate set using the route's existing block/tx/log cursor. */
export function pageVerifiedWalletTrades(items: VerifiedHistoryTrade[], limit: number, cursor?: string): TradePage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('ANALYTICS_HISTORY_LIMIT_INVALID')
  let boundary: readonly [bigint, number, number] | null = null
  if (cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw Error('INVALID')
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 3 ||
        typeof parsed[0] !== 'string' ||
        !/^\d+$/.test(parsed[0]) ||
        !Number.isSafeInteger(parsed[1]) ||
        parsed[1] < 0 ||
        !Number.isSafeInteger(parsed[2]) ||
        parsed[2] < 0
      )
        throw Error('INVALID')
      boundary = [BigInt(parsed[0]), parsed[1], parsed[2]]
    } catch {
      throw Error('ANALYTICS_HISTORY_CURSOR_INVALID')
    }
  }
  const distinct = new Map<string, VerifiedHistoryTrade>()
  const slots = new Set<string>()
  const transactionBlocks = new Map<string, bigint>()
  for (const item of items) {
    if (
      item.block < 0n ||
      !Number.isSafeInteger(item.transactionIndex) ||
      item.transactionIndex < 0 ||
      !Number.isSafeInteger(item.logIndex) ||
      item.logIndex < 0
    )
      throw Error('ANALYTICS_HISTORY_ITEM_INVALID')
    const priorBlock = transactionBlocks.get(item.trade.transactionHash.toLowerCase())
    if (priorBlock !== undefined && priorBlock !== item.block) throw Error('ANALYTICS_HISTORY_TX_REORG')
    transactionBlocks.set(item.trade.transactionHash.toLowerCase(), item.block)
    const slot = `${item.block}:${item.transactionIndex}:${item.logIndex}`
    if (slots.has(slot) && !distinct.has(item.trade.id)) throw Error('ANALYTICS_HISTORY_SLOT_CONFLICT')
    slots.add(slot)
    const existing = distinct.get(item.trade.id)
    if (
      existing &&
      (existing.block !== item.block ||
        existing.transactionIndex !== item.transactionIndex ||
        existing.logIndex !== item.logIndex ||
        JSON.stringify(existing.trade) !== JSON.stringify(item.trade))
    )
      throw Error('ANALYTICS_HISTORY_DUPLICATE_CONFLICT')
    distinct.set(item.trade.id, item)
  }
  const ordered = [...distinct.values()]
    .filter((item) => !boundary || before([item.block, item.transactionIndex, item.logIndex], boundary))
    .sort((a, b) => {
      const left = [a.block, a.transactionIndex, a.logIndex] as const
      const right = [b.block, b.transactionIndex, b.logIndex] as const
      return before(left, right) ? 1 : before(right, left) ? -1 : 0
    })
  const page = ordered.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((item) => item.trade),
    nextCursor:
      ordered.length > limit && last
        ? Buffer.from(JSON.stringify([String(last.block), last.transactionIndex, last.logIndex])).toString('base64url')
        : null,
  }
}
