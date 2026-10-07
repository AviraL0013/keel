import { describe, expect, it } from 'vitest'
import { previewOpeningTrade, type OpeningMarketSnapshot } from '../packages/perpl/src/opening-preview.js'

const now = 1_800_000_000_000
const snapshot: OpeningMarketSnapshot = {
  environment: 'mainnet',
  accountId: 642,
  marketId: 1,
  symbol: 'BTC',
  collateralAsset: 'AUSD',
  priceDecimals: 1,
  sizeDecimals: 5,
  collateralDecimals: 6,
  bidRaw: 999_999,
  askRaw: 1_000_001,
  initialMarginBps: 1000,
  takerFeeMicros: 500,
  minimumNotionalRaw: '1000000',
  recycleFeeRaw: '1000',
  marketOpen: true,
  marketObservedAt: now,
  balanceObservedAt: now,
  marketBlock: 100,
  headBlock: 101,
  headObservedAt: now,
  orderTtlBlocks: 10,
  freeBalance: '1000.000000',
}
const input = { side: 'LONG' as const, size: '0.00100', leverage: '5.00', slippageBps: 50 }

describe('exact opening trade previews', () => {
  it('keeps decimal strings, rounds the limit inward, includes fees and never creates an order', () => {
    const quote = previewOpeningTrade(input, snapshot, now)
    expect(quote).toMatchObject({
      environment: 'mainnet',
      accountId: 642,
      marketId: 1,
      side: 'LONG',
      size: '0.00100',
      sizeRaw: 100,
      leverage: '5.00',
      leverageHundredths: 500,
      referencePrice: '100000.1',
      limitPrice: '100500.1',
      limitPriceRaw: 1005001,
      estimatedNotional: '100.500100',
      estimatedMargin: '20.100020',
      estimatedTradingFee: '0.050251',
      recycleFee: '0.001000',
      estimatedRequiredBalance: '20.151271',
      negativePnlCollateralBps: 0,
      builderFeePer100K: 0,
      expiresAt: now + 15000,
      orderTtlBlocks: 10,
    })
    expect(quote).not.toHaveProperty('requestId')
  })
  it('rounds a short minimum price upward rather than exceeding the chosen slippage', () => {
    const quote = previewOpeningTrade({ ...input, side: 'SHORT' }, snapshot, now)
    expect(quote.limitPrice).toBe('99500.0')
    expect(quote.limitPriceRaw).toBe(995000)
    expect(quote.estimatedMargin).toBe('19.999980')
  })
  it('rejects stale/future observations, stale heartbeat, missing market metadata and closed markets', () => {
    for (const change of [
      { marketObservedAt: now - 5001 },
      { balanceObservedAt: now - 5001 },
      { headObservedAt: now - 5001 },
      { marketObservedAt: now + 1 },
      { marketBlock: 97 },
      { marketBlock: 102 },
      { bidRaw: 0 },
      { askRaw: 999998 },
      { marketOpen: false },
      { orderTtlBlocks: 0 },
      { priceDecimals: 19 },
      { takerFeeMicros: -1 },
      { initialMarginBps: 0 },
    ])
      expect(() => previewOpeningTrade(input, { ...snapshot, ...change }, now)).toThrow()
  })
  it('rejects float inputs, exponent notation, rounded lots, unsupported sides and excess leverage', () => {
    for (const change of [
      { size: 0.001 },
      { size: '1e-3' },
      { size: '0.001001' },
      { size: '0' },
      { size: '9007199254740992' },
      { leverage: '10.01' },
      { leverage: '0.99' },
      { leverage: '5.001' },
      { slippageBps: 0 },
      { slippageBps: 201 },
      { side: 'BUY' },
    ])
      expect(() => previewOpeningTrade({ ...input, ...change } as never, snapshot, now)).toThrow(
        'PERPL_OPEN_INPUT_INVALID',
      )
  })
  it('accepts the exact balance boundary, rejects one base unit less, and never treats unreadable as zero', () => {
    const quote = previewOpeningTrade(input, snapshot, now)
    expect(() =>
      previewOpeningTrade(input, { ...snapshot, freeBalance: quote.estimatedRequiredBalance }, now),
    ).not.toThrow()
    expect(() => previewOpeningTrade(input, { ...snapshot, freeBalance: '20.151270' }, now)).toThrow(
      'PERPL_FREE_BALANCE_INSUFFICIENT',
    )
    for (const freeBalance of ['NaN', '-1', '', 'Infinity', '1e3', '1.0000001'])
      expect(() => previewOpeningTrade(input, { ...snapshot, freeBalance }, now)).toThrow(
        'PERPL_FREE_BALANCE_UNAVAILABLE',
      )
  })
  it('requires minimum notional and cannot trust caller-supplied account, fee or environment fields', () => {
    expect(() =>
      previewOpeningTrade({ ...input, size: '0.00001' }, { ...snapshot, minimumNotionalRaw: '2000000' }, now),
    ).toThrow('PERPL_OPEN_BELOW_MINIMUM')
    const quote = previewOpeningTrade(
      { ...input, accountId: 999, environment: 'testnet', builderFeePer100K: 100 } as never,
      snapshot,
      now,
    )
    expect(quote.accountId).toBe(642)
    expect(quote.environment).toBe('mainnet')
    expect(quote.builderFeePer100K).toBe(0)
  })
  it('defaults to 50 bps, rejects slippage above 200 bps, and budgets worst-case long collateral', () => {
    const quote = previewOpeningTrade({ side: 'LONG', size: '0.00100', leverage: '5.00' }, snapshot, now)
    expect(quote.slippageBps).toBe(50)
    expect(quote.estimatedNotional).toBe('100.500100')
    expect(quote.estimatedMargin).toBe('20.100020')
    expect(quote.estimatedTradingFee).toBe('0.050251')
    expect(() => previewOpeningTrade({ ...input, slippageBps: 201 }, snapshot, now)).toThrow('PERPL_OPEN_INPUT_INVALID')
    expect(() => previewOpeningTrade({ ...input, slippageBps: 200 }, snapshot, now)).not.toThrow()
  })
})
