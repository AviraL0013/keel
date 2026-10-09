import { describe, expect, it } from 'vitest'
import { initialState, type StrategyConfig } from '../packages/strategies/src/index.js'
import { applyPaperFunding } from '../packages/strategies/src/paper-funding.js'

const config = {
  kind: 'GRID',
  mode: 'PAPER',
  marketId: 1,
  accountId: 1,
  capital: 1000,
  quoteSize: 0.1,
  maxNotional: 500,
  maxInventory: 1,
  maxOpenOrders: 4,
  maxDailyLoss: 50,
  maxDrawdownPct: 5,
  maxVolatility: 0.1,
  maxDataAgeMs: 2000,
  maxPriceBandBps: 100,
  maxFundingRate: 0.001,
  leverage: 1,
  grid: { lower: 99, upper: 101, levels: 3 },
} as StrategyConfig
const event = (feb: number, t: number, ppl = 17) => ({
  at: { b: feb, t },
  feb,
  rate: 2,
  idx: 853228,
  ppl,
  sum: 100 + feb,
  div: 1,
})
const observation = (events = [event(100, 10_000)], block = 105, t = 10_500) => ({
  marketId: 1,
  events,
  head: { block, at: t },
  intervalBlocks: 10,
  priceDecimals: 1,
})

describe('forward-paper funding identity and chronology', () => {
  it('bootstraps a flat new simulation without charging earlier exposure', () => {
    const result = applyPaperFunding(initialState(config, 10_500), observation(), 10_500, 2000)
    expect(result.state.fundingPaid).toBe(0)
    expect(result.state.paperFundingCursor?.feb).toBe(100)
    expect(result.state.lastPaperObservedAt).toBe(10_500)
    expect(result.funding).toBeUndefined()
  })
  it('charges observed payment per lot once, persists the interval across restart, and ignores timestamp updates', () => {
    const baseline = applyPaperFunding(initialState(config, 10_500), observation(), 10_500, 2000).state
    const state = { ...baseline, inventory: 0.2 }
    const next = applyPaperFunding(
      state,
      observation([event(100, 10_000), event(110, 11_000)], 115, 11_500),
      11_500,
      2000,
    )
    expect(next.funding?.amount).toBe(0.34)
    expect(next.state.fundingPaid).toBe(0.34)
    const restarted = JSON.parse(JSON.stringify(next.state))
    const repeated = applyPaperFunding(restarted, observation([event(110, 11_050)], 116, 11_600), 11_600, 2000)
    expect(repeated.state.fundingPaid).toBe(0.34)
    expect(repeated.funding).toBeUndefined()
    const short = applyPaperFunding(
      { ...baseline, inventory: -0.2 },
      observation([event(110, 11_000)], 115, 11_500),
      11_500,
      2000,
    )
    expect(short.state.fundingPaid).toBe(-0.34)
  })
  it('does not apply a scheduled future block even when its estimated timestamp has passed', () => {
    const baseline = applyPaperFunding(initialState(config, 10_500), observation(), 10_500, 2000).state
    const waiting = applyPaperFunding(
      { ...baseline, inventory: 0.2 },
      observation([event(110, 10_900)], 109, 11_000),
      11_000,
      2000,
    )
    expect(waiting.state.paperFundingCursor?.feb).toBe(100)
    expect(waiting.state.fundingPaid).toBe(0)
    const due = applyPaperFunding(waiting.state, observation([event(110, 11_100)], 111, 11_200), 11_200, 2000)
    expect(due.state.fundingPaid).toBe(0.34)
  })
  it('refuses a gap, conflicting interval, late effective event, stale head and unproved scaling', () => {
    const baseline = applyPaperFunding(initialState(config, 10_500), observation(), 10_500, 2000).state
    const state = { ...baseline, inventory: 0.2 }
    for (const sample of [
      observation([event(120, 12_000)], 125, 12_500),
      observation([event(100, 10_000, 19)], 105, 10_600),
      observation([event(110, 10_400)], 115, 11_500),
      observation([event(110, 11_000)], 115, 8_000),
      observation([{ ...event(110, 11_000), div: 2 }], 115, 11_500),
      observation([{ ...event(110, 11_000), at: { b: 109, t: 11_000 } }], 115, 11_500),
    ])
      expect(() => applyPaperFunding(state, sample, 12_500, 2000)).toThrow(/STRATEGY_PAPER_FUNDING_/)
    expect(state.fundingPaid).toBe(0)
  })
  it('refuses missing evidence, legacy non-flat exposure and rebinding a saved cursor', () => {
    const initial = initialState(config, 10_500)
    expect(() => applyPaperFunding(initial, observation([]), 10_500, 2000)).toThrow(
      'STRATEGY_PAPER_FUNDING_UNAVAILABLE',
    )
    expect(() => applyPaperFunding({ ...initial, inventory: 0.1 }, observation(), 10_500, 2000)).toThrow(
      'STRATEGY_PAPER_FUNDING_BASELINE_REQUIRED',
    )
    const baseline = applyPaperFunding(initial, observation(), 10_500, 2000).state
    expect(() => applyPaperFunding(baseline, { ...observation(), priceDecimals: 2 }, 10_600, 2000)).toThrow(
      'STRATEGY_PAPER_FUNDING_TERMS_CHANGED',
    )
    expect(() => applyPaperFunding(baseline, { ...observation(), intervalBlocks: 20 }, 10_600, 2000)).toThrow(
      'STRATEGY_PAPER_FUNDING_TERMS_CHANGED',
    )
  })
  it('never charges an effective timestamp newer than the observed chain head', () => {
    const baseline = applyPaperFunding(initialState(config, 10_500), observation(), 10_500, 2000).state
    const state = { ...baseline, inventory: 0.2 }
    expect(() => applyPaperFunding(state, observation([event(110, 11_700)], 115, 11_500), 11_800, 2000)).toThrow(
      'STRATEGY_PAPER_FUNDING_GAP',
    )
    expect(state.fundingPaid).toBe(0)
  })
})
