import { formatMoney } from '../../../../packages/ausd/src/money.js'
import { notionalMicros, type MarketPrecision } from '../../../../packages/analytics/src/aggregate.js'
import type {
  Envelope,
  MarketDetail,
  MarketFunding,
  MarketPrices,
  MarketSummary,
} from '../../../../packages/analytics/src/contract.js'

export interface PublicMarket {
  id: number
  perpetual_id: number
  symbol: string
  name: string
  funding_interval_sec: number
  config: { price_decimals: number; size_decimals: number }
  state: { at: { b?: number; t?: number }; mrk: number; oi: number; tvl: string; dva: string }
  funding: { rate: number; at: { b?: number; t?: number } }
}
export interface PublicContext {
  chain: { chain_id: number }
  instances: Array<{ address: string }>
  markets: PublicMarket[]
}
interface CacheEntry<T> {
  value: T
  at: number
}

function integer(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('PERPL_SCALED_VALUE_INVALID')
  return BigInt(value)
}
export function scaledText(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('PERPL_PRECISION_INVALID')
  const sign = raw < 0n ? '-' : ''
  const absolute = raw < 0n ? -raw : raw
  const scale = 10n ** BigInt(decimals)
  return `${sign}${absolute / scale}.${(absolute % scale).toString().padStart(decimals, '0')}`.replace(/\.$/, '')
}
export function marketSummary(market: PublicMarket): MarketSummary {
  const price = integer(market.state.mrk)
  const size = integer(market.state.oi)
  return {
    id: market.id,
    symbol: market.symbol || market.name || String(market.id),
    volume24h: formatMoney(BigInt(market.state.dva)),
    openInterest: formatMoney(notionalMicros(price, size, market.config.price_decimals, market.config.size_decimals)),
    longOpenInterest: null,
    shortOpenInterest: null,
    longSharePct: null,
    fundingRate: scaledText(BigInt(market.funding.rate), 6),
    markPrice: scaledText(price, market.config.price_decimals),
  }
}
export function marketDetail(market: PublicMarket): MarketDetail {
  return {
    ...marketSummary(market),
    tvl: formatMoney(BigInt(market.state.tvl)),
    priceDecimals: market.config.price_decimals,
    sizeDecimals: market.config.size_decimals,
    fundingIntervalSeconds: market.funding_interval_sec,
  }
}
export class PerplPublicAnalytics {
  private contextCache?: CacheEntry<PublicContext>
  private inflight?: Promise<PublicContext>
  constructor(
    readonly baseUrl = 'https://app.perpl.xyz/api',
    readonly fetcher: typeof fetch = fetch,
  ) {}
  private async read<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(`PERPL_PUBLIC_HTTP_${response.status}`)
    return response.json() as Promise<T>
  }
  async context(): Promise<{ value: PublicContext; asOf: string; block: number | null; stale: boolean }> {
    const now = Date.now()
    if (this.contextCache && now - this.contextCache.at < 15_000) return this.describe(this.contextCache)
    if (!this.inflight)
      this.inflight = this.read<PublicContext>('/v1/pub/context').finally(() => {
        this.inflight = undefined
      })
    try {
      const value = await this.inflight
      if (
        value.chain?.chain_id !== 143 ||
        !value.instances?.some(
          (instance) => instance.address.toLowerCase() === '0x34b6552d57a35a1d042ccae1951bd1c370112a6f',
        )
      )
        throw new Error('PERPL_CONTEXT_MISMATCH')
      this.contextCache = { value, at: Date.now() }
    } catch (error) {
      if (!this.contextCache) throw error
    }
    return this.describe(this.contextCache!)
  }
  private describe(entry: CacheEntry<PublicContext>) {
    const blocks = entry.value.markets
      .map((market) => market.state.at.b)
      .filter((block): block is number => block !== undefined)
    const times = entry.value.markets
      .map((market) => market.state.at.t)
      .filter((time): time is number => time !== undefined)
    const sourceTime = times.length ? Math.min(...times) : entry.at
    return {
      value: entry.value,
      asOf: new Date(entry.at).toISOString(),
      block: blocks.length ? Math.min(...blocks) : null,
      stale: Date.now() - sourceTime > 30_000 || Date.now() - entry.at > 30_000,
    }
  }
  precision(context: PublicContext): Map<number, MarketPrecision> {
    return new Map(
      context.markets.map((market) => [
        market.perpetual_id,
        {
          marketId: market.id,
          priceDecimals: market.config.price_decimals,
          sizeDecimals: market.config.size_decimals,
        },
      ]),
    )
  }
  async funding(market: PublicMarket, from: number, to: number): Promise<MarketFunding> {
    const response = await this.read<{ d: Array<{ at: { b?: number; t?: number }; rate: number }> }>(
      `/v1/market-data/${market.id}/funding/${from}-${to}`,
    )
    return {
      marketId: market.id,
      points: response.d
        .filter((item) => item.at.t !== undefined && item.at.t! >= from && item.at.t! < to)
        .map((item) => ({
          time: new Date(item.at.t!).toISOString(),
          block: item.at.b ?? null,
          rate: scaledText(BigInt(item.rate), 6),
        })),
    }
  }
  async volumeCandles(market: PublicMarket, interval: '1h' | '1d', from: number, to: number) {
    const seconds = interval === '1h' ? 3600 : 86400
    const maxSpan = seconds * 1000 * 1000 // Perpl caps each response at 1,024 candles.
    const values = new Map<number, bigint>()
    for (let start = from; start < to; start += maxSpan) {
      const end = Math.min(to, start + maxSpan)
      const response = await this.read<{ d: Array<{ t: number; v: string }> }>(
        `/v1/market-data/${market.id}/candles/${seconds}/${start}-${end}`,
      )
      for (const item of response.d) if (item.t >= from && item.t < to) values.set(item.t, BigInt(item.v))
    }
    return [...values].map(([time, micros]) => ({ time, micros }))
  }

  async prices(market: PublicMarket, interval: '1h' | '1d', from: number, to: number): Promise<Envelope<MarketPrices>> {
    const step = interval === '1h' ? 3_600_000 : 86_400_000
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to || to - from > step * 2160)
      throw Error('PERPL_CANDLES_RANGE_INVALID')
    const values = new Map<number, string>()
    let observedAt = Infinity,
      block: number | null = null
    for (let start = from; start < to; start += step * 1000) {
      const end = Math.min(to, start + step * 1000)
      const raw = await this.read<{ r: number; at: { b?: number; t: number }; d: Array<{ t: number; c: number }> }>(
        `/v1/market-data/${market.id}/candles/${step / 1000}/${start}-${end}`,
      )
      if (
        raw?.r !== step / 1000 ||
        !Number.isSafeInteger(raw.at?.t) ||
        raw.at.t < 0 ||
        raw.at.t > Date.now() + 30_000 ||
        !Array.isArray(raw.d) ||
        raw.d.length > 1024 ||
        (raw.at.b !== undefined && (!Number.isSafeInteger(raw.at.b) || raw.at.b <= 0))
      )
        throw Error('PERPL_CANDLES_INVALID')
      if (raw.at.t < observedAt) {
        observedAt = raw.at.t
        block = raw.at.b ?? null
      }
      for (const item of raw.d) {
        if (
          !Number.isSafeInteger(item?.t) ||
          item.t < 0 ||
          item.t % step !== 0 ||
          !Number.isSafeInteger(item.c) ||
          item.c <= 0
        )
          throw Error('PERPL_CANDLES_INVALID')
        if (item.t < from || item.t >= to) continue
        const value = scaledText(BigInt(item.c), market.config.price_decimals)
        if (values.has(item.t) && values.get(item.t) !== value) throw Error('PERPL_CANDLES_INVALID')
        values.set(item.t, value)
      }
    }
    const completedThrough = Math.min(to, observedAt, Date.now())
    const points = []
    for (let time = Math.ceil(from / step) * step; time < to; time += step)
      points.push({
        time: new Date(time).toISOString(),
        value: time + step <= completedThrough ? (values.get(time) ?? null) : null,
      })
    return {
      source: 'perpl_api',
      asOf: new Date(observedAt).toISOString(),
      block,
      stale: Date.now() - observedAt > step + 30_000 || points.some((p) => p.value === null),
      data: {
        marketId: market.id,
        interval,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        points,
      },
    }
  }
}
