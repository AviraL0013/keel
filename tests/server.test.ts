import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
process.env.KEEL_ENV = 'test'
const account = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
describe('server auth and book ownership', () => { it('authenticates a wallet and scopes Books', async () => { const app = createServer(new MemoryStore()); const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: account.address } }); expect(challenge.statusCode).toBe(200); const body = challenge.json() as { message: string; nonce: string }; const signature = await account.signMessage({ message: body.message }); const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: account.address, nonce: body.nonce, message: body.message, signature } }); expect(verify.statusCode).toBe(200); const cookie = verify.headers['set-cookie']; expect(cookie).toBeTruthy(); const created = await app.inject({ method: 'POST', url: '/books', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie }, payload: { market: 'BTC-PERP', side: 'LONG', stance: 'DEFEND', liquidationFloor: 6, defenseCap: 100, timeLimitMs: 8 * 3600000, automationEnabled: false } }); expect(created.statusCode).toBe(200); const list = await app.inject({ method: 'GET', url: '/books', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } }); expect(list.json()).toHaveLength(1); await app.close() }) })

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

