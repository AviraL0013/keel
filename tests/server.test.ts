import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import type { Action } from '../packages/domain/src/index.js'
process.env.KEEL_ENV = 'test'
const account = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
describe('server auth and book ownership', () => { it('authenticates a wallet and scopes Books', async () => { const app = createServer(new MemoryStore()); const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: account.address } }); expect(challenge.statusCode).toBe(200); const body = challenge.json() as { message: string; nonce: string }; const signature = await account.signMessage({ message: body.message }); const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: account.address, nonce: body.nonce, message: body.message, signature } }); expect(verify.statusCode).toBe(200); const cookie = verify.headers['set-cookie']; expect(cookie).toBeTruthy(); const created = await app.inject({ method: 'POST', url: '/books', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie }, payload: { market: 'BTC-PERP', side: 'LONG', stance: 'DEFEND', liquidationFloor: 6, defenseCap: 100, timeLimitMs: 8 * 3600000, automationEnabled: false, reserveAvailable: 100 } }); expect(created.statusCode).toBe(200); const list = await app.inject({ method: 'GET', url: '/books', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } }); expect(list.json()).toHaveLength(1); await app.close() }) })

describe('authenticated session state', () => {
  it('returns the verified wallet address for app restoration', async () => {
    const app = createServer(new MemoryStore())
    const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: account.address } })
    const body = challenge.json() as { message: string; nonce: string }
    const signature = await account.signMessage({ message: body.message })
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: account.address, nonce: body.nonce, message: body.message, signature } })
    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${verify.json().token}` } })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ walletAddress: account.address.toLowerCase() })
    await app.close()
  })
})

describe('deterministic Perpl position discovery', () => {
  it('returns normalized positions with account and venue identifiers', async () => {
    const previousVenueFlag = process.env.KEEL_TEST_VENUE
    process.env.KEEL_TEST_VENUE = 'true'
    const app = createServer(new MemoryStore())
    const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: account.address } })
    const challengeBody = challenge.json() as { message: string; nonce: string }
    const signature = await account.signMessage({ message: challengeBody.message })
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: account.address, nonce: challengeBody.nonce, message: challengeBody.message, signature } })
    const cookie = verify.headers['set-cookie']
    const response = await app.inject({ method: 'GET', url: '/connections/perpl/positions', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'VALID', positions: [{ marketId: 1, market: 'BTC-PERP', accountId: 7001, positionId: 11, position: { side: 'LONG', status: 'OPEN' } }] })
    await app.close()
    if (previousVenueFlag === undefined) delete process.env.KEEL_TEST_VENUE
    else process.env.KEEL_TEST_VENUE = previousVenueFlag
  })
})

describe('empty Perpl position discovery', () => {
  it('returns a successful empty list without fabricating a position', async () => {
    const venue = { validate: async () => 'VALID' as const, listPositions: async () => [], submit: async () => ({ venueReference: 'read-only-test', status: 'UNKNOWN' as const }), reconcile: async (action: Action) => action, refresh: async () => undefined, ready: () => true, close: async () => undefined }
    const app = createServer(new MemoryStore(), { venue })
    const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: account.address } })
    const challengeBody = challenge.json() as { message: string; nonce: string }
    const signature = await account.signMessage({ message: challengeBody.message })
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: account.address, nonce: challengeBody.nonce, message: challengeBody.message, signature } })
    const cookie = verify.headers['set-cookie']
    const response = await app.inject({ method: 'GET', url: '/connections/perpl/positions', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'VALID', positions: [] })
    await app.close()
  })
})

describe('Perpl rate limit response', () => {
  it('reports venue throttling instead of calling KEEL server unavailable', async () => {
    const store = new MemoryStore()
    const userId = await store.ensureUser('0xrate-limited')
    await store.createSession('rate-limited-session', { userId, walletAddress: '0xrate-limited', expiresAt: Date.now() + 60_000 })
    const venue = { listPositions: async () => { throw new Error('VENUE_HTTP_429') }, submit: async () => ({ venueReference: 'unused', status: 'UNKNOWN' as const }), reconcile: async (action: Action) => action, refresh: async () => undefined, ready: () => false, close: async () => undefined }
    const app = createServer(store, { venue })
    try {
      const response = await app.inject({ method: 'GET', url: '/connections/perpl/positions', headers: { authorization: 'Bearer rate-limited-session' } })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error: 'PERPL_RATE_LIMITED' })
    } finally { await app.close() }
  })
})

