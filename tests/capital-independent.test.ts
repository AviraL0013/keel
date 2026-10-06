import { describe, expect, it, vi } from 'vitest'
import { ChainAdapter, chainConfigs } from '../packages/chain/src/index.js'
import { AusdAdapter } from '../packages/ausd/src/index.js'
import { createPublicCapital } from '../server/src/infrastructure/capital/snapshot.js'
import { perplNetworks } from '../packages/perpl/src/index.js'

const wallet = '0x0000000000000000000000000000000000000001'
describe('independent on-chain capital', () => {
  it('keeps the unavailable Agora card labeled AUSD and exposes a specific chain mismatch reason', async () => {
    vi.spyOn(AusdAdapter.prototype, 'walletBalance').mockRejectedValue(new Error('MONAD_CHAIN_MISMATCH'))
    try {
      const capital = await createPublicCapital(undefined, { EYELER_ENV: 'testnet' })!(wallet, 'fixture-user')
      expect(capital.walletAgoraAusd).toMatchObject({ asset: 'AUSD', amount: null, reason: 'MONAD_CHAIN_MISMATCH' })
      expect(capital.walletAusd).toMatchObject({ asset: 'USD', amount: null, reason: 'MONAD_CHAIN_MISMATCH' })
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('rejects a wrong RPC chain before reading any token', async () => {
    const chain = new ChainAdapter('testnet')
    vi.spyOn(chain.client, 'getChainId').mockResolvedValue(143)
    vi.spyOn(chain.client, 'getBlockNumber').mockResolvedValue(123n)
    const read = vi.spyOn(chain.client, 'readContract').mockResolvedValue(0n as never)
    await expect(chain.getAusdBalance(wallet)).rejects.toThrow('MONAD_CHAIN_MISMATCH')
    expect(read).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('reads the signed-in wallet without Perpl or Agora credentials and retains exact micro-units', async () => {
    const read = vi.spyOn(AusdAdapter.prototype, 'walletBalance').mockImplementation(async function (
      this: AusdAdapter,
      address,
    ) {
      expect(address).toBe(wallet)
      return {
        token: chainConfigs.testnet.ausdToken,
        chainId: 10143,
        raw: 9007199254740993n,
        decimals: 6,
        symbol: 'AUSD',
      }
    })
    try {
      const capital = await createPublicCapital(undefined, { EYELER_ENV: 'testnet' })!(wallet, 'fixture-user')
      expect(read).toHaveBeenCalledTimes(2)
      expect(capital.walletAgoraAusd).toMatchObject({
        amount: '9007199254.740993',
        asset: 'AUSD',
        availability: 'AVAILABLE',
        onChain: {
          wallet,
          chainId: 10143,
          token: chainConfigs.testnet.ausdToken,
          explorerUrl: `https://testnet.monadexplorer.com/address/${wallet}`,
        },
      })
      expect(capital.walletAusd.asset).toBe('USD')
      expect(capital.perplAvailable).toMatchObject({ amount: null, reason: 'PERPL_NOT_CONNECTED' })
      expect(capital.bookRemaining).toMatchObject({ amount: null, reason: 'DATABASE_NOT_CONFIGURED' })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('rejects invalid token units instead of displaying a false balance', async () => {
    const chain = new ChainAdapter('testnet', { ausdToken: perplNetworks.testnet.collateralToken })
    const read = vi.spyOn(chain, 'getAusdBalance')
    const adapter = new AusdAdapter(chain)
    for (const bad of [
      { decimals: 18 },
      { balance: -1n },
      { balance: 1n << 256n },
      { chainId: 143 },
      { address: wallet },
    ]) {
      read.mockResolvedValue({
        balance: 10n,
        decimals: 6,
        symbol: 'USD',
        address: chain.config.ausdToken,
        chainId: 10143,
        ...bad,
      } as never)
      await expect(adapter.walletBalance(wallet)).rejects.toThrow('INVALID_TOKEN_SNAPSHOT')
    }
    vi.restoreAllMocks()
  })
})
