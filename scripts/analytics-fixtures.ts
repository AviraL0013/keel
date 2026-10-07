import { mkdir, writeFile } from 'node:fs/promises'
import type { AnalyticsResponses } from '../packages/analytics/src/contract.js'

// Illustrative, synthetic fixtures. Values do not claim to be observed mainnet totals.
const asOf = '2026-10-07T12:00:00.000Z'
const address = '0x1234567890abcdef1234567890abcdef12345678'
const tx = `0x${'a'.repeat(64)}`
const wrap = <T>(data: T, source: 'derived' | 'perpl_api' | 'monad_exchange' = 'derived') => ({
  asOf,
  block: 35000000,
  source,
  stale: false,
  data,
})
const value = (current: string, previous: string, changePct = '20.00') => ({ value: current, previous, changePct })
const performance = {
  address,
  realizedPnl: '1250.000000',
  winRatePct: '60.00',
  profitFactor: '1.80',
  maxDrawdownPct: '8.50',
  currentStreak: 2,
  longestWinStreak: 4,
  longestLossStreak: 2,
  averageHoldSeconds: 5400,
  bestMarketId: 1,
  worstMarketId: 20,
  closedTrades: 10,
  equityCurve: [
    { time: '2026-10-06T00:00:00.000Z', value: '10000.000000' },
    { time: asOf, value: '11250.000000' },
  ],
} as const
const market = {
  id: 1,
  symbol: 'BTC',
  volume24h: '1200000.000000',
  openInterest: '3100000.000000',
  longOpenInterest: '1550000.000000',
  shortOpenInterest: '1550000.000000',
  longSharePct: '50.00',
  fundingRate: '0.000012',
  markPrice: '112500.0',
} as const
const fixtures: AnalyticsResponses = {
  'GET /protocol/summary': wrap({
    window: '24h',
    volume: value('1200000.000000', '1000000.000000'),
    fees: value('1200.000000', '1000.000000'),
    revenue: value('1200.000000', '1000.000000'),
    activeUsers: value('120', '100'),
    liquidations: value('6', '5'),
    openInterest: value('3100000.000000', '3000000.000000', '3.33'),
    tvl: value('1500000.000000', '1450000.000000', '3.45'),
    netFlows: value('60000.000000', '50000.000000'),
  }),
  'GET /protocol/timeseries': wrap({
    metric: 'volume',
    interval: '1h',
    from: '2026-10-07T10:00:00.000Z',
    to: asOf,
    points: [
      { time: '2026-10-07T10:00:00.000Z', value: '45000.000000' },
      { time: '2026-10-07T11:00:00.000Z', value: '50000.000000' },
    ],
  }),
  'GET /protocol/flows': wrap({
    window: '24h',
    deposits: '100000.000000',
    withdrawals: '40000.000000',
    net: '60000.000000',
    buckets: [
      { time: '2026-10-07T11:00:00.000Z', deposits: '5000.000000', withdrawals: '2000.000000', net: '3000.000000' },
    ],
  }),
  'GET /markets': wrap({ items: [market] }, 'perpl_api'),
  'GET /markets/:id': wrap(
    { ...market, tvl: '500000.000000', priceDecimals: 1, sizeDecimals: 5, fundingIntervalSeconds: 3600 },
    'perpl_api',
  ),
  'GET /markets/:id/funding': wrap(
    { marketId: 1, points: [{ time: '2026-10-07T11:00:00.000Z', block: 34999900, rate: '0.000012' }] },
    'perpl_api',
  ),
  'GET /liquidations': wrap(
    {
      items: [
        {
          id: `34999900:${tx}:0`,
          time: '2026-10-07T11:00:00.000Z',
          marketId: 1,
          address,
          side: 'long',
          notional: '10000.000000',
          realizedPnl: '-1500.000000',
          transactionHash: tx,
        },
      ],
      nextCursor: null,
      summary: { count: 1, notional: '10000.000000' },
    },
    'monad_exchange',
  ),
  'GET /search': wrap({ items: [{ address, accountId: '42' }] }, 'monad_exchange'),
  'GET /wallets/:address': wrap(
    {
      address,
      accountIds: ['42'],
      margin: { balance: '10000.000000', locked: '2000.000000', free: '8000.000000', equity: '11250.000000' },
      positions: [
        {
          id: '7',
          marketId: 1,
          symbol: 'BTC',
          side: 'long',
          size: '0.10000',
          notional: '11250.000000',
          entryPrice: '100000.0',
          markPrice: '112500.0',
          leverage: '5.00',
          collateral: '2000.000000',
          unrealizedPnl: '1250.000000',
          liquidationPrice: '82000.0',
          openedAt: '2026-10-06T00:00:00.000Z',
        },
      ],
    },
    'monad_exchange',
  ),
  'GET /wallets/:address/trades': wrap(
    {
      items: [
        {
          id: `34999900:${tx}:1`,
          time: '2026-10-07T11:00:00.000Z',
          marketId: 1,
          side: 'long',
          action: 'close',
          size: '0.01000',
          price: '112500.0',
          notional: '1125.000000',
          fee: '0.000000',
          realizedPnl: '125.000000',
          transactionHash: tx,
        },
      ],
      nextCursor: null,
    },
    'monad_exchange',
  ),
  'GET /wallets/:address/performance': wrap({ ...performance, equityCurve: [...performance.equityCurve] }),
  'GET /wallets/compare': wrap({ wallets: [{ ...performance, equityCurve: [...performance.equityCurve] }] }),
}

const directory = new URL('../packages/analytics/fixtures/', import.meta.url)
await mkdir(directory, { recursive: true })
for (const [endpoint, fixture] of Object.entries(fixtures)) {
  const file = endpoint.slice(4).replaceAll('/', '_').replaceAll(':', '') + '.json'
  await writeFile(new URL(file, directory), `${JSON.stringify(fixture, null, 2)}\n`)
}
