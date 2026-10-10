import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PerplAdapter } from '../packages/perpl/src/index.js'
import { PerplMarketStream } from '../packages/perpl/src/marketStream.js'
import { PerplTradingClient } from '../packages/perpl/src/trading.js'
import { createPerplRuntime } from '../server/src/infrastructure/perpl/runtime.js'
import type { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'

const protocol = (block: number) => ({
  chain: {},
  instances: [{ id: 1, collateral_token_id: 1 }],
  tokens: [{ id: 1, symbol: 'AUSD', decimals: 6 }],
  markets: [
    {
      id: 1,
      symbol: 'BTC',
      instance_id: 1,
      order_ttl_blocks: 20,
      config: {
        is_open: true,
        price_decimals: 1,
        size_decimals: 5,
        initial_margin: 1500,
        taker_fees: [345, 300],
        min_settle_amount: '0',
        min_posting_amount: '0',
        recycle_fee: '0',
      },
      state: { at: { b: block }, bid: 829922, ask: 829923, mrk: 830019 },
      funding: {},
    },
  ],
})

let head: number, marketBlock: number, account: { id: number; fw: boolean; fr: boolean; ft: number }
let venue: ReturnType<typeof createPerplRuntime>

beforeEach(() => {
  head = 100
  marketBlock = 100
  account = { id: 5448, fw: true, fr: false, ft: 0 }
  vi.spyOn(PerplTradingClient.prototype, 'isReady').mockReturnValue(true)
  vi.spyOn(PerplTradingClient.prototype, 'heartbeat').mockImplementation(() => ({
    head,
    sequence: head,
    epoch: 'same-stream',
  }))
  vi.spyOn(PerplTradingClient.prototype, 'heartbeatObservedAt').mockImplementation(() => Date.now())
  vi.spyOn(PerplTradingClient.prototype, 'stateSnapshot').mockImplementation(() => ({ accounts: [account] }) as never)
  vi.spyOn(PerplMarketStream.prototype, 'ensure').mockResolvedValue()
  vi.spyOn(PerplMarketStream.prototype, 'snapshot').mockImplementation(async () => ({
    market: protocol(marketBlock).markets[0].state,
    fundingRate: 0,
    candleCloses: [],
  }))
  vi.spyOn(PerplAdapter.prototype, 'getProtocolContext').mockImplementation(async () => protocol(marketBlock))
  vi.spyOn(PerplAdapter.prototype, 'getBalance').mockImplementation(async () => ({
    available: '10.000000',
    locked: '0.000000',
    decimals: 6,
    updatedAt: Date.now(),
    observedBlock: head,
  }))
  venue = createPerplRuntime({ pool: {} } as PostgresStore, {
    EYELER_ENV: 'mainnet',
    PERPL_API_KEY: 'fixture-only',
    PERPL_API_KEY_SECRET: '11'.repeat(32),
    PERPL_ACCOUNT_ID: '5448',
  })
})

afterEach(async () => {
  await venue?.close()
  vi.restoreAllMocks()
})

it('reads the current heartbeat after asynchronous market and wallet reads', async () => {
  vi.mocked(PerplAdapter.prototype.getProtocolContext).mockImplementation(async () => {
    head = marketBlock = 102
    return protocol(102)
  })
  await expect(venue!.openingMarketSnapshot!(1)).resolves.toMatchObject({
    headBlock: 102,
    marketBlock: 102,
    accountId: 5448,
  })
})

it('uses fresh streamed wire prices when public context is behind the head', async () => {
  head = marketBlock = 110
  vi.mocked(PerplAdapter.prototype.getProtocolContext).mockResolvedValue(protocol(100))
  await expect(venue!.openingMarketSnapshot!(1)).resolves.toMatchObject({
    headBlock: 110,
    marketBlock: 110,
    bidRaw: 829922,
    askRaw: 829923,
    priceDecimals: 1,
  })
})

it('briefly waits for a real heartbeat to catch up to REST and stream blocks', async () => {
  marketBlock = 101
  setTimeout(() => {
    head = 101
  }, 25)
  await expect(venue!.openingMarketSnapshot!(1)).resolves.toMatchObject({ headBlock: 101, marketBlock: 101 })
})

it('rechecks account forwarding and fee tier after reads instead of trusting an earlier snapshot', async () => {
  vi.mocked(PerplAdapter.prototype.getBalance).mockImplementation(async () => {
    account = { ...account, ft: 1 }
    return { available: '10.000000', locked: '0.000000', decimals: 6, updatedAt: Date.now(), observedBlock: head }
  })
  await expect(venue!.openingMarketSnapshot!(1)).resolves.toMatchObject({ takerFeeMicros: 300 })
  vi.mocked(PerplAdapter.prototype.getBalance).mockImplementation(async () => {
    account = { ...account, fw: false }
    return { available: '10.000000', locked: '0.000000', decimals: 6, updatedAt: Date.now(), observedBlock: head }
  })
  await expect(venue!.openingMarketSnapshot!(1)).rejects.toThrow('PERPL_ACCOUNT_STATE_UNAVAILABLE')
})

it('fails closed if the authenticated stream reconnects during quote acquisition', async () => {
  vi.mocked(PerplAdapter.prototype.getBalance).mockImplementation(async () => {
    vi.mocked(PerplTradingClient.prototype.heartbeat).mockReturnValue({ head: 100, sequence: 10, epoch: 'new-stream' })
    return { available: '10.000000', locked: '0.000000', decimals: 6, updatedAt: Date.now(), observedBlock: head }
  })
  await expect(venue!.openingMarketSnapshot!(1)).rejects.toThrow('PERPL_TRADING_STATE_UNTRUSTED')
})

it('keeps stale-market rejection and bounds retries when no fresh source arrives', async () => {
  head = 110
  await expect(venue!.openingMarketSnapshot!(1)).rejects.toThrow('PERPL_OPEN_MARKET_STALE')
  expect(PerplAdapter.prototype.getBalance).toHaveBeenCalledTimes(2)
}, 5000)

it('keeps a permanently future market block and stale heartbeat blocked', async () => {
  marketBlock = 101
  await expect(venue!.openingMarketSnapshot!(1)).rejects.toThrow('PERPL_OPEN_MARKET_STALE')
  marketBlock = 100
  vi.mocked(PerplTradingClient.prototype.heartbeatObservedAt).mockImplementation(() => Date.now() - 5001)
  await expect(venue!.openingMarketSnapshot!(1)).rejects.toThrow('PERPL_OPEN_MARKET_STALE')
}, 7000)

it('refreshes an old balance instead of making its receipt timestamp look fresh', async () => {
  const fresh = { available: '10.000000', locked: '0.000000', decimals: 6, updatedAt: Date.now(), observedBlock: 100 }
  vi.mocked(PerplAdapter.prototype.getBalance)
    .mockResolvedValueOnce({ ...fresh, observedBlock: 90 })
    .mockImplementation(async () => ({ ...fresh, updatedAt: Date.now() }))
  await expect(venue!.openingMarketSnapshot!(1)).resolves.toMatchObject({ balanceBlock: 100, freeBalance: '10.000000' })
  expect(PerplAdapter.prototype.getBalance).toHaveBeenCalledTimes(2)
})

it('does not prefer an older stream frame over a newer REST observation', async () => {
  head = 110
  vi.mocked(PerplAdapter.prototype.getProtocolContext).mockResolvedValue(protocol(110))
  await expect(venue!.openingMarketSnapshot!(1)).resolves.toMatchObject({ marketBlock: 110 })
})

it('allows REST fallback only when the source block passes the existing freshness checks', async () => {
  vi.mocked(PerplMarketStream.prototype.ensure).mockRejectedValue(new Error('PERPL_MARKET_STREAM_CLOSED'))
  vi.mocked(PerplMarketStream.prototype.snapshot).mockResolvedValue(null)
  await expect(venue!.openingMarketSnapshot!(1)).resolves.toMatchObject({ marketBlock: 100 })
  head = 110
  await expect(venue!.openingMarketSnapshot!(1)).rejects.toThrow('PERPL_OPEN_MARKET_STALE')
}, 5000)
