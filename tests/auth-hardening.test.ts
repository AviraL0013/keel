import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { privateKeyToAccount } from 'viem/accounts'
import { createServer } from '../server/src/index.js'
import { AuthService } from '../server/src/auth.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { registerRoutes } from '../server/src/interfaces/http/register.js'
import { loadConfig } from '../packages/shared/src/index.js'
import { databaseFixture } from './helpers/database.js'

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
beforeEach(() => vi.stubEnv('EYELER_ENV', 'test'))
afterEach(() => vi.unstubAllEnvs())

async function proof(app: FastifyInstance, wallet = owner) {
  const challenge = (
    await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: wallet.address } })
  ).json()
  return {
    address: wallet.address,
    nonce: challenge.nonce,
    message: challenge.message,
    signature: await wallet.signMessage({ message: challenge.message }),
  }
}
async function login(app: FastifyInstance, wallet = owner) {
  const response = await app.inject({ method: 'POST', url: '/auth/verify', payload: await proof(app, wallet) })
  expect(response.statusCode).toBe(200)
  return response.json().token as string
}

it('rejects a forged signature without burning the owner challenge; then rejects replay', async () => {
  const app = createServer(new MemoryStore())
  try {
    const valid = await proof(app)
    const forged = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { ...valid, signature: await other.signMessage({ message: valid.message }) },
    })
    expect(forged.statusCode).toBe(400)
    expect(forged.json().error).toBe('AUTH_SIGNATURE_INVALID')
    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: valid })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: valid })).json().error).toBe(
      'AUTH_CHALLENGE_INVALID',
    )
  } finally {
    await app.close()
  }
})

it('issues only one session for simultaneous valid submissions', async () => {
  const app = createServer(new MemoryStore())
  try {
    const valid = await proof(app)
    const replies = await Promise.all(
      [0, 1].map(() => app.inject({ method: 'POST', url: '/auth/verify', payload: valid })),
    )
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 400])
  } finally {
    await app.close()
  }
})

it('prefers the explicit bearer identity and globally revokes only that wallet’s sessions', async () => {
  const app = createServer(new MemoryStore())
  try {
    const a1 = await login(app),
      a2 = await login(app),
      b = await login(app, other)
    const selected = await app.inject({
      url: '/auth/session',
      headers: { authorization: `Bearer ${b}`, cookie: `eyeler_session=${a1}` },
    })
    expect(selected.json().walletAddress).toBe(other.address.toLowerCase())
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/logout-all',
          headers: { authorization: `Bearer ${a1}`, cookie: `eyeler_session=${b}` },
        })
      ).statusCode,
    ).toBe(200)
    for (const token of [a1, a2]) {
      expect(
        (await app.inject({ url: '/auth/session', headers: { authorization: `Bearer ${token}` } })).statusCode,
      ).toBe(401)
    }
    expect((await app.inject({ url: '/auth/session', headers: { authorization: `Bearer ${b}` } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/auth/logout-all' })).statusCode).toBe(401)
  } finally {
    await app.close()
  }
})

it('rejects malformed authentication bodies and limits challenge requests', async () => {
  const app = createServer(new MemoryStore())
  try {
    expect((await app.inject({ method: 'POST', url: '/auth/challenge', payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: {} })).statusCode).toBe(400)
    const replies = []
    for (let i = 0; i < 11; i++)
      replies.push(
        await app.inject({
          method: 'POST',
          url: '/auth/challenge',
          payload: { address: owner.address },
          remoteAddress: '192.0.2.1',
        }),
      )
    expect(replies.slice(0, 10).every((r) => r.statusCode === 200)).toBe(true)
    expect(replies[10].statusCode).toBe(429)
  } finally {
    await app.close()
  }
})

it('uses HTTPS-only cookies for both live networks', async () => {
  for (const environment of ['testnet', 'mainnet'] as const) {
    const app = Fastify()
    await app.register(cookie)
    const store = new MemoryStore()
    registerRoutes({
      app,
      config: loadConfig({ EYELER_ENV: environment }),
      persistence: store,
      auth: new AuthService(store, 'fixture'),
      notificationStore: null,
    })
    try {
      const response = await app.inject({ method: 'POST', url: '/auth/verify', payload: await proof(app) })
      expect(response.statusCode).toBe(200)
      expect(response.headers['set-cookie']).toContain('Secure')
      expect(response.headers['set-cookie']).toContain('HttpOnly')
    } finally {
      await app.close()
    }
  }
})

it('revokes all owner sessions in PostgreSQL while preserving another user', async () => {
  const { db, store } = await databaseFixture()
  try {
    const a = await store.ensureUser(owner.address),
      b = await store.ensureUser(other.address)
    for (const [token, userId, wallet] of [
      ['a1', a, owner],
      ['a2', a, owner],
      ['b', b, other],
    ] as const) {
      await store.createSession(token, { userId, walletAddress: wallet.address, expiresAt: Date.now() + 60000 })
    }
    await store.revokeUserSessions(a)
    expect(await store.getSession('a1')).toBeNull()
    expect(await store.getSession('a2')).toBeNull()
    expect((await store.getSession('b'))?.userId).toBe(b)
  } finally {
    await db.close()
  }
}, 20000)
