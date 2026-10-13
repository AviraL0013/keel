import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import Fastify from 'fastify'
import { registerStatusRoute } from '../server/src/interfaces/http/routes/status.js'

afterEach(() => vi.unstubAllEnvs())
it('permits only the exact anonymous GET report while private strategy and lookalike routes remain protected', async () => {
  vi.stubEnv('EYELER_ENV', 'test')
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('EYELER_TEST_VENUE', 'false')
  const app = createServer(new MemoryStore())
  try {
    const response = await app.inject({ method: 'GET', url: '/status.json' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ version: 1, run: null })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).not.toMatch(/0x[0-9a-f]{40}|kms-v1:|rail-v1:|private_key|api[_-]?token/i)
    expect((await app.inject({ method: 'GET', url: '/strategies' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/status/incidents.json' })).statusCode).toBe(503)
    for (const request of [
      { method: 'GET' as const, url: '/status.json/private' },
      { method: 'POST' as const, url: '/status.json' },
      { method: 'GET' as const, url: '/status/incidents.json/private' },
      { method: 'POST' as const, url: '/status/incidents.json' },
    ])
      expect([401, 404]).toContain((await app.inject(request)).statusCode)
  } finally {
    await app.close()
  }
})
it('returns bounded incident pages and static cursor errors without leaking raw storage errors', async () => {
  const app = Fastify()
  registerStatusRoute(app, undefined, async (cursor) => {
    if (cursor === 'bad') throw Error('RELIABILITY_CURSOR_INVALID')
    if (cursor === 'fail') throw Error('private database token must not escape')
    return { incidents: [], nextCursor: null, total: 0 }
  })
  try {
    const response = await app.inject('/status/incidents.json')
    expect(response.json()).toEqual({ incidents: [], nextCursor: null, total: 0 })
    expect(response.headers['cache-control']).toBe('no-store')
    expect((await app.inject('/status/incidents.json?cursor=bad')).statusCode).toBe(400)
    const failed = await app.inject('/status/incidents.json?cursor=fail')
    expect(failed.statusCode).toBe(503)
    expect(failed.json()).toEqual({ error: 'STATUS_STORAGE_UNAVAILABLE' })
  } finally {
    await app.close()
  }
})
