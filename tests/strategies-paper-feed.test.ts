import { expect, it, vi } from 'vitest'
import { PerplPaperFeed } from '../server/src/workers/strategy-worker.js'
import type { PerplAdapter, PerplContext } from '../packages/perpl/src/index.js'
import type { NormalizedTelemetry } from '../packages/domain/src/index.js'

const now = Date.parse('2026-10-08T09:00:00.000Z')
const setup = () => {
  const context: PerplContext = {
    chain: { chain_id: 143, gas: { h: 105, at: { b: 105, t: now } } },
    instances: [],
    tokens: [],
    markets: [
      {
        id: 1,
        symbol: 'BTC',
        funding_interval_sec: 600,
        funding_interval_blocks: 10,
        config: { price_decimals: 1, maker_fee: 1000 },
        state: {},
        funding: {},
      },
    ],
  }
  const adapter = {
    getProtocolContext: vi.fn(async () => context),
    getNormalizedMarket: vi.fn(
      async () =>
        ({
          timestamp: now,
          bid: 99,
          ask: 101,
          mark: 100,
          oracle: 100,
          volatility: 0.01,
          fundingRate: 0.000002,
          depthNotional: 10000,
        }) as NormalizedTelemetry,
    ),
    getFundingHistory: vi.fn(async () => ({
      m: 1,
      d: [{ at: { b: 100, t: now - 1000 }, feb: 100, rate: 2, idx: 1000, ppl: 17, sum: 117, div: 1 }],
    })),
    close: vi.fn(),
  } satisfies Pick<PerplAdapter, 'getProtocolContext' | 'getNormalizedMarket' | 'getFundingHistory' | 'close'>
  return { context, adapter, feed: new PerplPaperFeed('mainnet', adapter, () => now) }
}

it('paper feed requests a bounded unsigned history window and keeps raw interval identity', async () => {
  const { adapter, feed } = setup()
  const sample = await feed.sample(1)
  expect(adapter.getFundingHistory).toHaveBeenCalledExactlyOnceWith(1, now - 1_800_000, now)
  expect(sample.funding?.events[0]?.ppl).toBe(17)
  expect(sample.funding?.head).toEqual({ block: 105, at: now })
  expect(sample.funding?.marketId).toBe(1)
  feed.close()
  expect(adapter.close).toHaveBeenCalledTimes(1)
})

it('paper feed refuses a mixed chain before requesting funding', async () => {
  const { context, adapter, feed } = setup()
  context.chain = { chain_id: 10143, gas: { h: 105, at: { t: now } } }
  await expect(feed.sample(1)).rejects.toThrow('STRATEGY_MARKET_ENVIRONMENT_MISMATCH')
  expect(adapter.getFundingHistory).not.toHaveBeenCalled()
})

it('paper feed refuses a foreign series and stops on a 401/403 without another source', async () => {
  const wrong = setup()
  wrong.adapter.getFundingHistory.mockResolvedValue({ m: 2, d: [] })
  await expect(wrong.feed.sample(1)).rejects.toThrow('STRATEGY_PAPER_FUNDING_UNAVAILABLE')
  for (const code of [401, 403]) {
    const { adapter, feed } = setup()
    adapter.getFundingHistory.mockRejectedValue(Error(`VENUE_HTTP_${code}`))
    await expect(feed.sample(1)).rejects.toThrow(`VENUE_HTTP_${code}`)
    expect(adapter.getFundingHistory).toHaveBeenCalledTimes(1)
  }
})
