import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthService } from '../server/src/auth.js'
import { loadConfig } from '../server/src/config/index.js'
import { registerRoutes } from '../server/src/interfaces/http/register.js'
import { databaseFixture } from './helpers/database.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('serves unsigned analytics through full registration while private routes remain authenticated', async () => {
  vi.stubEnv('EYELER_ANALYTICS_ENABLED', 'true')
  const recorded = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8'))
  const fetcher = vi.fn(async (url: string) => {
    if (!url.endsWith('/v1/pub/context')) throw new Error('UNEXPECTED_FIXTURE_FETCH')
    return Response.json(recorded.context)
  })
  vi.stubGlobal('fetch', fetcher)
  const { db, store } = await databaseFixture()
  const app = Fastify()
  try {
    const config = loadConfig({ EYELER_ENV: 'test' })
    await app.register(cookie, { secret: config.sessionSecret })
    const auth = new AuthService(store, config.sessionSecret)
    const session = vi.spyOn(auth, 'get')
    registerRoutes({ app, config, persistence: store, auth, notificationStore: null })
    const markets = await app.inject('/analytics/v1/markets')
    expect(markets.statusCode).toBe(200)
    expect(markets.json().data.items.length).toBeGreaterThan(0)
    expect(markets.headers['cache-control']).toContain('public')
    const summary = await app.inject({
      url: '/analytics/v1/protocol/summary?window=all',
      headers: { authorization: 'Bearer invalid-unused-session' },
    })
    expect(summary.statusCode).toBe(200)
    expect(summary.json().coverage.completeHistory).toBe(false)
    expect(summary.json().coverage.label).toBe('No indexed history')
    expect(session).not.toHaveBeenCalled()
    for (const url of ['/books', '/capital', '/strategies', '/openings/markets', '/analytics/v1-private'])
      expect((await app.inject(url)).statusCode, url).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/analytics/v1/markets' })).statusCode).toBe(401)
  } finally {
    await app.close()
    await db.close()
  }
}, 30_000)
