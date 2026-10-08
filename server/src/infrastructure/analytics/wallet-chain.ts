import { createPublicClient, getAddress, http } from 'viem'
import { monad } from 'viem/chains'
import { formatMoney } from '../../../../packages/ausd/src/money.js'
import { notionalMicros, signedMoney } from '../../../../packages/analytics/src/aggregate.js'
import type { Envelope, Position, WalletProfile } from '../../../../packages/analytics/src/contract.js'
import { EXCHANGE } from '../../../../packages/analytics/src/decoder.js'
import { exchangeReads } from '../../../../packages/analytics/src/exchange-reads.js'
import { scaledText, type PublicContext, type PublicMarket } from './perpl-public.js'
import { historicalAccountOwner } from './owner-proof.js'

type AccountView = { accountId: bigint; balanceCNS: bigint; lockedBalanceCNS: bigint; accountAddr: string }
type PositionView = {
  accountId: bigint
  positionType: number
  depositCNS: bigint
  pricePNS: bigint
  lotLNS: bigint
  entryBlock: bigint
  pnlCNS: bigint
}
type PositionResult = readonly [PositionView, bigint, boolean]
interface Cached {
  expires: number
  value: Promise<Envelope<WalletProfile> | null>
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
  let totalPnl = 0n
  for (const { market, result, openedAt } of views) {
    const [position, markRaw, markValid] = result
    if (position.accountId !== account.accountId || position.lotLNS <= 0n) continue
    if (position.positionType !== 0 && position.positionType !== 1) throw new Error('POSITION_SIDE_UNKNOWN')
    const entryNotional = notionalMicros(
      position.pricePNS,
      position.lotLNS,
      market.config.price_decimals,
      market.config.size_decimals,
    )
    const leverageHundredths =
      position.depositCNS > 0n ? (entryNotional * 100n + position.depositCNS / 2n) / position.depositCNS : 0n
    const notional = markValid
      ? notionalMicros(markRaw, position.lotLNS, market.config.price_decimals, market.config.size_decimals)
      : null
    if (markValid) totalPnl += position.pnlCNS
    positions.push({
      id: `${market.id}:${account.accountId}`,
      marketId: market.id,
      symbol: market.symbol || market.name || String(market.id),
      side: position.positionType === 0 ? 'long' : 'short',
      size: scaledText(position.lotLNS, market.config.size_decimals),
      notional: notional === null ? null : formatMoney(notional),
      entryPrice: scaledText(position.pricePNS, market.config.price_decimals),
      markPrice: markValid ? scaledText(markRaw, market.config.price_decimals) : null,
      leverage: scaledText(leverageHundredths, 2),
      collateral: formatMoney(position.depositCNS),
      unrealizedPnl: markValid ? signedMoney(position.pnlCNS) : null,
      liquidationPrice: null,
      openedAt,
    })
  }
  positions.sort((a, b) => a.marketId - b.marketId)
  const equityKnown = views.every(({ result }) => result[0].lotLNS <= 0n || result[2])
  return {
    asOf,
    block,
    source: 'monad_exchange',
    stale: false,
    data: {
      address,
      accountIds: [account.accountId.toString()],
      margin: {
        balance: formatMoney(account.balanceCNS),
        locked: formatMoney(account.lockedBalanceCNS),
        free: signedMoney(account.balanceCNS - account.lockedBalanceCNS),
        equity: equityKnown ? signedMoney(account.balanceCNS + totalPnl) : null,
      },
      positions,
    },
  }
}

export class WalletChainAnalytics {
  private client
  private cache = new Map<string, Cached>()
  private blockTimes = new Map<string, string>()
  constructor(rpcUrl: string) {
    this.client = createPublicClient({ chain: monad, transport: http(rpcUrl, { timeout: 8000, retryCount: 0 }) })
  }
  ownerAt(accountId: bigint, blockNumber: bigint, expectedHash: string) {
    return historicalAccountOwner(this.client, accountId, blockNumber, expectedHash)
  }
  async profile(address: string, context: PublicContext): Promise<Envelope<WalletProfile> | null> {
    const normalized = getAddress(address)
    const cached = this.cache.get(normalized)
    if (cached && cached.expires > Date.now()) return cached.value
    const value = this.load(normalized, context)
    this.cache.set(normalized, { expires: Date.now() + 15_000, value })
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
    try {
      return await value
    } catch (error) {
      this.cache.delete(normalized)
      throw error
    }
  }
  private async load(address: `0x${string}`, context: PublicContext): Promise<Envelope<WalletProfile> | null> {
    const blockNumber = (await this.client.getBlockNumber()) - 12n
    const account = (await this.client.readContract({
      address: EXCHANGE,
      abi: exchangeReads,
      functionName: 'getAccountByAddr',
      args: [address],
      blockNumber,
    })) as AccountView
    if (!account.accountId) return null
    if (getAddress(account.accountAddr) !== address) throw new Error('ACCOUNT_ADDRESS_MISMATCH')
    const views = await Promise.all(
      context.markets.map(async (market) => {
        const result = (await this.client.readContract({
          address: EXCHANGE,
          abi: exchangeReads,
          functionName: 'getPositionV2',
          args: [BigInt(market.perpetual_id), account.accountId],
          blockNumber,
        })) as PositionResult
        if (result[0].lotLNS <= 0n) return null
        const entry = result[0].entryBlock
        let openedAt = this.blockTimes.get(entry.toString())
        if (!openedAt) {
          const block = await this.client.getBlock({ blockNumber: entry })
          openedAt = new Date(Number(block.timestamp) * 1000).toISOString()
          this.blockTimes.set(entry.toString(), openedAt)
          if (this.blockTimes.size > 1000) this.blockTimes.delete(this.blockTimes.keys().next().value!)
        }
        return { market, result, openedAt }
      }),
    )
    return profileFromViews(
      address,
      account,
      views.filter((view) => view !== null),
      Number(blockNumber),
      new Date().toISOString(),
    )
  }
}
