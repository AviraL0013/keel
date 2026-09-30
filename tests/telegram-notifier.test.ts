import { describe, expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { TelegramNotifier, createTelegramNotifier } from '../server/src/infrastructure/telegram/notifier.js'
import { EyelerRuntime, type RuntimeVenue } from '../server/src/runtime.js'

async function fixture(fetcher: typeof fetch, now: () => number = Date.now) {
  const { db, store } = await databaseFixture()
  const userId = await store.ensureUser('telegram-test-owner')
  const book = await db.query<{ id: string }>(
    "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'ETH-PERP','LONG','DEFEND',5,5,3600000) RETURNING id",
    [userId],
  )
  const bookId = book.rows[0].id
  const add = async (kind = 'SAFE_MODE', title = 'Private wallet 0x1234567890123456789012345678901234567890') => {
    const row = await db.query<{ id: string }>(
      'INSERT INTO notifications(user_id,book_id,kind,title,body,dedupe_key) VALUES($1,$2,$3,$4,$5,gen_random_uuid()::text) RETURNING id',
      [userId, bookId, kind, title, 'Internal error with secret'],
    )
    return row.rows[0].id
  }
  const notifier = new TelegramNotifier(
    store.pool,
    { botToken: 'fake-token', chatId: 'operator-chat', appUrl: 'https://app.example' },
    fetcher,
    now,
  )
  return { db, store, bookId, add, notifier, close: () => db.close() }
}

describe('Telegram notification delivery', () => {
  it('sends each notification once with a Book link and no private details', async () => {
    const requests: Array<{ url: string; body: { text: string } }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Response.json({ ok: true })
    }) as typeof fetch
    const value = await fixture(fetcher)
    try {
      const id = await value.add()
      await value.notifier.pollOnce()
      await value.notifier.pollOnce()
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(requests[0].body.text).toContain(`https://app.example/?book=${value.bookId}`)
      expect(requests[0].body.text).not.toMatch(/fake-token|0x1234567890123456789012345678901234567890|Internal error/)
      expect(
        (await value.db.query('SELECT status,attempts FROM telegram_deliveries WHERE notification_id=$1', [id]))
          .rows[0],
      ).toMatchObject({ status: 'SENT', attempts: 1 })
    } finally {
      await value.close()
    }
  }, 20_000)

  it('delivers a due batch at one-second spacing with market and side', async () => {
    const clock = { at: Date.now() }
    const sentAt: number[] = []
    const messages: string[] = []
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentAt.push(clock.at)
      messages.push((JSON.parse(String(init?.body)) as { text: string }).text)
      return Response.json({ ok: true })
    }) as typeof fetch
    const value = await fixture(fetcher, () => clock.at)
    try {
      for (let i = 0; i < 3; i++) await value.add('ACTION_CONFIRMED', 'DEFEND: CONFIRMED')
      const notifier = new TelegramNotifier(
        value.store.pool,
        { botToken: 'fake-token', chatId: 'operator-chat', appUrl: 'https://app.example' },
        fetcher,
        () => clock.at,
        async (ms) => {
          clock.at += ms
        },
      )
      await notifier.pollOnce()
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(sentAt).toEqual([sentAt[0], sentAt[0] + 1000, sentAt[0] + 2000])
      expect(messages).toEqual(Array(3).fill(expect.stringContaining('EYELER: DEFEND confirmed — ETH-PERP long')))
    } finally {
      await value.close()
    }
  }, 20_000)

  it('limits each poll to ten notifications', async () => {
    const clock = { at: Date.now() }
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
    const value = await fixture(fetcher, () => clock.at)
    try {
      for (let i = 0; i < 11; i++) await value.add('ACTION_CONFIRMED', 'EXIT: CONFIRMED')
      const notifier = new TelegramNotifier(
        value.store.pool,
        { botToken: 'fake-token', chatId: 'operator-chat', appUrl: 'https://app.example' },
        fetcher,
        () => clock.at,
        async (ms) => {
          clock.at += ms
        },
      )
      await notifier.pollOnce()
      expect(fetcher).toHaveBeenCalledTimes(10)
      await notifier.pollOnce()
      expect(fetcher).toHaveBeenCalledTimes(11)
    } finally {
      await value.close()
    }
  }, 30_000)

  it('retries a definite Telegram rejection after backoff', async () => {
    const clock = { at: Date.now() }
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls++
      return Response.json({ ok: calls > 1 }, { status: calls > 1 ? 200 : 503 })
    }) as typeof fetch
    const value = await fixture(fetcher, () => clock.at)
    try {
      const id = await value.add('ACTION_CONFIRMED')
      await value.notifier.pollOnce()
      await value.notifier.pollOnce()
      expect(calls).toBe(1)
      clock.at += 30_000
      await value.notifier.pollOnce()
      expect(calls).toBe(2)
      expect(
        (await value.db.query('SELECT status,attempts FROM telegram_deliveries WHERE notification_id=$1', [id]))
          .rows[0],
      ).toMatchObject({ status: 'SENT', attempts: 2 })
    } finally {
      await value.close()
    }
  }, 20_000)

  it('does nothing without both Telegram credentials and the app URL', async () => {
    const fetcher = vi.fn() as typeof fetch
    const value = await fixture(fetcher)
    try {
      await value.add()
      expect(createTelegramNotifier(value.store.pool, {}, fetcher)).toBeUndefined()
      expect(createTelegramNotifier(value.store.pool, { TELEGRAM_BOT_TOKEN: 'fake-token' }, fetcher)).toBeUndefined()
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      await value.close()
    }
  }, 20_000)

  it('allows a local HTTP app link only for a testnet rehearsal', () => {
    const env = { TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_CHAT_ID: 'operator-chat', EYELER_ENV: 'testnet' }
    expect(createTelegramNotifier({} as never, { ...env, EYELER_APP_URL: 'http://localhost:8082' })).toBeInstanceOf(
      TelegramNotifier,
    )
    expect(createTelegramNotifier({} as never, { ...env, EYELER_APP_URL: 'http://127.0.0.1:8082' })).toBeInstanceOf(
      TelegramNotifier,
    )
    expect(() => createTelegramNotifier({} as never, { ...env, EYELER_APP_URL: 'http://evil.example' })).toThrow(
      'INVALID_EYELER_APP_URL',
    )
    expect(() =>
      createTelegramNotifier({} as never, { ...env, EYELER_ENV: 'mainnet', EYELER_APP_URL: 'http://localhost:8082' }),
    ).toThrow('INVALID_EYELER_APP_URL')
  })

  it('does not resend after an ambiguous transport failure', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('SIMULATED_NETWORK_TIMEOUT')
    }) as typeof fetch
    const value = await fixture(fetcher)
    try {
      const id = await value.add('ACTION_UNKNOWN')
      await value.notifier.pollOnce()
      await value.notifier.pollOnce()
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(
        (await value.db.query('SELECT status,attempts FROM telegram_deliveries WHERE notification_id=$1', [id]))
          .rows[0],
      ).toMatchObject({ status: 'UNKNOWN', attempts: 1 })
    } finally {
      await value.close()
    }
  }, 20_000)

  it('marks an abandoned in-flight send unknown after restart without resending', async () => {
    const clock = { at: Date.now() }
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
    const value = await fixture(fetcher, () => clock.at)
    try {
      const id = await value.add('ACTION_SUBMITTED')
      await value.db.query(
        "INSERT INTO telegram_deliveries(notification_id,status,attempts,started_at) VALUES($1,'SENDING',1,$2)",
        [id, new Date(clock.at - 61_000).toISOString()],
      )
      await value.notifier.pollOnce()
      expect(fetcher).not.toHaveBeenCalled()
      expect(
        (await value.db.query('SELECT status,attempts FROM telegram_deliveries WHERE notification_id=$1', [id]))
          .rows[0],
      ).toMatchObject({ status: 'UNKNOWN', attempts: 1 })
    } finally {
      await value.close()
    }
  }, 20_000)

  it('does not wait for Telegram before the trading loop can continue', async () => {
    let release!: () => void
    let started!: () => void
    const sendStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocked = new Promise<Response>((resolve) => {
      release = () => resolve(Response.json({ ok: true }))
    })
    const fetcher = vi.fn(async () => {
      started()
      return blocked
    }) as typeof fetch
    const value = await fixture(fetcher)
    try {
      await value.add('AUTOMATION_RETRY_EXHAUSTED')
      const delivery = value.notifier.pollOnce()
      await sendStarted
      const venue = { ready: () => true, close: async () => undefined } as RuntimeVenue
      const runtime = new EyelerRuntime(value.store, venue)
      Object.assign(runtime, { lease: { query: async () => ({ rows: [] }) } })
      await (runtime as unknown as { tick(): Promise<void> }).tick()
      expect(fetcher).toHaveBeenCalledTimes(1)
      release()
      await delivery
    } finally {
      release?.()
      await value.close()
    }
  }, 20_000)
})
