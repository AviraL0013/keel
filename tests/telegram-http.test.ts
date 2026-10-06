import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { TelegramLinks } from '../server/src/infrastructure/telegram/links.js'
import { AuthService } from '../server/src/auth.js'
import { loadConfig } from '../server/src/config/index.js'
import { registerRoutes } from '../server/src/interfaces/http/register.js'

it('accepts authenticated Telegram webhooks without a browser session and keeps link management private', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN_IN_TEST'))
  const { db, store } = await databaseFixture()
  const config = loadConfig({ EYELER_ENV: 'test' })
  const secret = 'fixture-webhook-secret-only-32chars'
  const links = new TelegramLinks(store.pool, 'EyelerFixtureBot', secret)
  const app = Fastify({ logger: false })
  await app.register(cookie, { secret: config.sessionSecret })
  registerRoutes({
    app,
    config,
    persistence: store,
    auth: new AuthService(store, config.sessionSecret),
    notificationStore: null,
    telegramLinks: links,
  })
  const userId = await store.ensureUser('0x0000000000000000000000000000000000000001')
  await store.createSession('fixture-session', {
    userId,
    walletAddress: '0x0000000000000000000000000000000000000001',
    expiresAt: Date.now() + 60000,
  })
  const headers = { authorization: 'Bearer fixture-session' }
  try {
    for (const url of ['/connections/telegram/link', '/connections/telegram/unlink'])
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401)
    const started = await app.inject({ method: 'POST', url: '/connections/telegram/link', headers })
    expect(started.statusCode).toBe(200)
    const token = new URL(started.json().url).searchParams.get('start')!
    const body = {
      update_id: 1,
      message: {
        date: Math.floor(Date.now() / 1000),
        chat: { id: 101, type: 'private' },
        from: { id: 101, is_bot: false },
        text: `/start ${token}`,
      },
    }
    const webhook = (provided?: string) =>
      app.inject({
        method: 'POST',
        url: '/integrations/telegram/webhook',
        headers: provided ? { 'x-telegram-bot-api-secret-token': provided } : {},
        payload: body,
      })
    expect((await webhook()).statusCode).toBe(403)
    expect((await webhook('wrong')).statusCode).toBe(403)
    expect((await webhook(secret)).statusCode).toBe(200)
    const status = await app.inject({ method: 'GET', url: '/connections/telegram', headers })
    expect(status.json()).toMatchObject({ status: 'LINKED' })
    expect(status.body).not.toContain('chat_id')
    expect(status.body).not.toContain(secret)
    expect((await webhook(secret)).statusCode).toBe(200)
    expect((await db.query('SELECT count(*)::int AS count FROM telegram_links')).rows[0].count).toBe(1)
    expect((await app.inject({ method: 'POST', url: '/connections/telegram/unlink', headers })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/connections/telegram', headers })).json()).toEqual({
      status: 'NOT_LINKED',
    })
    expect(network).not.toHaveBeenCalled()
  } finally {
    await app.close()
    await db.close()
    vi.restoreAllMocks()
  }
}, 20000)
