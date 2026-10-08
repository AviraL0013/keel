import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { AuthService } from '../server/src/auth.js'
import { loadConfig } from '../server/src/config/index.js'
import { registerRoutes } from '../server/src/interfaces/http/register.js'

it('authenticates paper strategy controls and keeps live creation disabled', async () => {
  const { db, store } = await databaseFixture()
  const app = Fastify({ logger: false })
  try {
    const wallet = '0x0000000000000000000000000000000000000067'
    const user = await store.ensureUser(wallet)
    const other = await store.ensureUser('0x0000000000000000000000000000000000000068')
    await store.createSession('strategy-owner', { userId: user, walletAddress: wallet, expiresAt: Date.now() + 60000 })
    await store.createSession('strategy-other', { userId: other, walletAddress: wallet, expiresAt: Date.now() + 60000 })
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
    const config = loadConfig({ EYELER_ENV: 'test', EYELER_PERPL_ACCOUNT_MODE: 'per-user' })
    await app.register(cookie, { secret: config.sessionSecret })
    registerRoutes({
      app,
      config,
      persistence: store,
      auth: new AuthService(store, config.sessionSecret),
      notificationStore: null,
    })
    const payload = {
      connectionId: connection,
      config: {
        kind: 'GRID',
        mode: 'PAPER',
        marketId: 16,
        accountId: 642,
        capital: 1000,
        quoteSize: 0.1,
        maxNotional: 500,
        maxInventory: 0.3,
        maxOpenOrders: 4,
        maxDailyLoss: 50,
        maxDrawdownPct: 5,
        maxVolatility: 0.1,
        maxDataAgeMs: 2000,
        maxPriceBandBps: 100,
        maxFundingRate: 0.001,
        leverage: 1,
        grid: { lower: 90, upper: 110, levels: 3 },
      },
    }
    expect((await app.inject({ method: 'POST', url: '/strategies', payload })).statusCode).toBe(401)
    const owner = { authorization: 'Bearer strategy-owner' }
    const created = await app.inject({ method: 'POST', url: '/strategies', headers: owner, payload })
    expect(created.statusCode).toBe(200)
    const id = created.json().id as string
    await db.query(
      `INSERT INTO strategy_accounting_projection(
        environment,strategy_id,market_id,position_size,average_entry,realized_pnl,fees_paid,funding_paid,
        last_block,last_transaction_index,last_log_index,applied_count)
       VALUES('testnet',$1,16,'0.030000000000000000','99.000000000000000000','0.000000000000000000',
        '0.000003000000000000','0.000000000000000000',112,0,0,1)`,
      [id],
    )
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/strategies/${id}/verified-accounting`,
          headers: owner,
        })
      ).json(),
    ).toEqual([
      {
        environment: 'testnet',
        strategyId: id,
        marketId: 16,
        positionSize: '0.030000000000000000',
        averageEntry: '99.000000000000000000',
        realizedPnl: '0.000000000000000000',
        feesPaid: '0.000003000000000000',
        fundingPaid: '0.000000000000000000',
        lastSequence: { block: 112, transaction: 0, log: 0 },
        appliedCount: 1,
      },
    ])
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/strategies/${id}`,
          headers: { authorization: 'Bearer strategy-other' },
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/strategies',
          headers: owner,
          payload: { ...payload, config: { ...payload.config, mode: 'LIVE', liveConfirmed: true } },
        })
      ).statusCode,
    ).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/strategies/${id}/start`, headers: owner })).json().status).toBe(
      'RUNNING',
    )
    expect((await app.inject({ method: 'POST', url: '/strategies/kill-switch', headers: owner })).json()).toEqual({
      killed: true,
    })
    expect((await app.inject({ method: 'POST', url: `/strategies/${id}/resume`, headers: owner })).statusCode).toBe(403)
  } finally {
    await app.close()
    await db.close()
  }
}, 30_000)
