import { createPublicClient, getAddress, http } from 'viem'
import { monad } from 'viem/chains'
import { formatMoney } from '../../../../packages/ausd/src/money.js'
import { notionalMicros, signedMoney } from '../../../../packages/analytics/src/aggregate.js'
import type { Envelope, Position, WalletProfile } from '../../../../packages/analytics/src/contract.js'
import { EXCHANGE } from '../../../../packages/analytics/src/decoder.js'
import { exchangeReads } from '../../../../packages/analytics/src/exchange-reads.js'
import { scaledText, type PublicContext, type PublicMarket } from './perpl-public.js'
import { historicalAccountOwner } from './owner-proof.js'
import {
  effectivePositionEntry,
  positionEntryQ16,
  POSITION_Q16,
} from '../../../../packages/perpl/src/position-value.js'

type AccountView = {
  accountId: bigint
  balanceCNS: bigint
  lockedBalanceCNS: bigint
  accountAddr: string
  positions?: { bank1: bigint; bank2: bigint; bank3: bigint; bank4: bigint }
}
type PositionView = {
  accountId: bigint
  positionType: number
  depositCNS: bigint
  pricePNS: bigint
  lotLNS: bigint
  entryBlock: bigint
  pnlCNS: bigint
  priceResiduePNSQ16: bigint
}
type PositionResult = readonly [PositionView, bigint, boolean]
interface Cached {
  expires: number
  value: Promise<Envelope<WalletProfile> | null>
}

const rpcClient = (rpcUrl: string) =>
  createPublicClient({ chain: monad, transport: http(rpcUrl, { timeout: 8000, retryCount: 0 }) })
type WalletClient = Pick<ReturnType<typeof rpcClient>, 'getChainId' | 'getBlock' | 'readContract'>
function positionIds(account: AccountView): Set<number> | undefined {
  if (!account.positions) return undefined
  const ids = new Set<number>()
  // Pinned SDK account.rs perpetuals_with_position: bank1's upper three bits are not positions.
  const banks = [
    ['bank1', 0, 253],
    ['bank2', 253, 256],
    ['bank3', 509, 256],
    ['bank4', 765, 256],
  ] as const
  for (const [key, offset, width] of banks) {
    const value = account.positions[key]
    if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n)
      throw Error('ANALYTICS_POSITION_BITMAP_UNVERIFIED')
    for (let bit = 0; bit < width; bit++) if (value & (1n << BigInt(bit))) ids.add(offset + bit)
  }
  return ids
}

