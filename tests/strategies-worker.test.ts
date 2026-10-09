import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { StrategyStore } from '../server/src/infrastructure/strategies/store.js'
import { StrategyWorker } from '../server/src/workers/strategy-worker.js'
import { initialState, type StrategyConfig, type StrategyTick } from '../packages/strategies/src/index.js'
import type { StrategyRecord } from '../server/src/infrastructure/strategies/store.js'

const config: StrategyConfig = {
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
  grid: { lower: 99, upper: 101, levels: 3 },
}

it('paper worker applies interval payment before simulated fills and never recharges after restart', async () => {
  let now = 10_500
  let row = {
    id: 'fixture',
    user_id: 'owner',
    market_id: 16,
    mode: 'PAPER',
    config,
    state: initialState(config, now),
  } as StrategyRecord
  const saved: number[] = []
  const fake = {
    running: async () => [row],
    killed: async () => false,
    savePaperTick: async (
      _row: unknown,
      state: StrategyRecord['state'],
      _cancel: unknown,
      _fills: unknown,
      _quotes: unknown,
      funding?: { amount: number },
    ) => {
      row = { ...row, state }
      if (funding) saved.push(funding.amount)
      return true
    },
  } as unknown as StrategyStore
  const funding = (feb: number, at: number) => ({
    at: { b: feb, t: at },
    feb,
    rate: 2,
    idx: 1000,
    ppl: 17,
    sum: 100 + feb,
    div: 1,
  })
  const feed = {
    sample: async () => ({
      tick: { at: now, bid: 99, ask: 101, mark: 100, oracle: 100, volatility: 0.01, fundingRate: 0.000002 },
      makerFeeMicros: 1000,
      depthNotional: 10000,
      fundingAt: now,
      funding: {
        marketId: 16,
        events: [funding(now < 11_000 ? 100 : 110, now < 11_000 ? 10_000 : 11_000)],
        head: { block: now < 11_000 ? 105 : 115, at: now },
        intervalBlocks: 10,
        priceDecimals: 1,
      },
    }),
  }
  await new StrategyWorker(
    fake,
    feed,
    () => now,
    () => false,
  ).tick()
  row = { ...row, state: { ...row.state, inventory: 0.2 } }
  now = 11_500
  await new StrategyWorker(
    fake,
    feed,
    () => now,
    () => false,
  ).tick()
  expect(row.state.fundingPaid).toBe(0.34)
  expect(saved).toEqual([0.34])
  row = JSON.parse(JSON.stringify(row))
  now = 11_600
  await new StrategyWorker(
    fake,
    feed,
    () => now,
    () => false,
  ).tick()
  expect(row.state.fundingPaid).toBe(0.34)
  expect(saved).toEqual([0.34])
})

it('paper worker checks freshness after an awaited feed instead of its earlier clock', async () => {
  let now = 10_500
  let state = initialState(config, now)
  const row = { id: 'fixture', user_id: 'owner', market_id: 16, mode: 'PAPER', config, state } as StrategyRecord
  const fake = {
    running: async () => [row],
    killed: async () => false,
    savePaperTick: async (_row: unknown, saved: StrategyRecord['state']) => {
      state = saved
      return true
    },
  } as unknown as StrategyStore
  const feed = {
    sample: async () => {
      const observed = now
      now += 3000
      return {
        tick: { at: observed, bid: 99, ask: 101, mark: 100, oracle: 100, volatility: 0.01, fundingRate: 0 },
        makerFeeMicros: 1000,
        depthNotional: 10000,
        funding: {
          marketId: 16,
          events: [{ at: { b: 100, t: 10_000 }, feb: 100, rate: 0, idx: 1000, ppl: 0, sum: 0, div: 1 }],
          head: { block: 105, at: now },
          intervalBlocks: 10,
          priceDecimals: 1,
        },
      }
    },
  }
  await new StrategyWorker(
    fake,
    feed,
    () => now,
    () => false,
  ).tick()
  expect(state.status).toBe('HALTED')
  expect(state.riskEvents).toContain('STALE_DATA')
  expect(state.openOrders).toEqual([])
})

it('paper worker persists simulated fills, then halts and clears quotes on kill', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000066')
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
    const repo = new StrategyStore(store.pool, 'testnet')
    const created = await repo.create(user, connection, config)
    await repo.start(user, created.id)
    let now = Date.now()
    const firstAt = now
    const funding = () => ({
      marketId: 16,
      events: [{ at: { b: 100, t: firstAt }, feb: 100, rate: 0, idx: 1000, ppl: 0, sum: 0, div: 1 }],
      head: { block: 105, at: now },
      intervalBlocks: 10,
      priceDecimals: 1,
    })
    const tick = (mark: number, bid: number, ask: number): StrategyTick => ({
      at: now,
      mark,
      oracle: mark,
      bid,
      ask,
      volatility: 0.01,
      fundingRate: 0,
    })
    let sample = { tick: tick(100, 99, 101), makerFeeMicros: 1000, depthNotional: 10000, funding: funding() }
    const worker = new StrategyWorker(
      repo,
      { sample: async () => sample },
      () => now,
      () => false,
    )
    await worker.tick()
    expect((await repo.get(user, created.id))!.state.openOrders.length).toBe(2)
    expect((await repo.orders(user, created.id)).every((row) => row.simulated === true)).toBe(true)
    now += 1000
    sample = { tick: tick(101.5, 101.2, 101.8), makerFeeMicros: 1000, depthNotional: 10000, funding: funding() }
    await worker.tick()
    expect(await repo.fills(user, created.id)).toHaveLength(1)
    expect((await repo.fills(user, created.id))[0]?.simulated).toBe(true)
    now += 1000
    sample = {
      tick: tick(100, 99, 101),
      makerFeeMicros: 1000,
      depthNotional: 10000,
      funding: {
        marketId: 16,
        events: [{ at: { b: 110, t: now - 500 }, feb: 110, rate: 2, idx: 1000, ppl: 17, sum: 17, div: 1 }],
        head: { block: 115, at: now },
        intervalBlocks: 10,
        priceDecimals: 1,
      },
    }
    await worker.tick()
    expect((await repo.get(user, created.id))!.state.fundingPaid).toBe(-0.17)
    expect((await repo.get(user, created.id))!.state.paperFundingCursor?.feb).toBe(110)
    await new StrategyWorker(
      repo,
      { sample: async () => sample },
      () => now,
      () => false,
    ).tick()
    expect((await repo.get(user, created.id))!.state.fundingPaid).toBe(-0.17)
    const payments = await db.query('SELECT amount FROM strategy_funding WHERE strategy_id=$1', [created.id])
    expect(payments.rows).toHaveLength(1)
    expect(Number(payments.rows[0]!.amount)).toBe(-0.17)
    await worker.close()
    expect((await repo.get(user, created.id))!.state.openOrders).toEqual([])
    expect((await repo.orders(user, created.id)).some((row) => row.status === 'OPEN')).toBe(false)
    await worker.tick()
    expect((await repo.get(user, created.id))!.state.openOrders.length).toBeGreaterThan(0)
    await repo.kill(user)
    await worker.tick()
    expect((await repo.get(user, created.id))!.status).toBe('HALTED')
    expect((await repo.orders(user, created.id)).some((row) => row.status === 'OPEN')).toBe(false)
  } finally {
    await db.close()
  }
}, 30_000)
