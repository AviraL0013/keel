import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  deriveEvent,
  notionalMicros,
  signedMoney,
  sumMicros,
  type MarketPrecision,
} from '../packages/analytics/src/aggregate.js'
import { decodeExchangeLog, type ChainLog } from '../packages/analytics/src/decoder.js'

const logs = (JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-logs.json', 'utf8')) as { logs: ChainLog[] })
  .logs
const context = (
  JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')) as {
    context: {
      markets: Array<{ id: number; perpetual_id: number; config: { price_decimals: number; size_decimals: number } }>
    }
  }
).context
const markets = new Map<number, MarketPrecision>(
  context.markets.map((market) => [
    market.perpetual_id,
    {
      marketId: market.id,
      priceDecimals: market.config.price_decimals,
      sizeDecimals: market.config.size_decimals,
    },
  ]),
)

describe('exact analytics aggregation', () => {
  it('derives fills and position changes from recorded mainnet logs', () => {
    const events = logs.map(decodeExchangeLog).filter((event) => event !== null)
    const derived = events.map((event) => deriveEvent(event, markets)).filter((event) => event !== null)
    expect(derived.some((event) => event.kind === 'fill')).toBe(true)
    expect(derived.some((event) => event.kind === 'position')).toBe(true)
    for (const event of derived)
      if (event.kind === 'fill') {
        expect(event.notionalMicros).toBeGreaterThan(0n)
        expect(event.feeMicros).toBeGreaterThanOrEqual(event.builderFeeMicros)
      }
  })

  it('rounds at most half a micro across varied integer scales', () => {
    let seed = 0x12345n
    for (let index = 0; index < 500; index++) {
      seed = (seed * 48271n) % 2147483647n
      const price = seed + 1n
      seed = (seed * 48271n) % 2147483647n
      const size = seed + 1n
      const priceDecimals = index % 9
      const sizeDecimals = (index * 3) % 9
      const divisor = 10n ** BigInt(priceDecimals + sizeDecimals)
      const exactNumerator = price * size * 1_000_000n
      const rounded = notionalMicros(price, size, priceDecimals, sizeDecimals)
      expect((rounded * divisor - exactNumerator) * 2n).toBeLessThanOrEqual(divisor)
      expect((exactNumerator - rounded * divisor) * 2n).toBeLessThanOrEqual(divisor)
    }
  })

  it('keeps large and signed micro amounts exact', () => {
    const values = [1n, 999999999999999999999n, -5n]
    expect(sumMicros(values)).toBe(999999999999999999995n)
    expect(signedMoney(-1000001n)).toBe('-1.000001')
    expect(signedMoney(0n)).toBe('0.000000')
  })
})
