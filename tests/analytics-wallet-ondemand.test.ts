import { encodeAbiParameters, encodeEventTopics, type AbiEvent } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { EXCHANGE, EXCHANGE_DEPLOYMENT_BLOCK } from '../packages/analytics/src/decoder.js'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.js'
import {
  HyperSyncHttp,
  WalletOnDemandAnalytics,
  type HyperSyncPage,
  type HyperSyncTransport,
} from '../server/src/infrastructure/analytics/wallet-ondemand.js'
import type { HistoricalOwnerClient } from '../server/src/infrastructure/analytics/owner-proof.js'
import type { PublicContext } from '../server/src/infrastructure/analytics/perpl-public.js'

const wallet = '0x0000000000000000000000000000000000000001'
const foreign = '0x0000000000000000000000000000000000000002'
const first = EXCHANGE_DEPLOYMENT_BLOCK
const tip = first + 60n
const timestamp = Math.floor(Date.now() / 1000) - 60
const blockTime = (number: bigint) => timestamp - Number(tip - number) * 86_400
const blockHash = (number: bigint) => `0x${number.toString(16).padStart(64, '0')}`
const txHash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`
const context = {
  chain: { chain_id: 143 },
  instances: [{ address: EXCHANGE }],
  markets: [
    {
      id: 7,
      perpetual_id: 12,
      symbol: 'BTC',
      name: 'Bitcoin',
      funding_interval_sec: 3600,
      config: { price_decimals: 0, size_decimals: 0 },
      state: { at: {}, mrk: 100, oi: 0, tvl: '0', dva: '0' },
      funding: { rate: 0, at: {} },
    },
    {
      id: 8,
      perpetual_id: 13,
      symbol: 'ETH',
      name: 'Ethereum',
      funding_interval_sec: 3600,
      config: { price_decimals: 0, size_decimals: 0 },
      state: { at: {}, mrk: 100, oi: 0, tvl: '0', dva: '0' },
      funding: { rate: 0, at: {} },
    },
  ],
} satisfies PublicContext

function log(name: string, day: number, tx: number, index: number, fields: Record<string, bigint | string> = {}) {
  const definition = exchangeEvents.find((event) => event.name === name) as AbiEvent
  const values = definition.inputs.map(
    (input) =>
      fields[input.name!] ??
      (input.type === 'address'
        ? wallet
        : input.type === 'bool'
          ? false
          : input.name === 'perpId'
            ? 12n
            : input.name === 'accountId'
              ? 1n
              : input.name === 'positionType'
                ? 0n
                : input.name === 'lotLNS'
                  ? 1n
                  : input.name === 'pricePNS' || input.name === 'entryPricePNS'
                    ? 100n
                    : 0n),
  )
  const topics = encodeEventTopics({ abi: [definition], eventName: name })
  const block = first + BigInt(day)
  return {
    address: EXCHANGE,
    block_number: Number(block),
    block_hash: blockHash(block),
    transaction_hash: txHash(tx),
    transaction_index: 0,
    log_index: index,
    data: encodeAbiParameters(definition.inputs, values),
    topic0: topics[0],
    topic1: topics[1],
    topic2: topics[2],
    topic3: topics[3],
  }
}
function fixture(
  logs: ReturnType<typeof log>[],
  options: { owner?: (account: bigint, block: bigint) => string; page?: number } = {},
) {
  const calls: number[] = []
  const ownerFor = options.owner ?? ((account: bigint) => (account === 1n ? wallet : foreign))
  const client: HistoricalOwnerClient = {
    getChainId: async () => 143,
    getBlock: async (input) => {
      const number = input.blockTag === 'finalized' ? tip : input.blockNumber
      return { number, hash: blockHash(number), timestamp: BigInt(blockTime(number)) }
    },
    readContract: async (input) => {
      const id =
        input.functionName === 'getAccountById'
          ? (input.args[0] as bigint)
          : input.args[0] === wallet
            ? 1n
            : ownerFor(1n, input.blockNumber) === foreign
              ? 1n
              : 2n
      return { accountId: id, accountAddr: ownerFor(id, input.blockNumber) }
    },
  }
  const transport: HyperSyncTransport = {
    height: async () => Number(tip) + 1,
    query: async (from, to): Promise<HyperSyncPage> => {
      calls.push(from)
      const next = Math.min(to, from + (options.page ?? 100))
      const found = logs.filter((item) => item.block_number >= from && item.block_number < next)
      return {
        next_block: next,
        archive_height: Number(tip) + 1,
        data: [
          {
            logs: found,
            blocks: [...new Set(found.map((item) => item.block_number))].map((number) => ({
              number,
              hash: blockHash(BigInt(number)),
              timestamp: blockTime(BigInt(number)),
            })),
          },
        ],
      }
    },
  }
  return { reader: new WalletOnDemandAnalytics(client, transport), calls }
}
const input = { address: wallet, accountIds: ['1'], accountsComplete: true, context, startingEquityMicros: 10_000_000n }

describe('wallet HyperSync on demand', () => {
  it('attributes maker and taker sides separately, includes partial reductions, and caches 60 seconds', async () => {
    const logs = [
      log('MakerOrderFilled', 31, 1, 0, { accountId: 1n, feeCNS: 100n }),
      log('PositionOpened', 31, 1, 1, { accountId: 1n }),
      log('MakerOrderFilled', 32, 2, 0, { accountId: 2n, perpId: 13n }),
      log('PositionOpened', 32, 2, 1, { accountId: 2n, perpId: 13n }),
      log('TakerOrderFilled', 32, 2, 2, { feeCNS: 200n }),
      log('PositionOpened', 32, 2, 3, { accountId: 1n, perpId: 13n }),
      log('MakerOrderFilled', 33, 3, 0, { accountId: 1n }),
      log('PositionDecreased', 33, 3, 1, { accountId: 1n, deltaPnlCNS: 1_000_000n }),
      log('MakerOrderFilled', 34, 4, 0, { accountId: 1n }),
      log('PositionClosed', 34, 4, 1, { accountId: 1n, deltaPnlCNS: -2_000_000n }),
    ]
    const { reader, calls } = fixture(logs, { page: 10 })
    const result = await reader.load(input)
    expect(result.label).toBe('last 30 days')
    expect(result.trades).toHaveLength(4)
    expect(result.trades.find((trade) => trade.id.endsWith(':2'))?.fee).toBe('0.000200')
    expect(result.trades.find((trade) => trade.action === 'reduce')?.realizedPnl).toBe('1.000000')
    expect(result.performance?.realizedPnl).toBe('-1.000000')
    expect(result.performance?.maxDrawdownPct).toBe('18.18')
    const queries = calls.length
    await reader.load(input)
    expect(calls).toHaveLength(queries)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001)
    try {
      await reader.load(input)
      expect(calls.length).toBeGreaterThan(queries)
    } finally {
      clock.mockRestore()
    }
  })

  it('withholds totals for ambiguous partial fills in one transaction', async () => {
    const { reader } = fixture([
      log('MakerOrderFilled', 31, 1, 0),
      log('MakerOrderFilled', 31, 1, 1),
      log('PositionOpened', 31, 1, 2),
    ])
    const result = await reader.load(input)
    expect(result.performance).toBeNull()
    expect(result.unavailableReason).toMatch(/ATTRIBUTION_UNRECONCILED/)
  })

  it('does not infer taker from an ambiguous maker settlement', async () => {
    const { reader } = fixture([
      log('MakerOrderFilled', 31, 1, 0, { accountId: 2n }),
      log('PositionOpened', 31, 1, 1, { accountId: 2n }),
      log('PositionOpened', 31, 1, 2, { accountId: 2n }),
      log('TakerOrderFilled', 31, 1, 3),
      log('PositionOpened', 31, 1, 4, { accountId: 1n }),
    ])
    const result = await reader.load(input)
    expect(result.trades).toHaveLength(0)
    expect(result.performance).toBeNull()
    expect(result.unavailableReason).toMatch(/ATTRIBUTION_UNRECONCILED/)
  })

  it('keeps a partial liquidation inside its open episode', async () => {
    const { reader } = fixture([
      log('MakerOrderFilled', 31, 1, 0, { lotLNS: 2n }),
      log('PositionOpened', 31, 1, 1, { lotLNS: 2n }),
      log('PositionLiquidated', 32, 2, 0, {
        posAccountId: 1n,
        liqLotLNS: 1n,
        posLotLNS: 2n,
        liqPricePNS: 90n,
        deltaPnlCNS: -1_000_000n,
      }),
      log('MakerOrderFilled', 33, 3, 0),
      log('PositionClosed', 33, 3, 1, { deltaPnlCNS: 2_000_000n }),
    ])
    const result = await reader.load(input)
    expect(result.trades.find((trade) => trade.action === 'liquidation')?.realizedPnl).toBe('-1.000000')
    expect(result.performance?.closedTrades).toBe(1)
    expect(result.performance?.realizedPnl).toBe('1.000000')
  })

  it('checks owner at each event block and excludes later foreign ownership', async () => {
    const { reader } = fixture(
      [
        log('MakerOrderFilled', 31, 1, 0),
        log('PositionOpened', 31, 1, 1),
        log('MakerOrderFilled', 34, 2, 0),
        log('PositionClosed', 34, 2, 1, { deltaPnlCNS: 1_000_000n }),
      ],
      { owner: (_account, block) => (block < first + 33n ? wallet : foreign) },
    )
    const result = await reader.load(input)
    expect(result.trades).toHaveLength(1)
    expect(result.performance?.realizedPnl).toBe('0.000000')
  })

  it('keeps missing opening and unverified account enumeration unavailable', async () => {
    const { reader } = fixture([
      log('MakerOrderFilled', 31, 1, 0),
      log('PositionClosed', 31, 1, 1, { deltaPnlCNS: 1_000_000n }),
    ])
    expect((await reader.load(input)).unavailableReason).toBe('EPISODE_OPENING_UNAVAILABLE')
    const incomplete = await reader.load({ ...input, accountsComplete: false })
    expect(incomplete.performance).toBeNull()
    expect(incomplete.unavailableReason).toBe('ACCOUNT_ENUMERATION_UNVERIFIED')
  })

  it('keeps unsupported settlement totals and drawdown without baseline unavailable with reasons', async () => {
    const { reader } = fixture([log('PositionUnwound', 31, 1, 0)])
    const result = await reader.load({ ...input, startingEquityMicros: undefined })
    expect(result.performance).toBeNull()
    expect(result.unavailableReason).toBe('SETTLEMENT_FORMULA_UNVERIFIED')
    expect(result.maxDrawdownUnavailableReason).toBe('STARTING_EQUITY_UNAVAILABLE')
  })

  it('uses finalized 30-day time bounds, excluding older settlements', async () => {
    const { reader } = fixture([
      log('MakerOrderFilled', 29, 1, 0),
      log('PositionClosed', 29, 1, 1, { deltaPnlCNS: 9_000_000n }),
      log('MakerOrderFilled', 31, 2, 0),
      log('PositionOpened', 31, 2, 1),
    ])
    const result = await reader.load(input)
    expect(result.trades).toHaveLength(1)
    expect(result.performance?.realizedPnl).toBe('0.000000')
  })

  it('withholds totals when historical ownership proof fails', async () => {
    const { reader } = fixture([log('MakerOrderFilled', 31, 1, 0), log('PositionOpened', 31, 1, 1)], {
      owner: () => '0x0000000000000000000000000000000000000000',
    })
    const result = await reader.load(input)
    expect(result.trades).toHaveLength(0)
    expect(result.performance).toBeNull()
    expect(result.unavailableReason).toBe('OWNERSHIP_UNAVAILABLE')
  })

  it('keeps a removed or unknown market unavailable instead of publishing partial PnL', async () => {
    const { reader } = fixture([
      log('MakerOrderFilled', 31, 1, 0, { perpId: 99n }),
      log('PositionOpened', 31, 1, 1, { perpId: 99n }),
    ])
    const result = await reader.load(input)
    expect(result.performance).toBeNull()
    expect(result.unavailableReason).toBe('MARKET_OR_EVENT_CONTEXT_UNAVAILABLE')
  })

  it('uses bearer token only in request header and filters Exchange topics', async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      json: async () => ({ next_block: 2, data: [] }),
      options,
    })) as unknown as typeof fetch
    const http = new HyperSyncHttp('hidden-token', 'https://monad.hypersync.xyz', fetcher)
    await http.query(1, 2)
    const [url, options] = vi.mocked(fetcher).mock.calls[0]
    expect(url).toBe('https://monad.hypersync.xyz/query')
    expect((options as RequestInit).headers).toMatchObject({ authorization: 'Bearer hidden-token' })
    expect(String((options as RequestInit).body)).not.toContain('hidden-token')
    expect(JSON.parse(String((options as RequestInit).body)).logs[0].address).toEqual([EXCHANGE])
  })
})
