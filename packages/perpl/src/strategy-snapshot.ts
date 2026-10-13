import Decimal from 'decimal.js'
import type { LiveStrategySnapshot } from '../../strategies/src/live.js'
import type { WireAccount, WireOrder, WirePosition } from './decoder.js'
import type { OpeningMarketDetail } from './opening-market.js'

const Exact = Decimal.clone({ precision: 160 })
export type StrategyChainAccount = {
  accountId: bigint
  balanceCNS: bigint
  lockedBalanceCNS: bigint
  frozen: number
  accountAddr: string
  positions: { bank1: bigint; bank2: bigint; bank3: bigint; bank4: bigint }
}
export type StrategyChainPosition = {
  accountId: bigint
  positionType: number
  depositCNS: bigint
  lotLNS: bigint
  pnlCNS: bigint
}
export function strategySnapshotFromViews(input: {
  market: OpeningMarketDetail
  contractMarketId: number
  account: WireAccount
  chainAccount: StrategyChainAccount
  chainPosition: StrategyChainPosition
  markValid: boolean
  orders: WireOrder[]
  positions: WirePosition[]
  chainBlock: number
  chainHash: string
  chainFinalized: boolean
  headBlock: number
  epoch: string
  sequence: number
  observedAt: number
  oracleRaw: number
  volatility: string
  fundingRate: string
  makerFeeMicros: number
  funding: { sumRaw: string; divisor: string }
  depositRaw: string
  withdrawalRaw: string
}): LiveStrategySnapshot {
  const { market, account, chainAccount: chain, chainPosition: position } = input
  const fail = () => {
    throw Error('STRATEGY_ACCOUNT_SNAPSHOT_UNVERIFIED')
  }
  if (
    !Number.isSafeInteger(input.contractMarketId) ||
    input.contractMarketId <= 0 ||
    chain.accountId !== BigInt(market.accountId) ||
    account.id !== market.accountId ||
    chain.frozen !== 0 ||
    !account.fw ||
    account.fr ||
    chain.balanceCNS < 0n ||
    chain.lockedBalanceCNS < 0n ||
    chain.lockedBalanceCNS > chain.balanceCNS ||
    !/^\d+$/.test(account.b) ||
    !/^\d+$/.test(account.lb) ||
    BigInt(account.b) !== chain.balanceCNS ||
    BigInt(account.lb) !== chain.lockedBalanceCNS ||
    !/^\d+$/.test(String(account.lfr)) ||
    market.collateralDecimals !== 6
  )
    fail()
  const ids = new Set<number>()
  for (const [key, offset, width] of [
    ['bank1', 0, 253],
    ['bank2', 253, 256],
    ['bank3', 509, 256],
    ['bank4', 765, 256],
  ] as const) {
    const bank = chain.positions[key]
    if (typeof bank !== 'bigint' || bank < 0n || bank >= 1n << 256n) fail()
    for (let bit = 0; bit < width; bit++) if (bank & (1n << BigInt(bit))) ids.add(offset + bit)
  }
  if (
    [...ids].some((id) => id !== input.contractMarketId) ||
    position.lotLNS < 0n ||
    position.depositCNS < 0n ||
    (position.lotLNS === 0n && (position.depositCNS !== 0n || position.pnlCNS !== 0n)) ||
    (position.lotLNS > 0n &&
      (position.accountId !== chain.accountId || ![0, 1].includes(position.positionType) || !input.markValid)) ||
    ids.has(input.contractMarketId) !== position.lotLNS > 0n
  )
    fail()
  const openPositions = input.positions.filter((row) => row.acc === market.accountId && row.st === 1)
  if (
    openPositions.length !== (position.lotLNS > 0n ? 1 : 0) ||
    openPositions.some(
      (row) =>
        row.mkt !== market.marketId ||
        !Number.isSafeInteger(row.s) ||
        BigInt(row.s) !== position.lotLNS ||
        row.sd !== position.positionType + 1 ||
        !/^\d+$/.test(row.c) ||
        BigInt(row.c) !== position.depositCNS ||
        row.rq === undefined ||
        !/^\d+$/.test(String(row.rq)) ||
        (typeof row.rq === 'number' && !Number.isSafeInteger(row.rq)),
    )
  )
    fail()
  if (
    !Number.isSafeInteger(input.chainBlock) ||
    input.chainBlock <= 0 ||
    input.chainBlock > input.headBlock ||
    input.headBlock - input.chainBlock > 3 ||
    !/^0x[0-9a-f]{64}$/i.test(input.chainHash) ||
    !Number.isSafeInteger(input.oracleRaw) ||
    input.oracleRaw <= 0 ||
    !Number.isSafeInteger(input.makerFeeMicros) ||
    input.makerFeeMicros < 0 ||
    !/^\d+$/.test(input.depositRaw) ||
    !/^\d+$/.test(input.withdrawalRaw)
  )
    fail()
  const scaled = (raw: bigint | string, decimals = 6) =>
    new Exact(String(raw)).div(new Exact(10).pow(decimals)).toFixed(decimals)
  const balance = scaled(chain.balanceCNS),
    locked = scaled(chain.lockedBalanceCNS)
  if (!new Exact(balance).minus(locked).eq(market.freeBalance)) fail()
  const orders = input.orders.filter(
    (row) => row.acc === market.accountId && !row.r && [1, 2, 3, 8, 9].includes(row.st),
  )
  if (
    input.orders.some(
      (row) => row.acc === market.accountId && !row.r && (!Number.isSafeInteger(row.st) || row.st < 1 || row.st > 10),
    )
  )
    fail()
  if (
    orders.some(
      (row) =>
        ![row.oid, row.mkt, row.os, row.fs].every(Number.isSafeInteger) ||
        row.oid <= 0 ||
        row.mkt <= 0 ||
        row.os <= 0 ||
        row.fs < 0 ||
        row.fs > row.os ||
        !/^\d+$/.test(String(row.rq)) ||
        (typeof row.rq === 'number' && !Number.isSafeInteger(row.rq)),
    )
  )
    fail()
  return {
    environment: market.environment,
    accountId: market.accountId,
    marketId: market.marketId,
    account: { balance, locked, lastRequestId: String(account.lfr) },
    market,
    contractMarketId: input.contractMarketId,
    oracleRaw: input.oracleRaw,
    volatility: input.volatility,
    fundingRate: input.fundingRate,
    makerFeeMicros: input.makerFeeMicros,
    funding: input.funding,
    orders,
    positions: openPositions,
    observedAt: input.observedAt,
    headBlock: input.headBlock,
    epoch: input.epoch,
    sequence: input.sequence,
    equity: scaled(chain.balanceCNS + position.depositCNS + position.pnlCNS),
    inventory: scaled(position.lotLNS * (position.positionType === 1 ? -1n : 1n), market.sizeDecimals),
    positionCollateral: scaled(position.depositCNS),
    depositTotal: scaled(input.depositRaw),
    withdrawalTotal: scaled(input.withdrawalRaw),
    chainBlock: input.chainBlock,
    chainHash: input.chainHash,
    chainFinalized: input.chainFinalized,
  }
}
