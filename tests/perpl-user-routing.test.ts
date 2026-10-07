import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { resolveReconciliationVenue, resolveRuntimeVenue, type RuntimeVenue } from '../server/src/runtime.js'
import type { Book } from '../packages/domain/src/index.js'

afterEach(() => vi.unstubAllEnvs())

describe('authenticated venue routing', () => {
  it('reads forwarding only for authenticated wallet owner through enrolled credentials', async () => {
    vi.stubEnv('EYELER_ENV', 'test')
    const store = new MemoryStore()
    const address = '0x0000000000000000000000000000000000000001'
    const userId = await store.ensureUser(address)
    await store.createSession('owner', { userId, walletAddress: address, expiresAt: Date.now() + 60_000 })
    const accountState = vi.fn(async () => ({ status: 'AVAILABLE', accountId: 7, forwardingEnabled: false }))
    const app = createServer(store, {
      enrollment: { accountState, startCleanup: () => {}, stopCleanup: () => {} } as never,
    })
    try {
      const unauthenticated = await app.inject({ method: 'GET', url: '/connections/perpl/account-state' })
      expect(unauthenticated.statusCode).toBe(401)
      const response = await app.inject({
        method: 'GET',
        url: '/connections/perpl/account-state',
        headers: { authorization: 'Bearer owner' },
      })
      expect(response.json()).toEqual({ status: 'AVAILABLE', accountId: 7, forwardingEnabled: false })
      expect(accountState).toHaveBeenCalledWith(userId, address)
    } finally {
      await app.close()
    }
  })
  it('uses renewed credentials only for reconciliation, preserving the historical owner and connection', async () => {
    const recovery = { connectionId: 'old' } as RuntimeVenue
    const recoveryForUser = vi.fn(async () => recovery)
    const directory = { forUser: vi.fn(async () => undefined), recoveryForUser } as unknown as RuntimeVenue
    const book = { userId: 'a', perplConnectionId: 'old' } as Book
    expect(await resolveRuntimeVenue(directory, 'a', book)).toBeUndefined()
    expect(recoveryForUser).not.toHaveBeenCalled()
    expect(await resolveReconciliationVenue(directory, 'a', book)).toBe(recovery)
    expect(recoveryForUser).toHaveBeenCalledWith('a', 'old')
    recoveryForUser.mockClear()
    expect(await resolveReconciliationVenue(directory, 'b', book)).toBeUndefined()
    expect(await resolveReconciliationVenue(directory, 'a', { ...book, perplConnectionId: undefined })).toBeUndefined()
    expect(recoveryForUser).not.toHaveBeenCalled()
  })
  it('reads each session account and never reads the directory as a shared account', async () => {
    vi.stubEnv('EYELER_ENV', 'test')
    vi.stubEnv('EYELER_ALLOWED_WALLETS', '')
    vi.stubEnv('MONAD_WALLET_ADDRESS', '')
    const store = new MemoryStore()
    const userA = await store.ensureUser('0x0000000000000000000000000000000000000001')
    const userB = await store.ensureUser('0x0000000000000000000000000000000000000002')
    await store.createSession('a', {
      userId: userA,
      walletAddress: '0x0000000000000000000000000000000000000001',
      expiresAt: Date.now() + 60_000,
    })
    await store.createSession('b', {
      userId: userB,
      walletAddress: '0x0000000000000000000000000000000000000002',
      expiresAt: Date.now() + 60_000,
    })
    const shared = vi.fn(async () => [{ accountId: 642 }])
    const child = (accountId: number) =>
      ({ accountId, listPositions: async () => [{ accountId }], validate: async () => 'VALID' }) as RuntimeVenue
    const forUser = vi.fn(async (id: string) => (id === userA ? child(101) : id === userB ? child(202) : undefined))
    const app = createServer(store, { venue: { forUser, listPositions: shared } as unknown as RuntimeVenue })
    try {
      const get = (token: string, url = '/connections/perpl/positions') =>
        app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
      expect((await get('a')).json()).toMatchObject({ positions: [{ accountId: 101 }] })
      expect((await get('b')).json()).toMatchObject({ positions: [{ accountId: 202 }] })
      expect(shared).not.toHaveBeenCalled()
      expect(forUser).toHaveBeenCalledWith(userA, undefined)
      expect(forUser).toHaveBeenCalledWith(userB, undefined)
    } finally {
      await app.close()
    }
  })

  it('cannot create an unbound Book when per-user connection is missing', async () => {
    vi.stubEnv('EYELER_ENV', 'test')
    vi.stubEnv('EYELER_ALLOWED_WALLETS', '')
    vi.stubEnv('MONAD_WALLET_ADDRESS', '')
    const store = new MemoryStore()
    const userId = await store.ensureUser('0x0000000000000000000000000000000000000001')
    await store.createSession('a', {
      userId,
      walletAddress: '0x0000000000000000000000000000000000000001',
      expiresAt: Date.now() + 60_000,
    })
    const create = vi.spyOn(store, 'createBook')
    const app = createServer(store, { venue: { forUser: async () => undefined } as unknown as RuntimeVenue })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/books',
        headers: { authorization: 'Bearer a' },
        payload: {
          market: 'BTC',
          side: 'LONG',
          stance: 'DEFEND',
          liquidationFloor: 5,
          defenseCap: 1,
          reserveAvailable: 1,
          timeLimitMs: 60_000,
          automationEnabled: false,
          marketId: 1,
          venueAccountId: 642,
          venuePositionId: 1,
        },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'PERPL_CONNECTION_REQUIRED' })
      expect(create).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
