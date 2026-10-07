import { expect, it } from 'vitest'
import { listOpeningMarkets, openingMarketSnapshot } from '../packages/perpl/src/opening-market.js'

const now = 1_800_000_000_000
const protocol = {
  chain: {},
  instances: [{ id: 1, collateral_token_id: 2 }],
  tokens: [{ id: 2, symbol: 'USD', decimals: 6 }],
  markets: [
    {
      id: 7,
      symbol: 'BTC',
      instance_id: 1,
      order_ttl_blocks: 10,
      config: {
        is_open: true,
        price_decimals: 1,
        size_decimals: 5,
        initial_margin: 1000,
        taker_fees: [500, 400],
        min_settle_amount: '1000000',
        min_posting_amount: '2000000',
        recycle_fee: '1000',
      },
      state: { at: { b: 100 }, bid: 999999, ask: 1000001, mrk: 1000000 },
      funding: {},
    },
  ],
}
const balance = { available: '50.000000', locked: '10.000000', decimals: 6, updatedAt: now, observedBlock: 100 }
const head = { head: 101, observedAt: now }

it('lists the venue market and exposes exact fresh prices, fee tier and computed minimum lot', () => {
  expect(listOpeningMarkets(protocol)).toEqual([{ id: 7, symbol: 'BTC', status: 'OPEN' }])
  const snapshot = openingMarketSnapshot(protocol, 7, 12, 'testnet', balance, head, 1, now)
  expect(snapshot).toMatchObject({
    marketId: 7,
    accountId: 12,
    bidRaw: 999999,
    askRaw: 1000001,
    markRaw: 1000000,
    priceTick: '0.1',
    sizeStep: '0.00001',
    minimumSize: '0.00002',
    takerFeeMicros: 400,
    freeBalance: '40.000000',
    marketBlock: 100,
    headBlock: 101,
  })
})

it('fails closed on stale stamps, missing fee tier or price, and an unverified wallet balance', () => {
  for (const changed of [
    { state: { ...protocol.markets[0].state, at: { b: 97 } } },
    { state: { ...protocol.markets[0].state, ask: undefined } },
  ])
    expect(() =>
      openingMarketSnapshot(
        { ...protocol, markets: [{ ...protocol.markets[0], ...changed }] } as never,
        7,
        12,
        'testnet',
        balance,
        head,
        1,
        now,
      ),
    ).toThrow()
  expect(() => openingMarketSnapshot(protocol, 7, 12, 'testnet', balance, head, 2, now)).toThrow(
    'PERPL_OPEN_MARKET_UNAVAILABLE',
  )
  expect(() =>
    openingMarketSnapshot(protocol, 7, 12, 'testnet', { ...balance, observedBlock: 96 }, head, 1, now),
  ).toThrow('PERPL_FREE_BALANCE_UNAVAILABLE')
  expect(() =>
    openingMarketSnapshot(protocol, 7, 12, 'testnet', balance, { ...head, observedAt: now - 5001 }, 1, now),
  ).toThrow('PERPL_OPEN_MARKET_STALE')
})