export function profileFromViews(
  address: string,
  account: AccountView,
  views: Array<{
    market: PublicMarket
    result: PositionResult
    openedAt: string
  }>,
  block: number,
  asOf: string,
): Envelope<WalletProfile> {
  const positions: Position[] = []
  if (
    account.accountId <= 0n ||
    account.balanceCNS < 0n ||
    account.lockedBalanceCNS < 0n ||
    getAddress(account.accountAddr) !== getAddress(address)
  )
    throw Error('ANALYTICS_ACCOUNT_UNVERIFIED')
  const expectedIds = positionIds(account)
  const observedIds = new Set<number>()
  let totalPnl = 0n,
    totalCollateral = 0n
  for (const { market, result, openedAt } of views) {
    const [position, markRaw, markValid] = result
    if (position.lotLNS === 0n) continue
    if (position.accountId !== account.accountId) throw Error('ANALYTICS_POSITION_ACCOUNT_MISMATCH')
    if (observedIds.has(market.perpetual_id) || (expectedIds && !expectedIds.has(market.perpetual_id)))
      throw Error('ANALYTICS_POSITION_BITMAP_MISMATCH')
    observedIds.add(market.perpetual_id)
    if (
      position.lotLNS < 0n ||
      position.depositCNS < 0n ||
      position.entryBlock < 0n ||
      position.entryBlock > BigInt(block) ||
      typeof position.pnlCNS !== 'bigint' ||
      typeof markValid !== 'boolean' ||
      (markValid && markRaw <= 0n)
    )
      throw Error('ANALYTICS_POSITION_UNVERIFIED')
    if (position.positionType !== 0 && position.positionType !== 1) throw new Error('POSITION_SIDE_UNKNOWN')
    const entryQ16 = positionEntryQ16(position.positionType, position.pricePNS, position.priceResiduePNSQ16)
    const entryPrice = effectivePositionEntry(
      position.positionType,
      position.pricePNS,
      position.priceResiduePNSQ16,
      market.config.price_decimals,
    )
    if (
      !Number.isSafeInteger(market.config.size_decimals) ||
      market.config.size_decimals < 0 ||
      market.config.size_decimals > 18
    )
      throw Error('ANALYTICS_POSITION_PRECISION_INVALID')
    const entryNumerator = entryQ16 * position.lotLNS * 1_000_000n * 100n
    const entryDenominator =
      POSITION_Q16 * 10n ** BigInt(market.config.price_decimals + market.config.size_decimals) * position.depositCNS
    const leverageHundredths =
      position.depositCNS > 0n ? (entryNumerator + entryDenominator / 2n) / entryDenominator : 0n
    const notional = markValid
      ? notionalMicros(markRaw, position.lotLNS, market.config.price_decimals, market.config.size_decimals)
      : null
    if (markValid) totalPnl += position.pnlCNS
    totalCollateral += position.depositCNS
    positions.push({
      id: `${market.id}:${account.accountId}`,
      marketId: market.id,
      symbol: market.symbol || market.name || String(market.id),
      side: position.positionType === 0 ? 'long' : 'short',
      size: scaledText(position.lotLNS, market.config.size_decimals),
      notional: notional === null ? null : formatMoney(notional),
      entryPrice,
      markPrice: markValid ? scaledText(markRaw, market.config.price_decimals) : null,
      leverage: scaledText(leverageHundredths, 2),
      collateral: formatMoney(position.depositCNS),
      unrealizedPnl: markValid ? signedMoney(position.pnlCNS) : null,
      liquidationPrice: null,
      openedAt,
    })
  }
  positions.sort((a, b) => a.marketId - b.marketId)
  const expectedPositions = expectedIds?.size
  const complete = expectedPositions !== undefined && expectedPositions === positions.length
  const equityKnown = complete && views.every(({ result }) => result[0].lotLNS === 0n || result[2])
  return {
    asOf,
    block,
    source: 'monad_exchange',
    stale: !equityKnown,
    ...(!complete
      ? {
          coverage: {
            from: null,
            through: asOf,
            completeHistory: false,
            label:
              expectedPositions === undefined
                ? 'Wallet coverage unavailable'
                : `Wallet positions ${positions.length}/${expectedPositions}`,
          },
        }
      : {}),
    data: {
      address,
      accountIds: [account.accountId.toString()],
      margin: {
        balance: formatMoney(account.balanceCNS),
        locked: formatMoney(account.lockedBalanceCNS),
        free: formatMoney(
          account.balanceCNS > account.lockedBalanceCNS ? account.balanceCNS - account.lockedBalanceCNS : 0n,
        ),
        equity: equityKnown ? signedMoney(account.balanceCNS + totalCollateral + totalPnl) : null,
      },
      positions,
    },
  }
}

