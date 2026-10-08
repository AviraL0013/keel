import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const endpoints = [
  [
    '_protocol_summary.json',
    ['window', 'volume', 'fees', 'revenue', 'activeUsers', 'liquidations', 'openInterest', 'tvl', 'netFlows'],
  ],
  ['_protocol_timeseries.json', ['metric', 'interval', 'from', 'to', 'points']],
  ['_protocol_flows.json', ['window', 'deposits', 'withdrawals', 'net', 'buckets']],
  ['_markets.json', ['items']],
  [
    '_markets_id.json',
    [
      'id',
      'symbol',
      'volume24h',
      'openInterest',
      'longOpenInterest',
      'shortOpenInterest',
      'longSharePct',
      'fundingRate',
      'markPrice',
      'tvl',
      'priceDecimals',
      'sizeDecimals',
      'fundingIntervalSeconds',
    ],
  ],
  ['_markets_id_funding.json', ['marketId', 'points']],
  ['_markets_id_prices.json', ['marketId', 'interval', 'from', 'to', 'points']],
  ['_liquidations.json', ['items', 'nextCursor', 'summary']],
  ['_search.json', ['items']],
  ['_wallets_address.json', ['address', 'accountIds', 'margin', 'positions']],
  ['_wallets_address_trades.json', ['items', 'nextCursor']],
  [
    '_wallets_address_performance.json',
    [
      'address',
      'realizedPnl',
      'winRatePct',
      'profitFactor',
      'maxDrawdownPct',
      'currentStreak',
      'longestWinStreak',
      'longestLossStreak',
      'averageHoldSeconds',
      'bestMarketId',
      'worstMarketId',
      'closedTrades',
      'equityCurve',
    ],
  ],
  ['_wallets_compare.json', ['wallets']],
] as const

describe('Analytics v1 contract fixtures', () => {
  it.each(endpoints)('%s has envelope and declared data fields', (name, fields) => {
    const response = JSON.parse(readFileSync(`packages/analytics/fixtures/${name}`, 'utf8')) as Record<string, unknown>
    expect(
      Object.keys(response)
        .filter((key) => key !== 'coverage')
        .sort(),
    ).toEqual(['asOf', 'block', 'data', 'source', 'stale'])
    expect(new Date(response.asOf as string).toISOString()).toBe(response.asOf)
    expect(Number.isSafeInteger(response.block)).toBe(true)
    expect(['perpl_api', 'monad_exchange', 'derived', 'external']).toContain(response.source)
    expect(typeof response.stale).toBe('boolean')
    expect(Object.keys(response.data as Record<string, unknown>).sort()).toEqual([...fields].sort())
  })
})
