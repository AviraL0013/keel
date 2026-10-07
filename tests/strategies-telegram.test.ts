import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { StrategyStore } from '../server/src/infrastructure/strategies/store.js'
import { StrategyTelegramCommands } from '../server/src/infrastructure/strategies/telegram-commands.js'
import { TelegramLinks } from '../server/src/infrastructure/telegram/links.js'
import type { StrategyConfig } from '../packages/strategies/src/index.js'

const config: StrategyConfig = {
  kind: 'GRID',
  mode: 'PAPER',
  marketId: 16,
  accountId: 642,
  capital: 100,
  quoteSize: 0.1,
  maxNotional: 100,
  maxInventory: 0.2,
  maxOpenOrders: 2,
  maxDailyLoss: 5,
  maxDrawdownPct: 5,
  maxVolatility: 0.1,
  maxDataAgeMs: 2000,
  maxPriceBandBps: 100,
  maxFundingRate: 0.001,
  leverage: 1,
  grid: { lower: 99, upper: 101, levels: 3 },
}

it('runs linked-user Telegram controls once without sending an external message', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000070')
    const connection = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE',now()+interval '1 hour')`,
      [connection, user],
    )
    await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
      connection,
    ])
    await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',642,$1)", [user])
    const strategies = new StrategyStore(store.pool, 'testnet')
    const created = await strategies.create(user, connection, config)
    await strategies.start(user, created.id)
    const sent: string[] = []
    const secret = 'fixture-webhook-secret-only-32chars'
    const commands = new StrategyTelegramCommands(store.pool, 'testnet', async (_chat, text) => {
      sent.push(text)
    })
    const links = new TelegramLinks(store.pool, 'EyelerFixtureBot', secret, Date.now, commands)
    const token = new URL((await links.start(user)).url).searchParams.get('start')!
    const update = (id: number, text: string, chatType = 'private') => ({
      update_id: id,
      message: {
        date: Math.floor(Date.now() / 1000),
        text,
        chat: { id: 101, type: chatType },
        from: { id: 101, is_bot: false },
      },
    })
    await links.handle(secret, update(1, `/start ${token}`))
    await links.handle(secret, update(2, '/status'))
    await links.handle(secret, update(2, '/status'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('1 running')
    await links.handle(secret, update(3, '/pause'))
    expect((await strategies.get(user, created.id))!.status).toBe('PAUSED')
    await links.handle(secret, update(4, '/pnl'))
    expect(sent.at(-1)).toContain('simulated PnL')
    await links.handle(secret, update(5, '/resume'))
    expect((await strategies.get(user, created.id))!.status).toBe('RUNNING')
    await links.handle(secret, update(6, '/killswitch'))
    expect(await strategies.killed(user)).toBe(true)
    await links.handle(secret, update(7, '/resume'))
    expect((await strategies.get(user, created.id))!.status).toBe('HALTED')
    const before = sent.length
    await links.handle(secret, update(8, '/pause', 'group'))
    await links.unlink(user)
    await links.handle(secret, update(9, '/status'))
    expect(sent).toHaveLength(before)
  } finally {
    await db.close()
  }
}, 30_000)

