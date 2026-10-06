import { describe, expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { TelegramLinks } from '../server/src/infrastructure/telegram/links.js'
import { TelegramNotifier } from '../server/src/infrastructure/telegram/notifier.js'

describe('private Telegram linking and routing', () => {
  it('binds one-time tokens to a private sender and routes only each owner’s new notifications', async () => {
    const { db, store } = await databaseFixture()
    const clock = { at: Date.now() }
    const secret = 'fixture-webhook-secret-only-32chars'
    const service = new TelegramLinks(store.pool, 'EyelerFixtureBot', secret, () => clock.at)
    const users = await Promise.all(['alice', 'bob'].map((address) => store.ensureUser(address)))
    const sent: Array<{ chat_id: string; text: string }> = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true })
    }) as typeof fetch
    const notifier = new TelegramNotifier(
      store.pool,
      { botToken: 'fixture', appUrl: 'https://app.example', mode: 'per-user' },
      fetcher,
      () => clock.at,
      async (ms) => {
        clock.at += ms
      },
    )
    const books = await Promise.all(
      users.map(
        async (user) =>
          (
            await db.query(
              "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC','LONG','DEFEND',5,5,1000) RETURNING id",
              [user],
            )
          ).rows[0].id,
      ),
    )
    const add = async (i: number, at = clock.at) =>
      db.query(
        "INSERT INTO notifications(user_id,book_id,kind,title,body,dedupe_key,created_at) VALUES($1,$2,'ACTION_CONFIRMED','DEFEND: CONFIRMED','private',gen_random_uuid()::text,$3)",
        [users[i], books[i], new Date(at).toISOString()],
      )
    const update = (token: string, id: number, chat: number, type = 'private', from = chat) => ({
      update_id: id,
      message: {
        date: Math.floor(clock.at / 1000),
        chat: { id: chat, type },
        from: { id: from, is_bot: false },
        text: `/start ${token}`,
      },
    })
    try {
      await add(0, clock.at - 10000)
      const a = await service.start(users[0])
      const tokenA = new URL(a.url).searchParams.get('start')!
      expect(JSON.stringify((await db.query('SELECT * FROM telegram_link_tokens')).rows)).not.toContain(tokenA)
      await expect(service.handle('wrong', update(tokenA, 1, 101))).rejects.toThrow('TELEGRAM_WEBHOOK_UNAUTHORIZED')
      await service.handle(secret, update(tokenA, 2, 101, 'group'))
      await service.handle(secret, update(tokenA, 3, 101, 'private', 102))
      expect(await service.status(users[0])).toEqual({ status: 'NOT_LINKED' })
      await service.handle(secret, update(tokenA, 4, 101))
      await service.handle(secret, update(tokenA, 5, 999))
      const b = await service.start(users[1])
      await service.handle(secret, update(new URL(b.url).searchParams.get('start')!, 6, 202))
      await add(0)
      await add(1)
      await notifier.pollOnce()
      expect(sent.map((s) => s.chat_id).sort()).toEqual(['101', '202'])
      expect(sent.find((s) => s.chat_id === '101')!.text).toContain(books[0])
      expect(sent.find((s) => s.chat_id === '101')!.text).not.toContain(books[1])
      await service.unlink(users[0])
      await add(0)
      await notifier.pollOnce()
      expect(sent).toHaveLength(2)
      const expired = await service.start(users[0])
      clock.at += 600001
      await service.handle(secret, update(new URL(expired.url).searchParams.get('start')!, 7, 101))
      expect(await service.status(users[0])).toEqual({ status: 'NOT_LINKED' })
      expect(await service.status(users[1])).toMatchObject({ status: 'LINKED' })
    } finally {
      await db.close()
    }
  }, 30000)
})
