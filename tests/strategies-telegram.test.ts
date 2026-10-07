import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
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
