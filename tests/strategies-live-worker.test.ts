import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import { describe, expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { LiveStrategyWorker } from '../server/src/workers/live-strategy-worker.js'
import { StrategyStore } from '../server/src/infrastructure/strategies/store.js'
import { startLiveRisk, type LiveStrategySnapshot } from '../packages/strategies/src/live.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { PerplOrder } from '../packages/perpl/src/trading.js'
import type { StrategyConfig } from '../packages/strategies/src/index.js'

// These tests exercise scheduling, durable intents and risk transitions. A separate
// admission suite owns real authorization. This fake never connects to Perpl.
vi.mock('../server/src/application/live-strategy-admission.js', () => ({
  verifyLiveStrategySend: vi.fn(async () => undefined),
  releaseLiveStrategyCapital: vi.fn(async () => undefined),
}))

async function fixture() {
  const { db, store } = await databaseFixture()
  const now = Date.now(),
    user = await store.ensureUser('0x0000000000000000000000000000000000000047')
  const connection = randomUUID(),
    strategy = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
    VALUES($1,$2,'testnet','trade','fake','ACTIVE',now()+interval '1 day')`,
    [connection, user],
  )
  await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
    connection,
  ])
  await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',642,$1)", [user])
  const config: StrategyConfig = {
    kind: 'GRID',
    mode: 'LIVE',
    liveConfirmed: true,
    marketId: 16,
    accountId: 642,
    capital: 100,
    quoteSize: 0.1,
    maxNotional: 50,
    maxInventory: 1,
    maxOpenOrders: 4,
    maxDailyLoss: 5,
    maxDrawdownPct: 5,
    maxVolatility: 0.1,
    maxDataAgeMs: 5000,
    maxPriceBandBps: 1000,
    maxFundingRate: 0.1,
    leverage: 2,
    grid: { lower: 99, upper: 102, levels: 2 },
  }
  const snapshot: LiveStrategySnapshot = {
    environment: 'testnet',
    accountId: 642,
    marketId: 16,
    account: { balance: '100', locked: '0', lastRequestId: '44' },
    market: {
      environment: 'testnet',
      accountId: 642,
      marketId: 16,
      symbol: 'BTC',
      collateralAsset: 'AUSD',
      priceDecimals: 2,
      sizeDecimals: 2,
      collateralDecimals: 6,
      bidRaw: 10000,
      askRaw: 10100,
      markRaw: 10050,
      initialMarginBps: 1000,
      takerFeeMicros: 1000,
      minimumNotionalRaw: '1',
      recycleFeeRaw: '1',
      marketOpen: true,
      marketObservedAt: now,
      balanceObservedAt: now,
      balanceBlock: 100,
      freeBalance: '100',
      headBlock: 100,
      headObservedAt: now,
      marketBlock: 100,
      orderTtlBlocks: 20,
      priceTick: '0.01',
      sizeStep: '0.01',
      minimumSize: '0.01',
    },
    contractMarketId: 616,
    oracleRaw: 10050,
    volatility: '0.01',
    fundingRate: '0',
    makerFeeMicros: 0,
    funding: { sumRaw: '0', divisor: '1' },
    positions: [],
    orders: [],
    observedAt: now,
    headBlock: 100,
    epoch: 'fake-stream',
    sequence: 1,
    equity: '100',
    inventory: '0',
    positionCollateral: '0',
    depositTotal: '100',
    withdrawalTotal: '0',
    chainBlock: 100,
    chainHash: `0x${'a'.repeat(64)}`,
    chainFinalized: true,
  }
  await db.query(
    `INSERT INTO strategies(id,user_id,connection_id,environment,account_id,market_id,mode,kind,
    capital,config,state,status,live_confirmed_at,live_expires_at,live_state)
    VALUES($1,$2,$3,'testnet',642,16,'LIVE','GRID',100,$4,'{}','RUNNING',now(),$5,$6)`,
    [
      strategy,
      user,
      connection,
      JSON.stringify(config),
      new Date(now + 60_000),
      JSON.stringify(startLiveRisk(snapshot, now)),
    ],
  )
  let request = 44
  const wire: PerplOrder[] = []
  const submit = vi.fn(
    async (
      _id: string,
      order: PerplOrder,
      beforeSend: (reference: string, lb: number) => Promise<void>,
      verify?: () => Promise<void>,
    ) => {
      const reference = `642:${++request}`
      await beforeSend(reference, 120)
      await verify?.()
      wire.push(order)
      return { venueReference: reference, status: 'SUBMITTED' as const }
    },
  )
  const scoped = {
    accountId: 642,
    connectionId: connection,
    strategySnapshot: vi.fn(async () => snapshot),
    strategyAccountMutations: vi.fn(async () => []),
    submitStrategy: submit,
  } as unknown as RuntimeVenue
  const venues = { forUser: async () => scoped } as unknown as RuntimeVenue
  const options = { enabled: () => true, executionDisabled: () => false, leaseOwned: () => true }
  const worker = () =>
    new LiveStrategyWorker(store.pool, new StrategyStore(store.pool, 'testnet'), venues, 'testnet', options, () => now)
  const row = async () =>
    (
      await db.query<{ status: string; live_cleanup_pending: boolean; live_state: unknown }>(
        'SELECT status,live_cleanup_pending,live_state FROM strategies WHERE id=$1',
        [strategy],
      )
    ).rows[0]
  return { db, store, now, user, connection, strategy, config, snapshot, options, worker, row, wire, submit }
}

async function provePlacements(f: Awaited<ReturnType<typeof fixture>>) {
  const orders = (
    await f.db.query<{ id: string; request_id: string; wire_order: PerplOrder }>(
      'SELECT id,request_id::text,wire_order FROM strategy_orders WHERE strategy_id=$1 ORDER BY request_id',
      [f.strategy],
    )
  ).rows
  for (const [index, order] of orders.entries()) {
    const identity = {
      accountId: 642,
      marketId: 16,
      contractMarketId: 616,
      venueOrderId: 90075 + index,
      contractOrderId: 75 + index,
      placementRequestId: order.request_id,
      type: order.wire_order.t,
      creationBlock: 110,
      creationTransactionIndex: 0,
      creationTxHash: `0x${'a'.repeat(64)}`,
    }
    const admission = {
      accountId: 642,
      requestId: order.request_id,
      marketId: 616,
      type: order.wire_order.t,
      orderId: '0',
      sizeRaw: String(order.wire_order.s),
      priceRaw: String(order.wire_order.p),
      leverageHundredths: 200,
      postOnly: true,
      fillOrKill: false,
      immediateOrCancel: false,
      expiryBlock: String(order.wire_order.tif),
      amountRaw: '0',
      maxNegPnlCollatBps: '0',
      feePer100K: '0',
      lastExecutionBlock: 120,
      block: 110,
      txHash: identity.creationTxHash,
      requestLogIndex: 0,
      outcomeLogIndex: 1,
      outcome: 'PLACED',
      venueOrderId: identity.venueOrderId,
      contractOrderId: identity.contractOrderId,
      transactionIndex: 0,
      requestTransactionLogIndex: 0,
      outcomeTransactionLogIndex: 1,
      identity,
    }
    await f.db.query("UPDATE strategy_orders SET status='OPEN',venue_order_id=$2,venue_progress=$3 WHERE id=$1", [
      order.id,
      identity.venueOrderId,
      JSON.stringify({ strategyAdmission: admission }),
    ])
  }
  return orders
}

describe('live strategy worker', () => {
  it('persists real automation intents with zero collateralization before fake writes and never resends UNKNOWN', async () => {
    const f = await fixture()
    try {
      await f.worker().tick()
      expect(f.wire.map((order) => [order.t, order.fl, order.mnp])).toEqual([
        [1, 1, 0],
        [2, 1, 0],
      ])
      const intents = (
        await f.db.query<{ status: string; execution_origin: string; simulated: boolean }>(
          'SELECT status,execution_origin,simulated FROM strategy_orders WHERE strategy_id=$1',
          [f.strategy],
        )
      ).rows
      expect(intents).toHaveLength(2)
      for (const intent of intents)
        expect(intent).toMatchObject({ status: 'UNKNOWN', execution_origin: 'AUTOMATION', simulated: false })
      await f.worker().tick()
      expect(f.wire).toHaveLength(2)
      expect((await f.row()).status).toBe('RUNNING')
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('sends no quotes without runtime lease ownership', async () => {
    const f = await fixture()
    try {
      f.options.leaseOwned = () => false
      await f.worker().tick()
      expect(f.wire).toEqual([])
      expect((await f.db.query('SELECT * FROM strategy_orders')).rows).toEqual([])
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('halts on real equity loss and does not fill paper accounting or fabricate profitable results', async () => {
    const f = await fixture()
    try {
      f.snapshot.equity = '94.999999'
      await f.worker().tick()
      expect((await f.row()).status).toBe('HALTED')
      expect(f.wire).toEqual([])
      expect(
        (await f.db.query('SELECT code FROM strategy_risk_events WHERE strategy_id=$1', [f.strategy])).rows,
      ).toEqual(expect.arrayContaining([{ code: 'DAILY_LOSS' }, { code: 'RUN_LOSS' }]))
      expect((await f.db.query('SELECT * FROM strategy_fills')).rows).toEqual([])
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('expires approved run duration and preserves an existing position during order cleanup', async () => {
    const f = await fixture()
    try {
      await f.db.query('UPDATE strategies SET live_expires_at=$2 WHERE id=$1', [f.strategy, new Date(f.now - 1)])
      f.snapshot.positions.push({
        acc: 642,
        mkt: 16,
        pid: 55,
        st: 1,
        sd: 1,
        c: '1000000',
        ep: 10000,
        s: 10,
        lv: 200,
        at: { b: 100 },
        efs: 0,
        xfs: 0,
        fee: '0',
      })
      await f.worker().tick()
      expect(await f.row()).toMatchObject({ status: 'HALTED', live_cleanup_pending: false })
      expect(f.wire).toEqual([])
      expect((await f.db.query('SELECT code FROM strategy_risk_events')).rows).toContainEqual({ code: 'RUN_DURATION' })
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('refuses an external forwarded request before advancing the trusted risk cursor', async () => {
    const f = await fixture()
    try {
      f.snapshot.account.lastRequestId = '777'
      await f.worker().tick()
      expect((await f.row()).status).toBe('HALTED')
      expect((await f.row()).live_state).toMatchObject({ lastRequestId: '44' })
      expect(f.wire).toEqual([])
      expect((await f.db.query('SELECT code FROM strategy_risk_events')).rows).toContainEqual({
        code: 'STRATEGY_FOREIGN_ACCOUNT_REQUEST',
      })
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('cancels only proved owned quotes after disable and waits without replaying ambiguous cancellation', async () => {
    const f = await fixture()
    try {
      await f.worker().tick()
      await provePlacements(f)
      f.options.enabled = () => false
      await f.worker().tick()
      expect(f.wire.map((order) => order.t)).toEqual([1, 2, 5, 5])
      expect(f.wire.slice(2).map((order) => order.oid)).toEqual([90075, 90076])
      expect(await f.row()).toMatchObject({ status: 'HALTED', live_cleanup_pending: true })
      await f.worker().tick()
      expect(f.wire).toHaveLength(4)
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('retires a proved native-expired partial quote while preserving position and exact prior fill size', async () => {
    const f = await fixture()
    try {
      await f.worker().tick()
      const orders = await provePlacements(f)
      await f.db.query("UPDATE strategy_orders SET status='PARTIAL',filled_size=0.04 WHERE id=$1", [orders[0].id])
      f.snapshot.chainBlock = 121
      f.snapshot.headBlock = 121
      f.snapshot.positions.push({
        acc: 642,
        mkt: 16,
        pid: 55,
        rq: '45',
        st: 1,
        sd: 1,
        c: '1000000',
        ep: 9900,
        s: 4,
        lv: 200,
        at: { b: 115 },
        efs: 0,
        xfs: 0,
        fee: '0',
      })
      f.options.enabled = () => false
      await f.worker().tick()
      const row = (
        await f.db.query<{ status: string; filled_size: string }>(
          'SELECT status,filled_size::text FROM strategy_orders WHERE id=$1',
          [orders[0].id],
        )
      ).rows[0]
      expect(row.status).toBe('EXPIRED')
      expect(new Decimal(row.filled_size).eq('0.04')).toBe(true)
      expect(f.snapshot.positions).toHaveLength(1)
      expect(f.wire).toHaveLength(2)
      expect((await f.db.query('SELECT * FROM strategy_verified_fills')).rows).toEqual([])
    } finally {
      await f.db.close()
    }
  }, 30000)
})