export class WalletChainAnalytics {
  private client: WalletClient
  private cache = new Map<string, Cached>()
  constructor(rpcUrl: string, client?: WalletClient) {
    this.client = client ?? rpcClient(rpcUrl)
  }
  ownerAt(accountId: bigint, blockNumber: bigint, expectedHash: string) {
    return historicalAccountOwner(this.client, accountId, blockNumber, expectedHash)
  }
  async profile(address: string, context: PublicContext): Promise<Envelope<WalletProfile> | null> {
    const normalized = getAddress(address)
    const identity = this.contextIdentity(context)
    const key = `${normalized}:${identity}`
    const stamped = async (value: Promise<Envelope<WalletProfile> | null>) => {
      const result = await value
      if (!result) return null
      const age = Date.now() - Date.parse(result.asOf)
      return { ...result, stale: result.stale || age > 30_000 || age < -30_000 }
    }
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return stamped(cached.value)
    const value = this.load(normalized, context)
    this.cache.set(key, { expires: Date.now() + 15_000, value })
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
    try {
      return await stamped(value)
    } catch (error) {
      this.cache.delete(key)
      throw error
    }
  }
  private contextIdentity(context: PublicContext): string {
    if (
      context.chain?.chain_id !== 143 ||
      !context.instances?.some((item) => item.address.toLowerCase() === EXCHANGE.toLowerCase()) ||
      !Array.isArray(context.markets) ||
      new Set(context.markets.map((item) => item.id)).size !== context.markets.length ||
      new Set(context.markets.map((item) => item.perpetual_id)).size !== context.markets.length ||
      context.markets.some(
        (item) =>
          !Number.isSafeInteger(item.id) ||
          item.id <= 0 ||
          !Number.isSafeInteger(item.perpetual_id) ||
          item.perpetual_id <= 0 ||
          ![item.config.price_decimals, item.config.size_decimals].every(
            (precision) => Number.isSafeInteger(precision) && precision >= 0 && precision <= 18,
          ),
      )
    )
      throw Error('ANALYTICS_RPC_CONTEXT_MISMATCH')
    return JSON.stringify(
      context.markets.map((market) => [
        market.id,
        market.perpetual_id,
        market.symbol,
        market.name,
        market.config.price_decimals,
        market.config.size_decimals,
      ]),
    )
  }
  private async load(address: `0x${string}`, context: PublicContext): Promise<Envelope<WalletProfile> | null> {
    if ((await this.client.getChainId()) !== 143) throw Error('ANALYTICS_RPC_CHAIN_MISMATCH')
    const finalized = await this.client.getBlock({ blockTag: 'finalized' })
    const blockNumber = finalized.number,
      hash = finalized.hash
    const timestamp = Number(finalized.timestamp) * 1000
    if (
      blockNumber === null ||
      blockNumber <= 0n ||
      !Number.isSafeInteger(Number(blockNumber)) ||
      !hash ||
      !/^0x[0-9a-f]{64}$/i.test(hash) ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      timestamp > Date.now() + 30_000
    )
      throw Error('ANALYTICS_RPC_FINALITY_UNAVAILABLE')
    const finish = async () => {
      const after = await this.client.getBlock({ blockNumber })
      if (
        after.number !== blockNumber ||
        after.hash?.toLowerCase() !== hash.toLowerCase() ||
        after.timestamp !== finalized.timestamp
      )
        throw Error('ANALYTICS_RPC_BLOCK_CHANGED')
    }
    const account = (await this.client.readContract({
      address: EXCHANGE,
      abi: exchangeReads,
      functionName: 'getAccountByAddr',
      args: [address],
      blockNumber,
    })) as AccountView
    if (account.accountId === 0n) {
      await finish()
      return null
    }
    if (getAddress(account.accountAddr) !== address) throw new Error('ACCOUNT_ADDRESS_MISMATCH')
    const byId = (await this.client.readContract({
      address: EXCHANGE,
      abi: exchangeReads,
      functionName: 'getAccountById',
      args: [account.accountId],
      blockNumber,
    })) as AccountView
    if (
      byId.accountId !== account.accountId ||
      getAddress(byId.accountAddr) !== address ||
      byId.balanceCNS !== account.balanceCNS ||
      byId.lockedBalanceCNS !== account.lockedBalanceCNS ||
      positionIds(byId)?.size !== positionIds(account)?.size ||
      (['bank1', 'bank2', 'bank3', 'bank4'] as const).some(
        (bank) => byId.positions?.[bank] !== account.positions?.[bank],
      )
    )
      throw Error('ANALYTICS_ACCOUNT_ROUNDTRIP_MISMATCH')
    const views = await Promise.all(
      context.markets.map(async (market) => {
        const result = (await this.client.readContract({
          address: EXCHANGE,
          abi: exchangeReads,
          functionName: 'getPositionV2',
          args: [BigInt(market.perpetual_id), account.accountId],
          blockNumber,
        })) as PositionResult
        if (result[0].lotLNS === 0n) return null
        if (result[0].accountId !== account.accountId) throw Error('ANALYTICS_POSITION_ACCOUNT_MISMATCH')
        const entry = result[0].entryBlock
        if (entry < 0n || entry > blockNumber) throw Error('ANALYTICS_POSITION_ENTRY_UNVERIFIED')
        const block = await this.client.getBlock({ blockNumber: entry })
        const entryTime = Number(block.timestamp) * 1000
        if (
          block.number !== entry ||
          !block.hash ||
          !/^0x[0-9a-f]{64}$/i.test(block.hash) ||
          !Number.isSafeInteger(entryTime) ||
          entryTime < 0 ||
          entryTime > timestamp
        )
          throw Error('ANALYTICS_POSITION_ENTRY_UNVERIFIED')
        const openedAt = new Date(entryTime).toISOString()
        return { market, result, openedAt }
      }),
    )
    await finish()
    const result = profileFromViews(
      address,
      account,
      views.filter((view) => view !== null),
      Number(blockNumber),
      new Date(timestamp).toISOString(),
    )
    result.stale ||= Date.now() - timestamp > 30_000
    return result
  }
}
