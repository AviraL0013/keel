import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerplAdapter } from '../packages/perpl/src/index.js'
import { PerplTradingClient } from '../packages/perpl/src/trading.js'
import { createPerplRuntime } from '../server/src/infrastructure/perpl/runtime.js'
import type { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Perpl market identity', () => {
  it('uses the venue name when BTC and MON have empty symbols, preserving market IDs and state', async () => {
    const markets = [
      { id: 1, symbol: '', name: 'BTC', config: {}, state: { at: { b: 100 } }, funding: {} },
      { id: 10, symbol: '  ', name: ' MON ', config: {}, state: { at: { b: 101 } }, funding: {} },
      { id: 20, symbol: 'ETH', name: 'Ethereum', config: {}, state: { at: { b: 102 } }, funding: {} },
      { id: 999, symbol: '', config: {}, state: {}, funding: {} },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        Response.json({
          chain: {},
          instances: [],
          tokens: [],
          markets,
        }),
      ),
    )
    const adapter = new PerplAdapter('mainnet')
    const context = await adapter.getProtocolContext()
    expect(context.markets.map(({ id, symbol }) => ({ id, symbol }))).toEqual([
      { id: 1, symbol: 'BTC' },
      { id: 10, symbol: 'MON' },
      { id: 20, symbol: 'ETH' },
      { id: 999, symbol: '' },
    ])
    expect(context.markets.map((market) => market.state)).toEqual(markets.map((market) => market.state))
    expect(await adapter.getMarket(1)).toMatchObject({ id: 1, symbol: 'BTC', name: 'BTC' })
    expect(await adapter.getMarket(999)).toMatchObject({ id: 999, symbol: '' })
  })

  it('supplies the same verified BTC identity to positions and live Book setup', async () => {
    const now = Date.now()
    const position = {
      acc: 5448,
      mkt: 1,
      pid: 77,
      st: 1,
      sd: 1,
      c: '1660000',
      ep: 829489,
      s: 2,
      lv: 100,
      at: { b: 100, t: now },
      efs: 0,
      xfs: 0,
      fee: '0',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        Response.json({
          chain: {},
          instances: [{ id: 1, collateral_token_id: 1 }],
          tokens: [{ id: 1, decimals: 6 }],
          markets: [
            {
              id: 1,
              instance_id: 1,
              symbol: '',
              name: 'BTC',
              config: { price_decimals: 1, size_decimals: 5, maintenance_margin: 400 },
              state: { mrk: 829535 },
              funding: {},
            },
          ],
        }),
      ),
    )
    vi.spyOn(PerplTradingClient.prototype, 'isReady').mockReturnValue(true)
    vi.spyOn(PerplTradingClient.prototype, 'stateSnapshot').mockReturnValue({ positions: [position] } as never)
    vi.spyOn(PerplTradingClient.prototype, 'positionSnapshot').mockReturnValue({ position, observedAt: now })
    vi.spyOn(PerplAdapter.prototype, 'getBalance').mockResolvedValue({
      available: '0.340449',
      locked: '0',
      decimals: 6,
      updatedAt: now,
      observedBlock: 100,
    })
    vi.spyOn(PerplAdapter.prototype, 'getNormalizedMarket').mockResolvedValue({
      mark: 82953.5,
      oracle: 82953.5,
      bid: 82953.4,
      ask: 82953.5,
      mid: 82953.45,
      spreadBps: 0.01,
      fundingRate: 0,
      depthNotional: 37266.34,
      volatility: 0,
      volume24h: 1,
      openInterest: 1,
      block: 100,
      timestamp: now,
      marketTimestamp: now,
      fundingTimestamp: now,
      orderbookTimestamp: now,
      source: 'perpl-ws',
      freshnessMs: 0,
    })
    const venue = createPerplRuntime({ pool: {} } as PostgresStore, {
      EYELER_ENV: 'mainnet',
      PERPL_API_KEY: 'fixture-only',
      PERPL_API_KEY_SECRET: '11'.repeat(32),
      PERPL_ACCOUNT_ID: '5448',
    })!
    try {
      expect(await venue.listPositions!()).toMatchObject([
        {
          market: 'BTC',
          marketId: 1,
          accountId: 5448,
          positionId: 77,
          bookCreation: { allowed: true },
        },
      ])
      expect(await venue.loadBookSetup!(1, 5448, 77)).toMatchObject({
        market: 'BTC',
        reserveAvailable: 0.340449,
        position: { side: 'LONG', size: 0.00002 },
      })
    } finally {
      await venue.close?.()
    }
  })
})
