import { expect, it } from 'vitest'
import { PerplPublicAnalytics, type PublicMarket } from '../server/src/infrastructure/analytics/perpl-public.js'
import {
  completePublicProtocol,
  readPublicProtocolCompletion,
} from '../server/src/infrastructure/analytics/protocol-completion.js'

const exchange = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F'
const market = (id: number, state: Partial<PublicMarket['state']> = {}): PublicMarket => ({
  id,
  perpetual_id: id,
  symbol: `M${id}`,
  name: `M${id}`,
  funding_interval_sec: 3600,
  config: { price_decimals: 2, size_decimals: 3 },
  state: {
    at: { b: 123, t: Date.now() },
    mrk: 12_345,
    oi: 1_000,
    tvl: '9007199254740993123456',
    dva: '1000001',
    ...state,
  },
  funding: { rate: 10, at: { b: 123, t: Date.now() } },
})

const observation = (markets: PublicMarket[]) => ({
  value: { chain: { chain_id: 143 }, instances: [{ address: exchange }], markets },
  asOf: new Date().toISOString(),
  block: 123,
  stale: false,
})

it('calculates exact current OI and TVL while leaving every historical boundary unknown', () => {
  const result = completePublicProtocol(observation([market(1), market(2, { mrk: 1, oi: 1, tvl: '1' })]))
  expect(result.live.openInterest).toMatchObject({ value: '123.450010', previous: null, changePct: null })
  expect(result.live.tvl).toMatchObject({ value: '9007199254740993.123457', previous: null })
  expect(result.asOf).toBeTruthy()
  expect(result.block).toBe(123)
  for (const item of Object.values(result.publicHistoryGaps)) {
    expect(item.value).toBeNull()
    expect(item.previous).toBeNull()
    expect(item.changePct).toBeNull()
    expect(item.note).toBeTruthy()
  }
  expect(result.publicHistoryGaps.fees.note).toContain('fee rates, not actual fees')
  expect(result.publicHistoryGaps.volume.note).toContain('currently listed markets only')
  expect(result.publicHistoryGaps.funding.note).toContain('per-market funding rates')
})

it('fails each malformed context metric independently, without turning unknown into zero', () => {
  const badOi = completePublicProtocol(observation([market(1, { oi: 1.5 })]))
  expect(badOi.live.openInterest).toMatchObject({ value: null, note: 'PERPL_CONTEXT_OPEN_INTEREST_INVALID' })
  expect(badOi.live.tvl.value).toBe('9007199254740993.123456')

  const badTvl = completePublicProtocol(observation([market(1, { tvl: '-1' })]))
  expect(badTvl.live.tvl).toMatchObject({ value: null, note: 'PERPL_CONTEXT_TVL_INVALID' })
  expect(badTvl.live.openInterest.value).toBe('123.450000')

  const duplicate = completePublicProtocol(observation([market(1), market(1)]))
  expect(duplicate.live.openInterest.value).toBeNull()
  expect(duplicate.live.tvl.note).toBe('PERPL_MARKET_LIST_INVALID')
})

it('reuses public context cache and fails soft on an unavailable or wrong-chain response', async () => {
  let calls = 0
  const source = new PerplPublicAnalytics('https://fake.invalid', async () => {
    calls++
    return Response.json(observation([market(1)]).value)
  })
  expect((await readPublicProtocolCompletion(source)).live.openInterest.value).toBe('123.450000')
  expect((await readPublicProtocolCompletion(source)).live.tvl.value).toBe('9007199254740993.123456')
  expect(calls).toBe(1)

  for (const fetcher of [
    async () => {
      throw Error('offline')
    },
    async () => Response.json({ ...observation([market(1)]).value, chain: { chain_id: 1 } }),
  ]) {
    const failed = await readPublicProtocolCompletion(new PerplPublicAnalytics('https://fake.invalid', fetcher))
    expect(failed.stale).toBe(true)
    expect(failed.live.openInterest).toMatchObject({ value: null, note: 'PERPL_CONTEXT_UNAVAILABLE' })
    expect(failed.live.tvl.value).toBeNull()
  }
})
