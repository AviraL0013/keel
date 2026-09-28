import { expect, it, vi } from 'vitest'
import { AusdAdapter } from '../packages/ausd/src/index.js'
import { PerplAdapter } from '../packages/perpl/src/index.js'
import { createPerplRuntime } from '../server/src/infrastructure/perpl/runtime.js'
import { databaseFixture } from './helpers/database.js'

it('reads AUSD for the signed-in wallet even when an operator wallet is configured', async () => {
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
  vi.spyOn(PerplAdapter.prototype, 'getBalance').mockResolvedValue({ available: '2', locked: '0', decimals: 6 })
  const venue = createPerplRuntime(store)
  try {
    const capital = await venue!.capital!(signedIn)
    expect(walletBalance).toHaveBeenCalledWith(signedIn)
    expect(capital.walletAusd.amount).toBe('123')
  } finally {
    await venue?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await db.close()
  }
}, 20_000)
