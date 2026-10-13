import { describe, expect, it } from 'vitest'
import { planLiveStrategy, startLiveRisk } from '../packages/strategies/src/live.js'
import { strategySnapshotFromViews } from '../packages/perpl/src/strategy-snapshot.js'
import { liveFixture } from './helpers/live-strategy.js'
import type { WireOrder } from '../packages/perpl/src/decoder.js'
describe('exact live proposals', () => {
  it('builds bounded post-only grid and skewed maker quotes with exact capital costs', () => {
    const f = liveFixture(),
      baseline = startLiveRisk(f.snapshot, f.now)
    const grid = planLiveStrategy(f.config, f.snapshot, baseline, f.now)
    expect(grid.risk).toEqual([])
    expect(grid.quotes.map((q) => [q.priceRaw, q.sizeRaw, q.required])).toEqual([
      [9900, 10, '4.959901'],
      [10200, 10, '5.110201'],
    ])
    f.config.kind = 'MARKET_MAKER'
    f.config.maxNotional = 100
    f.config.maker = { baseSpreadBps: 20, volatilitySpreadMultiplier: 100, inventorySkewBps: 10, refreshMs: 1000 }
    f.snapshot.inventory = '0.5'
    const maker = planLiveStrategy(f.config, f.snapshot, baseline, f.now)
    expect(maker.quotes.find((q) => q.side === 'BUY')!.priceRaw).toBeLessThanOrEqual(f.snapshot.market.bidRaw)
    expect(maker.quotes.find((q) => q.side === 'SELL')!.priceRaw).toBeGreaterThanOrEqual(f.snapshot.market.askRaw)
  })
  it('detects one micro of loss beyond 2^53 without float cancellation', () => {
    const f = liveFixture()
    f.snapshot.equity = '9007199254740993.000001'
    const baseline = startLiveRisk(f.snapshot, f.now)
    f.snapshot.equity = '9007199254740988.000000'
    expect(planLiveStrategy(f.config, f.snapshot, baseline, f.now).risk).toContain('RUN_LOSS')
  })
  it('resets daily loss baseline at UTC midnight while retaining run loss and peak equity', () => {
    const f = liveFixture(Date.UTC(2026, 9, 14, 0, 0, 1))
    const baseline = startLiveRisk(f.snapshot, f.now - 2000)
    baseline.peakEquity = '120'
    baseline.dayStartEquity = '120'
    f.config.maxDailyLoss = 10
    f.config.maxDrawdownPct = 50
    f.snapshot.equity = '110'
    const plan = planLiveStrategy(f.config, f.snapshot, baseline, f.now)
    expect(plan.risk).not.toContain('DAILY_LOSS')
    expect(plan.state.dayStartEquity).toBe('110')
    expect(plan.state.peakEquity).toBe('120')
  })
  it.each(['long', 'short'])('bounds worst-case %s inventory after either quote side fills', (side) => {
    const f = liveFixture(),
      baseline = startLiveRisk(f.snapshot, f.now)
    f.config.maxInventory = 0.2
    f.snapshot.inventory = side === 'long' ? '0.2' : '-0.2'
    const plan = planLiveStrategy(f.config, f.snapshot, baseline, f.now)
    expect(plan.quotes.map((q) => q.side)).toEqual([side === 'long' ? 'SELL' : 'BUY'])
  })
  it('refuses missing freshness, account changes, excessive funding, and unsafe wire precision', () => {
    const f = liveFixture(),
      baseline = startLiveRisk(f.snapshot, f.now)
    f.snapshot.observedAt -= 5001
    expect(planLiveStrategy(f.config, f.snapshot, baseline, f.now).risk).toContain('STALE_DATA')
    f.snapshot.observedAt = f.now
    f.snapshot.depositTotal = '101.000000'
    f.snapshot.fundingRate = '0.11'
    expect(planLiveStrategy(f.config, f.snapshot, baseline, f.now).risk).toEqual(
      expect.arrayContaining(['ACCOUNT_CAPITAL_CHANGED', 'FUNDING']),
    )
    f.snapshot.depositTotal = baseline.depositTotal
    f.snapshot.fundingRate = '0'
    f.config.quoteSize = 9007199254740992
    expect(planLiveStrategy(f.config, f.snapshot, baseline, f.now).risk).toContain('SIZE_PRECISION')
  })
  it('does not inflate undersized quotes or exceed allocated capital', () => {
    const f = liveFixture(),
      baseline = startLiveRisk(f.snapshot, f.now)
    f.snapshot.market.minimumNotionalRaw = '100000000'
    expect(planLiveStrategy(f.config, f.snapshot, baseline, f.now).quotes).toEqual([])
    f.snapshot.market.minimumNotionalRaw = '1'
    f.snapshot.positionCollateral = '99.999999'
    expect(planLiveStrategy(f.config, f.snapshot, baseline, f.now).risk).toContain('NO_ADMISSIBLE_QUOTES')
  })
})
describe('same-block Exchange strategy snapshots', () => {
  const views = () => {
    const f = liveFixture()
    return {
      market: f.snapshot.market,
      contractMarketId: 616,
      account: { id: 642, in: 1, fr: false, fw: true, ft: 0, lfr: '9007199254740993', b: '100000000', lb: '0' },
      chainAccount: {
        accountId: 642n,
        balanceCNS: 100000000n,
        lockedBalanceCNS: 0n,
        frozen: 0,
        accountAddr: '0x0000000000000000000000000000000000000001',
        positions: { bank1: 0n, bank2: 0n, bank3: 0n, bank4: 0n },
      },
      chainPosition: { accountId: 642n, positionType: 0, depositCNS: 0n, lotLNS: 0n, pnlCNS: 0n },
      markValid: true,
      orders: [] as WireOrder[],
      positions: [],
      chainBlock: 100,
      chainHash: f.snapshot.chainHash,
      chainFinalized: true,
      headBlock: 100,
      epoch: 'test',
      sequence: 1,
      observedAt: f.now,
      oracleRaw: 10050,
      volatility: '0.01',
      fundingRate: '0',
      makerFeeMicros: 0,
      funding: { sumRaw: '0', divisor: '1' },
      depositRaw: '100000000',
      withdrawalRaw: '0',
    }
  }
  it('keeps request IDs exact and detects incomplete or mismatched authenticated snapshots', () => {
    const input = views()
    expect(strategySnapshotFromViews(input)).toMatchObject({
      equity: '100.000000',
      account: { lastRequestId: '9007199254740993' },
      inventory: '0.00',
    })
    input.chainAccount.positions.bank3 = 1n << 107n
    expect(() => strategySnapshotFromViews(input)).toThrow('STRATEGY_ACCOUNT_SNAPSHOT_UNVERIFIED')
    input.chainAccount.positions.bank3 = 0n
    input.account.b = '99999999'
    expect(() => strategySnapshotFromViews(input)).toThrow('STRATEGY_ACCOUNT_SNAPSHOT_UNVERIFIED')
  })
  it('retains pending and trigger orders and rejects malformed remaining sizes', () => {
    const input = views()
    input.orders.push({ acc: 642, mkt: 16, oid: 10, rq: '45', st: 8, sr: 0, t: 1, os: 10, fs: 0, at: { b: 100 } })
    expect(strategySnapshotFromViews(input).orders).toHaveLength(1)
    input.orders[0].st = 1
    expect(strategySnapshotFromViews(input).orders).toHaveLength(1)
    input.orders[0].fs = 11
    expect(() => strategySnapshotFromViews(input)).toThrow('STRATEGY_ACCOUNT_SNAPSHOT_UNVERIFIED')
  })
})
