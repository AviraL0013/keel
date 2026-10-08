import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WalletChainAnalytics } from '../server/src/infrastructure/analytics/wallet-chain.js'
import type { PublicContext } from '../server/src/infrastructure/analytics/perpl-public.js'
import { EXCHANGE } from '../packages/analytics/src/decoder.js'

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('UNEXPECTED_TEST_NETWORK')
    }),
  ),
)
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('wallet cache never bypasses context validation or carries a fresh label past the source age limit', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 20_000)
  const { wallet, client } = setup()
  expect((await wallet.profile(address, context))?.stale).toBe(false)
  clock.mockReturnValue(now + 31_000)
  expect((await wallet.profile(address, context))?.stale).toBe(true)
  expect(client.getChainId).toHaveBeenCalledOnce()
  await expect(wallet.profile(address, { ...context, chain: { chain_id: 10143 } })).rejects.toThrow(
    'ANALYTICS_RPC_CONTEXT_MISMATCH',
  )
  const changed = {
    ...context,
    markets: context.markets.map((market) => ({ ...market, config: { ...market.config, price_decimals: 3 } })),
  }
  expect((await wallet.profile(address, changed))?.data.positions[0]?.entryPrice).toBe('9.9995')
  expect(client.getChainId).toHaveBeenCalledTimes(2)
})

const now = Date.now(),
  seconds = BigInt(Math.floor(now / 1000))
const address = '0x0000000000000000000000000000000000000025'
const hash = '0x' + '12'.repeat(32)
const other = '0x' + '34'.repeat(32)
const context: PublicContext = {
  chain: { chain_id: 143 },
  instances: [{ address: EXCHANGE }],
  markets: [
    {
      id: 1,
      perpetual_id: 1,
      symbol: 'BTC',
      name: 'BTC',
      funding_interval_sec: 600,
      config: { price_decimals: 2, size_decimals: 2 },
      state: { at: { b: 100, t: now }, mrk: 10000, oi: 10, tvl: '10', dva: '0' },
      funding: { at: { b: 100, t: now }, rate: 0 },
    },
  ],
}
const setup = () => {
  const calls: Array<{ functionName: string; blockNumber: bigint }> = []
  const account = {
    accountId: 25n,
    accountAddr: address,
    balanceCNS: 10_000_000n,
    lockedBalanceCNS: 0n,
    positions: { bank1: 2n, bank2: 0n, bank3: 0n, bank4: 0n },
  }
  const client = {
    getChainId: vi.fn(async () => 143),
    getBlockNumber: vi.fn(async () => 112n),
    getBlock: vi.fn(async (input: { blockTag?: string; blockNumber?: bigint }) => ({
      number: input.blockNumber ?? 100n,
      hash,
      timestamp: input.blockNumber === 90n ? seconds - 10n : seconds,
    })),
    readContract: vi.fn(async (input: { functionName: string; blockNumber: bigint }) => {
      calls.push(input)
      if (input.functionName === 'getPositionV2')
        return [
          {
            accountId: 25n,
            positionType: 0,
            pricePNS: 10000n,
            priceResiduePNSQ16: 32768n,
            lotLNS: 10n,
            entryBlock: 90n,
            depositCNS: 2_000_000n,
            pnlCNS: 50_000n,
          },
          10050n,
          true,
        ]
      return account
    }),
  }
  const wallet = new WalletChainAnalytics(
    'https://rpc.invalid',
    client as unknown as NonNullable<ConstructorParameters<typeof WalletChainAnalytics>[1]>,
  )
  return { wallet, client, calls, account }
}

it('wallet snapshot anchors every view to the finalized block and keeps its source time', async () => {
  const { wallet, client, calls } = setup()
  const result = await wallet.profile(address, context)
  expect(client.getChainId).toHaveBeenCalledOnce()
  expect(client.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
  expect(client.getBlockNumber).not.toHaveBeenCalled()
  expect(calls.every((call) => call.blockNumber === 100n)).toBe(true)
  expect(result?.block).toBe(100)
  expect(result?.asOf).toBe(new Date(Number(seconds) * 1000).toISOString())
  expect(result?.data.positions[0]?.entryPrice).toBe('99.995')
  expect(result?.data.margin.equity).toBe('12.050000')
})

it('wallet snapshot refuses wrong chains, changed hashes, unavailable finality and conflicting account views', async () => {
  const wrong = setup()
  wrong.client.getChainId.mockResolvedValue(10143)
  await expect(wrong.wallet.profile(address, context)).rejects.toThrow('ANALYTICS_RPC_CHAIN_MISMATCH')
  expect(wrong.calls).toHaveLength(0)
  const fork = setup()
  fork.client.getBlock.mockImplementation(async (input) => ({
    number: input.blockNumber ?? 100n,
    timestamp: seconds,
    hash: input.blockNumber === 100n ? other : hash,
  }))
  await expect(fork.wallet.profile(address, context)).rejects.toThrow('ANALYTICS_RPC_BLOCK_CHANGED')
  const unavailable = setup()
  unavailable.client.getBlock.mockRejectedValue(Error('FINALITY_UNSUPPORTED'))
  await expect(unavailable.wallet.profile(address, context)).rejects.toThrow()
  const owner = setup()
  const read = owner.client.readContract.getMockImplementation()!
  owner.client.readContract.mockImplementation(async (input) =>
    input.functionName === 'getAccountById' ? { ...owner.account, balanceCNS: 9n } : read(input),
  )
  await expect(owner.wallet.profile(address, context)).rejects.toThrow('ANALYTICS_ACCOUNT_ROUNDTRIP_MISMATCH')
})

it('wallet snapshot reports partial position coverage without publishing whole-wallet equity', async () => {
  const { wallet, account } = setup()
  account.positions.bank1 = 6n
  const result = await wallet.profile(address, context)
  expect(result?.data.positions).toHaveLength(1)
  expect(result?.data.margin.equity).toBeNull()
  expect(result?.stale).toBe(true)
  expect(result?.coverage?.label).toBe('Wallet positions 1/2')
})

it('wallet snapshot rejects different position bitmaps even when both contain the same count', async () => {
  const { wallet, client, account } = setup()
  const read = client.readContract.getMockImplementation()!
  client.readContract.mockImplementation(async (input) =>
    input.functionName === 'getAccountById'
      ? { ...account, positions: { ...account.positions, bank1: 4n } }
      : read(input),
  )
  await expect(wallet.profile(address, context)).rejects.toThrow('ANALYTICS_ACCOUNT_ROUNDTRIP_MISMATCH')
})

it('wallet snapshot validates bitmap membership and excludes bank-one non-position bits using the SDK mapping', async () => {
  const wrong = setup()
  wrong.account.positions.bank1 = 4n
  await expect(wrong.wallet.profile(address, context)).rejects.toThrow('ANALYTICS_POSITION_BITMAP_MISMATCH')
  const flagged = setup()
  flagged.account.positions.bank1 |= 7n << 253n
  expect((await flagged.wallet.profile(address, context))?.data.margin.equity).toBe('12.050000')
  const boundary = setup()
  boundary.account.positions.bank1 = 0n
  boundary.account.positions.bank2 = 1n
  const changed = { ...context, markets: [{ ...context.markets[0]!, perpetual_id: 253 }] }
  expect((await boundary.wallet.profile(address, changed))?.data.margin.equity).toBe('12.050000')
})

it('wallet snapshot clamps available balance at zero when resting-order locks exceed its balance', async () => {
  const { wallet, account } = setup()
  account.lockedBalanceCNS = 11_000_000n
  expect((await wallet.profile(address, context))?.data.margin.free).toBe('0.000000')
})