async function commandFixture() {
  const fixture = await databaseFixture()
  const { db, store } = fixture
  const user = await store.ensureUser('telegram-command-owner')
  const other = await store.ensureUser('telegram-command-other')
  const connections = [randomUUID(), randomUUID()]
  for (const [index, owner] of [user, other].entries())
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
       VALUES($1,$2,'testnet','trade','fixture','ACTIVE',now()+interval '1 hour')`,
      [connections[index], owner],
    )
  const strategy = (
    await db.query<{ id: string }>(
      `INSERT INTO strategies(user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status)
     VALUES($1,$2,'testnet',642,16,'PAPER','GRID',100,'{}','{}','RUNNING') RETURNING id`,
      [user, connections[0]],
    )
  ).rows[0].id
  const otherStrategy = (
    await db.query<{ id: string }>(
      `INSERT INTO strategies(user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status)
     VALUES($1,$2,'testnet',643,16,'PAPER','GRID',100,'{}','{}','RUNNING') RETURNING id`,
      [other, connections[1]],
    )
  ).rows[0].id
  await db.query('INSERT INTO telegram_links(user_id,telegram_user_id,chat_id) VALUES($1,101,101)', [user])
  const sent = vi.fn(async (_chat: string, _text: string) => {})
  const commands = new StrategyTelegramCommands(store.pool, 'testnet', sent)
  const secret = 'fixture-webhook-secret-only-32chars'
  const links = new TelegramLinks(store.pool, 'EyelerFixtureBot', secret, Date.now, commands)
  const update = (text = '/killswitch') => ({
    update_id: 501,
    message: {
      date: Math.floor(Date.now() / 1000),
      text,
      chat: { id: 101, type: 'private' },
      from: { id: 101, is_bot: false },
    },
  })
  return { ...fixture, user, other, strategy, otherStrategy, sent, commands, links, secret, update }
}

it('rolls back the Telegram update claim when execution fails so the same update can retry once', async () => {
  const f = await commandFixture()
  try {
    const execute = vi.spyOn(f.commands, 'execute').mockRejectedValueOnce(new Error('FAKE_COMMAND_FAILURE'))
    await expect(f.links.handle(f.secret, f.update())).rejects.toThrow('FAKE_COMMAND_FAILURE')
    await f.links.handle(f.secret, f.update())
    await f.links.handle(f.secret, f.update())
    expect(execute).toHaveBeenCalledTimes(2)
    expect(
      (await f.db.query<{ killed: boolean }>('SELECT killed FROM strategy_user_controls WHERE user_id=$1', [f.user]))
        .rows[0]?.killed,
    ).toBe(true)
    expect(
      (await f.db.query('SELECT * FROM strategy_risk_events WHERE strategy_id=$1', [f.strategy])).rows,
    ).toHaveLength(1)
    expect(
      (await f.db.query<{ status: string }>('SELECT status FROM strategies WHERE id=$1', [f.otherStrategy])).rows[0]
        .status,
    ).toBe('RUNNING')
    expect(f.sent).toHaveBeenCalledOnce()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('checks the captured Telegram link again before mutating controls', async () => {
  const f = await commandFixture()
  const connect = f.store.pool.connect.bind(f.store.pool)
  try {
    const execute = vi.spyOn(f.commands, 'execute')
    let revoked = false
    vi.spyOn(f.store.pool, 'connect').mockImplementation(async () => {
      const client = await connect()
      return {
        ...client,
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values)
          if (!revoked && sql.startsWith('SELECT id,user_id,chat_id FROM telegram_links')) {
            revoked = true
            // Inject a revocation after the first lookup, before authorization.
            await f.db.query('UPDATE telegram_links SET revoked_at=now() WHERE user_id=$1', [f.user])
          }
          return result
        },
      } as never
    })
    await f.links.handle(f.secret, f.update())
    expect(revoked).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    expect(
      (await f.db.query('SELECT killed FROM strategy_user_controls WHERE user_id=$1', [f.user])).rows,
    ).toHaveLength(0)
    expect(f.sent).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    await f.db.close()
  }
}, 30_000)

it('rolls back both control mutations and the update claim on a mid-command database failure', async () => {
  const f = await commandFixture()
  const connect = f.store.pool.connect.bind(f.store.pool)
  try {
    let fail = true
    vi.spyOn(f.store.pool, 'connect').mockImplementation(async () => {
      const client = await connect()
      return {
        ...client,
        query: async (sql: string, values?: unknown[]) => {
          if (fail && sql.includes('INSERT INTO strategy_risk_events')) {
            fail = false
            throw new Error('FAKE_CONTROL_DATABASE_FAILURE')
          }
          return client.query(sql, values)
        },
      } as never
    })
    await expect(f.links.handle(f.secret, f.update())).rejects.toThrow('FAKE_CONTROL_DATABASE_FAILURE')
    expect(
      (await f.db.query<{ status: string }>('SELECT status FROM strategies WHERE id=$1', [f.strategy])).rows[0].status,
    ).toBe('RUNNING')
    expect((await f.db.query('SELECT * FROM strategy_user_controls WHERE user_id=$1', [f.user])).rows).toHaveLength(0)
    expect((await f.db.query('SELECT * FROM telegram_webhook_updates WHERE update_id=501')).rows).toHaveLength(0)
    expect(f.sent).not.toHaveBeenCalled()
    await f.links.handle(f.secret, f.update())
    await f.links.handle(f.secret, f.update())
    expect(
      (await f.db.query('SELECT * FROM strategy_risk_events WHERE strategy_id=$1', [f.strategy])).rows,
    ).toHaveLength(1)
    expect(f.sent).toHaveBeenCalledOnce()
  } finally {
    vi.restoreAllMocks()
    await f.db.close()
  }
}, 30_000)

it('never repeats a committed control after a fake Telegram reply failure', async () => {
  const f = await commandFixture()
  try {
    const execute = vi.spyOn(f.commands, 'execute')
    f.sent.mockRejectedValueOnce(new Error('FAKE_REPLY_FAILURE'))
    await expect(f.links.handle(f.secret, f.update())).rejects.toThrow('FAKE_REPLY_FAILURE')
    await f.links.handle(f.secret, f.update())
    expect(execute).toHaveBeenCalledOnce()
    expect(f.sent).toHaveBeenCalledOnce()
    expect(
      (await f.db.query('SELECT * FROM strategy_risk_events WHERE strategy_id=$1', [f.strategy])).rows,
    ).toHaveLength(1)
  } finally {
    vi.restoreAllMocks()
    await f.db.close()
  }
}, 30_000)
