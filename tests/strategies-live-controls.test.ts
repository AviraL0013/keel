import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import type { StrategyConfig } from '../packages/strategies/src/index.js'
import { StrategyStore, type StrategyLiveController } from '../server/src/infrastructure/strategies/store.js'
import { registerStrategyRoutes } from '../server/src/interfaces/http/routes/strategies.js'
import { databaseFixture } from './helpers/database.js'

const config: StrategyConfig = {
  kind: 'GRID',
  mode: 'LIVE',
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
  grid: { lower: 90, upper: 110, levels: 3 },
  liveConfirmed: true,
}
async function fixture() {
  const f = await databaseFixture()
  const user = await f.store.ensureUser('strategy-live-owner')
  const other = await f.store.ensureUser('strategy-live-other')
  const connection = randomUUID()
  await f.db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
    VALUES($1,$2,'testnet','trade','fixture','ACTIVE',now()+interval '1 hour')`,
    [connection, user],
  )
  await f.db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
    connection,
  ])
  await f.db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',642,$1)", [user])
  let now = Date.now()
  const controller: StrategyLiveController = {
    enabled: true,
    review: vi.fn(async () => ({ ready: true, reasons: [], snapshot: { free: '100.000000' } })),
    admit: vi.fn(async () => {}),
  }
  const repo = new StrategyStore(f.store.pool, 'testnet', controller, () => now)
  return {
    ...f,
    user,
    other,
    connection,
    controller,
    repo,
    advance: (ms: number) => {
      now += ms
    },
  }
}

it('requires bounded, fresh reviewed consent and never treats client liveConfirmed as authorization', async () => {
  const f = await fixture()
  try {
    const disabled = new StrategyStore(f.store.pool, 'testnet')
    await expect(disabled.create(f.user, f.connection, config)).rejects.toThrow('STRATEGIES_LIVE_DISABLED')
    const row = await f.repo.create(f.user, f.connection, config)
    expect(row).toMatchObject({ status: 'PAUSED', config: { liveConfirmed: false }, live_confirmed_at: null })
    await expect(f.repo.start(f.user, row.id)).rejects.toThrow('STRATEGY_LIVE_REVIEW_REQUIRED')
    await expect(f.repo.livePreview(f.other, row.id, 60_000)).rejects.toThrow('STRATEGY_NOT_FOUND')
    for (const duration of [NaN, 1, 86_400_001, 60_000.5])
      await expect(f.repo.livePreview(f.user, row.id, duration)).rejects.toThrow('STRATEGY_RUN_DURATION_INVALID')
    vi.mocked(f.controller.review).mockResolvedValueOnce({ ready: false, reasons: ['ACCOUNT_NOT_EMPTY'] })
    expect(await f.repo.livePreview(f.user, row.id, 60_000)).toMatchObject({ previewId: null, ready: false })
    const review = await f.repo.livePreview(f.user, row.id, 60_000)
    expect(review).toMatchObject({ ready: true, environment: 'testnet', accountId: '642', maxRunMs: 60_000 })
    const confirmation = { previewId: review.previewId!, idempotencyKey: randomUUID(), acknowledgeRealOrders: true }
    await expect(f.repo.confirmLive(f.user, row.id, { ...confirmation, acknowledgeRealOrders: false })).rejects.toThrow(
      'STRATEGY_LIVE_CONFIRMATION_INVALID',
    )
    vi.mocked(f.controller.admit).mockRejectedValueOnce(new Error('FRESH_ACCOUNT_CHANGED'))
    await expect(f.repo.confirmLive(f.user, row.id, confirmation)).rejects.toThrow('FRESH_ACCOUNT_CHANGED')
    expect((await f.repo.get(f.user, row.id))!.status).toBe('PAUSED')
    const started = await f.repo.confirmLive(f.user, row.id, confirmation)
    expect(started).toMatchObject({ status: 'RUNNING', config: { liveConfirmed: true }, live_cleanup_pending: false })
    expect(Number(started.live_max_run_ms)).toBe(60_000)
    expect(new Date(started.live_expires_at!).getTime() - new Date(started.live_confirmed_at!).getTime()).toBe(60_000)
    await f.db.query('UPDATE strategies SET live_state=$2 WHERE id=$1', [
      row.id,
      JSON.stringify({ baselineEquity: '9007199254740993.000001' }),
    ])
    await f.db.query(
      `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory)
      VALUES($1,now(),'9007199254740993.000003','0.00001')`,
      [row.id],
    )
    expect(await f.repo.liveObservation(f.user, row.id)).toMatchObject({
      accountEquity: '9007199254740993.000003000000000000',
      accountEquityChange: '0.000002',
      source: 'Exchange account views',
    })
    const calls = vi.mocked(f.controller.admit).mock.calls.length
    expect((await f.repo.confirmLive(f.user, row.id, confirmation)).status).toBe('RUNNING')
    expect(f.controller.admit).toHaveBeenCalledTimes(calls)
    await expect(f.repo.confirmLive(f.user, row.id, { ...confirmation, idempotencyKey: randomUUID() })).rejects.toThrow(
      'STRATEGY_LIVE_PREVIEW_CONSUMED',
    )
    expect((await f.repo.stop(f.user, row.id)).live_cleanup_pending).toBe(true)
    expect((await f.repo.confirmLive(f.user, row.id, confirmation)).status).toBe('STOPPED')
    expect(f.controller.admit).toHaveBeenCalledTimes(calls)
  } finally {
    await f.db.close()
  }
}, 30_000)

it('rejects expired, superseded, killed and disabled consent; pause queues LIVE cleanup without marking venue orders canceled', async () => {
  const f = await fixture()
  try {
    const row = await f.repo.create(f.user, f.connection, config)
    const confirm = async (previewId: string) =>
      f.repo.confirmLive(f.user, row.id, { previewId, idempotencyKey: randomUUID(), acknowledgeRealOrders: true })
    let review = await f.repo.livePreview(f.user, row.id, 60_000)
    f.advance(15_001)
    await expect(confirm(review.previewId!)).rejects.toThrow('STRATEGY_LIVE_PREVIEW_EXPIRED')
    review = await f.repo.livePreview(f.user, row.id, 60_000)
    await f.db.query('UPDATE strategies SET config=$2,version=version+1 WHERE id=$1', [
      row.id,
      JSON.stringify({ ...config, capital: 99, liveConfirmed: false }),
    ])
    await expect(confirm(review.previewId!)).rejects.toThrow('STRATEGY_LIVE_PREVIEW_SUPERSEDED')
    review = await f.repo.livePreview(f.user, row.id, 60_000)
    await f.repo.kill(f.user)
    await expect(confirm(review.previewId!)).rejects.toThrow('STRATEGY_KILL_SWITCH')
    await f.repo.resetKill(f.user)
    ;(f.controller as { enabled: boolean }).enabled = false
    await expect(confirm(review.previewId!)).rejects.toThrow('STRATEGIES_LIVE_DISABLED')
    ;(f.controller as { enabled: boolean }).enabled = true
    review = await f.repo.livePreview(f.user, row.id, 60_000)
    vi.mocked(f.controller.admit).mockImplementationOnce(async () => {
      f.advance(15_001)
    })
    await expect(confirm(review.previewId!)).rejects.toThrow('STRATEGY_LIVE_PREVIEW_EXPIRED')
    expect((await f.repo.get(f.user, row.id))!.status).toBe('PAUSED')
    review = await f.repo.livePreview(f.user, row.id, 60_000)
    await confirm(review.previewId!)
    const order = randomUUID()
    await f.db.query(
      `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,simulated,status,side,price,size)
      VALUES($1,$2,'testnet',642,16,'POST',false,'OPEN','BUY',99,0.1)`,
      [order, row.id],
    )
    expect(await f.repo.pauseAll(f.user)).toBe(1)
    expect(await f.repo.get(f.user, row.id)).toMatchObject({ status: 'PAUSED', live_cleanup_pending: true })
    expect((await f.db.query('SELECT status FROM strategy_orders WHERE id=$1', [order])).rows[0].status).toBe('OPEN')
    expect(await f.repo.resumeAll(f.user)).toBe(0) // Telegram resume cannot bypass a new LIVE review.
    await expect(f.repo.livePreview(f.user, row.id, 60_000)).rejects.toThrow('STRATEGY_CLEANUP_PENDING')
    await f.repo.kill(f.user)
    expect((await f.db.query('SELECT status FROM strategy_orders WHERE id=$1', [order])).rows[0].status).toBe('OPEN')
  } finally {
    await f.db.close()
  }
}, 30_000)

it('authenticates LIVE review/confirmation routes and exposes cleanup and expiry without enabling generic start', async () => {
  const f = await fixture()
  const app = Fastify({ logger: false })
  try {
    registerStrategyRoutes({
      app,
      persistence: f.store,
      environment: 'testnet',
      liveController: f.controller,
      session: async (request) =>
        request.headers.authorization === 'owner'
          ? { userId: f.user }
          : request.headers.authorization === 'other'
            ? { userId: f.other }
            : null,
    })
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(Number((error as { statusCode?: number }).statusCode ?? 500))
        .send({ error: (error as Error).message }),
    )
    const owner = { authorization: 'owner' }
    const created = await app.inject({
      method: 'POST',
      url: '/strategies',
      headers: owner,
      payload: { connectionId: f.connection, config },
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().id
    expect(created.json().config.liveConfirmed).toBe(false)
    const url = `/strategies/${id}/live-preview`
    expect((await app.inject({ method: 'POST', url, payload: { maxRunMs: 60_000 } })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'POST', url, headers: { authorization: 'other' }, payload: { maxRunMs: 60_000 } }))
        .statusCode,
    ).toBe(404)
    const review = await app.inject({ method: 'POST', url, headers: owner, payload: { maxRunMs: 60_000 } })
    expect(review.statusCode).toBe(200)
    const confirmed = await app.inject({
      method: 'POST',
      url: `/strategies/${id}/live-confirm`,
      headers: owner,
      payload: { previewId: review.json().previewId, idempotencyKey: randomUUID(), acknowledgeRealOrders: true },
    })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json().status).toBe('RUNNING')
    const status = await app.inject({ method: 'GET', url: `/strategies/${id}/status`, headers: owner })
    expect(status.json()).toMatchObject({ liveEnabled: true, cleanupPending: false })
    expect(status.json().liveExpiresAt).toBeTruthy()
    await app.inject({ method: 'POST', url: `/strategies/${id}/pause`, headers: owner })
    expect((await app.inject({ method: 'GET', url: `/strategies/${id}/status`, headers: owner })).json()).toMatchObject(
      { status: 'PAUSED', cleanupPending: true },
    )
  } finally {
    await app.close()
    await f.db.close()
  }
}, 30_000)

it('reruns additive LIVE control migration while preserving PAPER rows and default INTERNAL origin', async () => {
  const f = await fixture()
  try {
    const paper = await f.repo.create(f.user, f.connection, { ...config, mode: 'PAPER' })
    await f.repo.start(f.user, paper.id)
    const sql = await readFile('database/migrations/039_strategy_live_controls.sql', 'utf8')
    await f.db.exec(sql)
    await f.db.exec(sql)
    expect(await f.repo.get(f.user, paper.id)).toMatchObject({
      mode: 'PAPER',
      status: 'RUNNING',
      live_cleanup_pending: false,
    })
    const order = (
      await f.db.query(
        `INSERT INTO strategy_orders(strategy_id,environment,account_id,market_id,kind,simulated,status,side,price,size)
      VALUES($1,'testnet',642,16,'POST',true,'OPEN','BUY',99,0.1) RETURNING execution_origin`,
        [paper.id],
      )
    ).rows[0]
    expect(order.execution_origin).toBe('INTERNAL')
  } finally {
    await f.db.close()
  }
}, 30_000)
