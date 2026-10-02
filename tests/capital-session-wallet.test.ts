import { expect, it, vi } from 'vitest'
import { AusdAdapter } from '../packages/ausd/src/index.js'
import { PerplAdapter } from '../packages/perpl/src/index.js'
import { AgoraAdapter } from '../packages/chain/src/agora.js'
import { createPerplRuntime } from '../server/src/infrastructure/perpl/runtime.js'
import { databaseFixture } from './helpers/database.js'

it('reads testnet USD for the signed-in wallet and separates user Book allocations from Perpl free balance', async () => {
  const operator = '0x0000000000000000000000000000000000000001'
  const signedIn = '0x0000000000000000000000000000000000000002'
  vi.stubEnv('PERPL_API_KEY', 'test-read-only')
  vi.stubEnv('PERPL_API_KEY_SECRET', '11'.repeat(32))
  vi.stubEnv('PERPL_ACCOUNT_ID', '642')
  vi.stubEnv('MONAD_WALLET_ADDRESS', operator)
  vi.stubEnv('AGORA_METRICS_ENABLED', 'false')
  const { db, store } = await databaseFixture()
  const walletBalance = vi.spyOn(AusdAdapter.prototype, 'walletBalance').mockResolvedValue({
    token: '0x0000000000000000000000000000000000000003',
    chainId: 10143,
    raw: 123000000n,
    decimals: 6,
    symbol: 'AUSD',
  })
  const perplBalance = vi.spyOn(PerplAdapter.prototype, 'getBalance').mockResolvedValue({
    available: '2.000000',
    locked: '0.500000',
    decimals: 6,
    updatedAt: Date.now(),
  })
  const userId = await store.ensureUser(signedIn)
  const otherUserId = await store.ensureUser(operator)
  for (const [owner, amount] of [
    [userId, '1.600001'],
    [otherUserId, '99.000000'],
  ] as const) {
    const created = await store.pool.query(
      "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms,status) VALUES($1,'ETH','LONG','DEFEND',3,1,86400000,'ACTIVE') RETURNING id",
      [owner],
    )
    await store.pool.query(
      'INSERT INTO reserves(book_id,available,reserved,deployed,cap) VALUES($1,$2,0.200000,0.300000,2)',
      [created.rows[0].id, amount],
    )
  }
  const venue = createPerplRuntime(store)
  try {
    const capital = await venue!.capital!(signedIn, userId)
    expect(walletBalance).toHaveBeenCalledWith(signedIn)
    expect(capital.walletAusd.amount).toBe('123')
    expect(capital.walletAusd.asset).toBe('USD')
    expect(capital.perplAvailable.amount).toBe('1.500000')
    expect(capital.perplLocked.amount).toBe('0.500000')
    expect(capital.bookRemaining.amount).toBe('1.600001')
    expect(capital.bookReserved.amount).toBe('0.200000')
    expect(capital.bookDeployed.amount).toBe('0.300000')
    expect(capital.reserveCoverage).toMatchObject({
      promised: '1.600001',
      perplFree: '1.500000',
      shortfall: '0.100001',
    })
    expect(capital.bookAllocations).toHaveLength(1)
    perplBalance.mockRejectedValueOnce(new Error('PERPL_UNAVAILABLE'))
    const noPerpl = await venue!.capital!(signedIn, userId)
    expect(noPerpl.walletAusd.amount).toBe('123')
    expect(noPerpl.bookRemaining.amount).toBe('1.600001')
    expect(noPerpl.perplAvailable).toMatchObject({ amount: null, reason: 'PERPL_BALANCE_READ_FAILED' })
    expect(noPerpl.unreservedCapital.amount).toBeNull()
    walletBalance.mockRejectedValueOnce(new Error('RPC_UNAVAILABLE'))
    const noWallet = await venue!.capital!(signedIn, userId)
    expect(noWallet.walletAusd).toMatchObject({ amount: null, reason: 'MONAD_COLLATERAL_READ_FAILED' })
    expect(noWallet.perplAvailable.amount).toBe('1.500000')
  } finally {
    await venue?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await db.close()
  }
}, 20_000)

it('keeps public AUSD supply optional and isolates an Agora outage from wallet and ledger cards', async () => {
  const wallet = '0x0000000000000000000000000000000000000004'
  vi.stubEnv('PERPL_API_KEY', 'test-read-only')
  vi.stubEnv('PERPL_API_KEY_SECRET', '11'.repeat(32))
  vi.stubEnv('PERPL_ACCOUNT_ID', '642')
  vi.stubEnv('AGORA_METRICS_ENABLED', 'true')
  vi.spyOn(AusdAdapter.prototype, 'walletBalance').mockResolvedValue({
    token: '0x0000000000000000000000000000000000000003',
    chainId: 10143,
    raw: 123000000n,
    decimals: 6,
    symbol: 'USD',
  })
  vi.spyOn(PerplAdapter.prototype, 'getBalance').mockResolvedValue({ available: '2.000000', locked: '0', decimals: 6 })
  const metrics = vi
    .spyOn(AgoraAdapter.prototype, 'metrics')
    .mockResolvedValue({ totalSupply: '253317445.813025', partial: false })
  const { db, store } = await databaseFixture()
  const userId = await store.ensureUser(wallet)
  const venue = createPerplRuntime(store)
  try {
    expect((await venue!.capital!(wallet, userId)).ausdMetrics).toMatchObject({
      status: 'AVAILABLE',
      supply: '253317445.813025',
    })
    metrics.mockRejectedValueOnce(new Error('AGORA_OFFLINE'))
    const degraded = await venue!.capital!(wallet, userId)
    expect(degraded.ausdMetrics).toMatchObject({ status: 'UNAVAILABLE', reason: 'AGORA_METRICS_READ_FAILED' })
    expect(degraded.walletAusd.amount).toBe('123')
    expect(degraded.bookRemaining.amount).toBe('0.000000')
  } finally {
    await venue?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await db.close()
  }
}, 20_000)
