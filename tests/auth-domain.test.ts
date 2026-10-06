import { expect, it, vi } from 'vitest'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { privateKeyToAccount } from 'viem/accounts'

it('binds sign-in to the configured app, wallet and network and rejects a changed domain', async () => {
  vi.stubEnv('EYELER_ENV', 'test')
  vi.stubEnv('CORS_ORIGIN', 'https://app.fixture.invalid')
  vi.stubEnv('EYELER_APP_URL', 'https://app.fixture.invalid')
  const wallet = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  const app = createServer(new MemoryStore())
  try {
    const challenge = (
      await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: wallet.address } })
    ).json()
    expect(challenge.message).toContain('App: https://app.fixture.invalid')
    expect(challenge.message).toContain(`Wallet: ${wallet.address.toLowerCase()}`)
    expect(challenge.message).toContain('Chain ID: 10143')
    expect(challenge.message).toContain('does not authorize trades')
    const changed = challenge.message.replace('app.fixture.invalid', 'evil.invalid')
    const response = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        address: wallet.address,
        nonce: challenge.nonce,
        message: changed,
        signature: await wallet.signMessage({ message: changed }),
      },
    })
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
  } finally {
    await app.close()
    vi.unstubAllEnvs()
  }
})
