import type { PerplBacktestFixture } from './backtest.js'

const origin = 'https://app.perpl.xyz/api'
const exchange = '0x34b6552d57a35a1d042ccae1951bd1c370112a6f'
const hour = 3_600_000
type Context = {
  chain?: { chain_id?: number }
  instances?: Array<{ address?: string }>
  markets?: Array<{
    id: number
    funding_interval_sec: number
    config: {
      price_decimals: number
      size_decimals: number
      maker_fee: number
      taker_fee: number
    }
  }>
}

/** Unsigned public capture only. No configurable host, authentication or trading method. */
export async function captureStrategyWindow(
  from: number,
  to: number,
  read: typeof fetch = fetch,
): Promise<PerplBacktestFixture> {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    from % hour ||
    to % hour ||
    to <= from ||
    to > Math.floor(Date.now() / hour) * hour ||
    to - from > 30 * 86_400_000
  )
    throw Error('PERPL_RECORDING_RANGE_INVALID')
  async function json<T>(path: string): Promise<T> {
    const response = await read(`${origin}${path}`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw Error(`PERPL_RECORDING_HTTP_${response.status}`)
    return response.json() as Promise<T>
  }
  const context = await json<Context>('/v1/pub/context')
  const market = context.markets?.find((item) => item.id === 1)
  if (
    context.chain?.chain_id !== 143 ||
    !context.instances?.some((item) => item.address?.toLowerCase() === exchange) ||
    !market ||
    ![
      market.config?.price_decimals,
      market.config?.size_decimals,
      market.config?.maker_fee,
      market.config?.taker_fee,
      market.funding_interval_sec,
    ].every(Number.isSafeInteger) ||
    market.config.price_decimals < 0 ||
    market.config.price_decimals > 12 ||
    market.config.size_decimals < 0 ||
    market.config.size_decimals > 12 ||
    Math.abs(market.config.maker_fee) > 1_000_000 ||
    Math.abs(market.config.taker_fee) > 1_000_000 ||
    market.funding_interval_sec <= 0
  )
    throw Error('PERPL_RECORDING_CONTEXT_MISMATCH')
  const candlePath = `/v1/market-data/1/candles/3600/${from}-${to - 1}`
  const raw = await json<{ r: number; d: PerplBacktestFixture['candles'] }>(candlePath)
  if (raw?.r !== 3600 || !Array.isArray(raw.d)) throw Error('PERPL_RECORDING_CANDLES_INVALID')
  const candles = raw.d.filter((item) => item.t >= from && item.t < to).sort((a, b) => a.t - b.t)
  if (candles.length !== (to - from) / hour || candles.some((item, index) => item.t !== from + index * hour))
    throw Error('PERPL_RECORDING_CANDLES_INCOMPLETE')
  const fundingRows: PerplBacktestFixture['funding'] = []
  const fundingUrls: string[] = []
  const fundingSpan = market.funding_interval_sec * 1000 * 500
  for (let start = from; start < to; start += fundingSpan) {
    const end = Math.min(to, start + fundingSpan)
    const path = `/v1/market-data/1/funding/${start}-${end - 1}`
    const funding = await json<{ m: number; d: PerplBacktestFixture['funding'] }>(path)
    if (funding?.m !== 1 || !Array.isArray(funding.d) || funding.d.length > 501)
      throw Error('PERPL_RECORDING_FUNDING_INVALID')
    fundingUrls.push(`${origin}${path}`)
    // A short range may return the rate that predates it; that is not another payment.
    fundingRows.push(...funding.d.filter((item) => item.at.t >= start && item.at.t < end))
  }
  return {
    source: 'Perpl mainnet public API; current base fee schedule, not historical tier proof',
    retrievedAt: new Date().toISOString(),
    candleUrl: `${origin}${candlePath}`,
    fundingUrl: fundingUrls[0]!,
    fundingUrls,
    marketId: 1,
    priceDecimals: market.config.price_decimals,
    sizeDecimals: market.config.size_decimals,
    baseMakerFeeMicros: market.config.maker_fee,
    baseTakerFeeMicros: market.config.taker_fee,
    candles,
    funding: fundingRows,
  }
}
