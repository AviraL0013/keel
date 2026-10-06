import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { expect, it, vi } from 'vitest'
import { AuthService } from '../server/src/auth.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { loadConfig } from '../server/src/config/index.js'
import { registerRoutes } from '../server/src/interfaces/http/register.js'
import type { RuntimeVenue } from '../server/src/runtime.js'

async function fixture(openingEnabled: boolean) {
  const store = new MemoryStore()
  const userId = await store.ensureUser('0x0000000000000000000000000000000000000001')
  await store.createSession('fixture-session', { userId, walletAddress: userId, expiresAt: Date.now() + 60000 })
  const markets = vi.fn(async () => [{ id: 7, symbol: 'BTC', status: 'OPEN' as const }])
  const snapshot = vi.fn(async () => ({ marketId: 7, accountId: 12, symbol: 'BTC', observedAt: Date.now() }))
  const scoped: RuntimeVenue = {
    accountId: 12,
    connectionId: 'connection-a',
    ready: () => true,
    submit: async () => {
      throw new Error('NO_ORDER_IN_TEST')
    },
    reconcile: async (action) => action,
    refresh: async () => {},
    close: async () => {},
    listOpeningMarkets: markets,
    openingMarketSnapshot: snapshot,
  }
  const venue: RuntimeVenue = { ...scoped, forUser: async (requested) => (requested === userId ? scoped : undefined) }
  const config = loadConfig({
    EYELER_ENV: 'test',
    EYELER_PERPL_ACCOUNT_MODE: 'per-user',
    EYELER_OPENING_ENABLED: String(openingEnabled),
  })
  const app = Fastify({ logger: false })
  await app.register(cookie, { secret: config.sessionSecret })
  registerRoutes({
    app,
    config,
    persistence: store,
    auth: new AuthService(store, config.sessionSecret),
    notificationStore: null,
    venue,
  })
  return { app, markets, snapshot }
}

it('lists markets and fresh snapshots only for an authenticated per-user connection', async () => {
  const { app, markets, snapshot } = await fixture(true)
  try {
    expect((await app.inject({ method: 'GET', url: '/openings/markets' })).statusCode).toBe(401)
    const headers = { authorization: 'Bearer fixture-session' }
    expect((await app.inject({ method: 'GET', url: '/openings/markets', headers })).json()).toEqual([
      { id: 7, symbol: 'BTC', status: 'OPEN' },
    ])
    const detail = await app.inject({ method: 'GET', url: '/openings/markets/7/snapshot', headers })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ marketId: 7, accountId: 12 })
    expect(markets).toHaveBeenCalledOnce()
    expect(snapshot).toHaveBeenCalledWith(7)
  } finally {
    await app.close()
  }
})

it('refuses opening endpoints when the flag is off and never touches the venue', async () => {
  const { app, markets, snapshot } = await fixture(false)
  try {
    const headers = { authorization: 'Bearer fixture-session' }
    for (const url of ['/openings/markets', '/openings/markets/7/snapshot']) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: 'OPENING_DISABLED' })
    }
    expect(markets).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
  } finally {
    await app.close()
  }
})

it('keeps confirmation disabled without the opening flag and requires a session', async () => {
  const { app } = await fixture(false)
  try {
    const body = {
      previewId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
    }
    expect((await app.inject({ method: 'POST', url: '/openings/confirm', payload: body })).statusCode).toBe(401)
    const response = await app.inject({
      method: 'POST',
      url: '/openings/confirm',
      payload: body,
      headers: { authorization: 'Bearer fixture-session' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: 'OPENING_DISABLED' })
  } finally {
    await app.close()
  }
})
