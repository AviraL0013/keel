import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { liveFixture } from './helpers/live-strategy.js'
import {
  LiveStrategyAdmission,
  verifyLiveStrategySend,
  releaseLiveStrategyCapital,
} from '../server/src/application/live-strategy-admission.js'
import { StrategyStore } from '../server/src/infrastructure/strategies/store.js'
import { StrategyOrders } from '../server/src/application/strategy-orders.js'
import { LiveStrategyWorker } from '../server/src/workers/live-strategy-worker.js'
import { assertAccountCapitalCoverage } from '../server/src/infrastructure/capital/admission.js'
import { StrategyCapital } from '../server/src/infrastructure/strategies/capital.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { PerplOrder } from '../packages/perpl/src/trading.js'

async function fixture() {
  const { db, store } = await databaseFixture()
  const data = liveFixture(),
    user = await store.ensureUser('0x00000000000000000000000000000000000000b7')
  const connection = randomUUID(),
    clock = { value: data.now }
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
    VALUES($1,$2,'testnet','trade','fake','ACTIVE',now()+interval '1 day')`,
    [connection, user],
  )
  await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
    connection,
  ])
  await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',642,$1)", [user])
  const options = { enabled: () => true, executionDisabled: () => false, leaseOwned: () => true }
  const mutations: Array<{ et: number; at: { b?: number }; r?: string }> = []
  let onSnapshot = async () => undefined
  let request = 44
  const wire: PerplOrder[] = []
  const scoped = {
    accountId: 642,
    connectionId: connection,
    ready: () => true,
    strategySnapshot: vi.fn(async () => {
      await onSnapshot()
      return data.snapshot
    }),
    strategyAccountMutations: vi.fn(async () => mutations),
    submitStrategy: vi.fn(
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
    ),
  } as unknown as RuntimeVenue
  const venues = { forUser: async () => scoped } as unknown as RuntimeVenue
  const controller = new LiveStrategyAdmission(store.pool, venues, 'testnet', options, () => clock.value)
  const strategies = new StrategyStore(store.pool, 'testnet', controller, () => clock.value)
  const draft = await strategies.create(user, connection, { ...data.config, liveConfirmed: false })
  const approve = async () => {
    const preview = await strategies.livePreview(user, draft.id, 60_000)
    expect(preview.ready).toBe(true)
    return strategies.confirmLive(user, draft.id, {
      previewId: preview.previewId!,
      idempotencyKey: randomUUID(),
      acknowledgeRealOrders: true,
    })
  }
  const service = () => {
    const admission = (intent: Parameters<typeof verifyLiveStrategySend>[3]) =>
      verifyLiveStrategySend(store.pool, venues, 'testnet', intent, options, () => clock.value)
    return new StrategyOrders(
      store,
      venues,
      'testnet',
      {
        enabled: true,
        liveEnabled: true,
        executionDisabled: false,
        accountMode: 'per-user',
      },
      admission,
      admission,
    )
  }
  const input = () => ({
    idempotencyKey: randomUUID(),
    origin: 'AUTOMATION' as const,
    order: { acc: 642, mkt: 16, t: 1, p: 9900, s: 10, lv: 200, fl: 1 as const, mnp: 0, tif: 120, orderTtlBlocks: 20 },
    marketTerms: { contractMarketId: 616, priceDecimals: 2, sizeDecimals: 2 },
  })
  return {
    db,
    store,
    data,
    user,
    connection,
    draft,
    options,
    clock,
    mutations,
    wire,
    scoped,
    venues,
    strategies,
    approve,
    service,
    input,
    snapshotHook: (hook: () => Promise<undefined>) => {
      onSnapshot = hook
    },
  }
}

it('runs the reviewed controller and real admission path before fake automation writes', async () => {
  const f = await fixture()
  try {
    expect(f.draft).toMatchObject({ mode: 'LIVE', status: 'PAUSED', live_confirmed_at: null })
    const confirmed = await f.approve()
    expect(confirmed.status).toBe('RUNNING')
    expect((await f.db.query('SELECT status,amount::text FROM strategy_capital_allocations')).rows).toEqual([
      { status: 'HELD', amount: '100.000000' },
    ])
    const worker = new LiveStrategyWorker(
      f.store.pool,
      f.strategies,
      f.venues,
      'testnet',
      f.options,
      () => f.clock.value,
    )
    await worker.tick()
    expect(f.wire.map((order) => [order.t, order.fl, order.mnp])).toEqual([
      [1, 1, 0],
      [2, 1, 0],
    ])
    expect(
      (
        await f.db.query<{ execution_origin: string; simulated: boolean }>(
          'SELECT execution_origin,simulated FROM strategy_orders WHERE strategy_id=$1',
          [f.draft.id],
        )
      ).rows,
    ).toEqual([
      { execution_origin: 'AUTOMATION', simulated: false },
      { execution_origin: 'AUTOMATION', simulated: false },
    ])
    await worker.tick()
    expect(f.wire).toHaveLength(2)
  } finally {
    await f.db.close()
  }
}, 30000)

it('prepares venue authority before acquiring a finite pool transaction and reuses its client for guarded reads', async () => {
  const f = await fixture()
  try {
    let inTransaction = false
    const connect = f.store.pool.connect.bind(f.store.pool)
    vi.spyOn(f.store.pool, 'connect').mockImplementation(async () => {
      const client = await connect()
      const query = client.query.bind(client)
      client.query = (async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN') inTransaction = true
        const result = await query(sql, values)
        if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false
        return result
      }) as typeof client.query
      return client
    })
    f.venues.forUser = async () => {
      if (inTransaction) throw Error('NESTED_POOL_LOOKUP')
      return f.scoped
    }
    f.scoped.strategySnapshot = vi.fn(async (_market, transaction) => {
      if (inTransaction && !transaction) throw Error('TRANSACTION_CLIENT_REQUIRED')
      return f.data.snapshot
    })
    f.scoped.strategyAccountMutations = vi.fn(async (_block, transaction) => {
      if (inTransaction && !transaction) throw Error('TRANSACTION_CLIENT_REQUIRED')
      return []
    })
    await f.approve()
    const result = await f.service().submit(f.user, f.draft.id, f.input())
    expect(result.status).toBe('UNKNOWN')
    expect(f.wire).toHaveLength(1)
    expect(inTransaction).toBe(false)
  } finally {
    vi.restoreAllMocks()
    await f.db.close()
  }
}, 30000)

it('uses the clock after awaited market observations and never halts a successor after losing the lease', async () => {
  const f = await fixture()
  try {
    await f.approve()
    f.snapshotHook(async () => {
      f.clock.value += 100
      f.data.snapshot.observedAt = f.clock.value
      for (const key of ['marketObservedAt', 'headObservedAt', 'balanceObservedAt'] as const)
        f.data.snapshot.market[key] = f.clock.value
      return undefined
    })
    const worker = new LiveStrategyWorker(
      f.store.pool,
      f.strategies,
      f.venues,
      'testnet',
      f.options,
      () => f.clock.value,
    )
    await worker.tick()
    expect(f.wire).toHaveLength(2)
    expect((await f.strategies.get(f.user, f.draft.id))!.status).toBe('RUNNING')
    f.snapshotHook(async () => {
      f.options.leaseOwned = () => false
      throw Error('CONNECTION_CLOSED_DURING_HANDOVER')
    })
    await worker.tick()
    expect((await f.strategies.get(f.user, f.draft.id))!.status).toBe('RUNNING')
    expect(
      (
        await f.db.query(
          "SELECT * FROM strategy_risk_events WHERE strategy_id=$1 AND code='CONNECTION_CLOSED_DURING_HANDOVER'",
          [f.draft.id],
        )
      ).rows,
    ).toEqual([])
  } finally {
    await f.db.close()
  }
}, 30000)

it.each(['mutation', 'lease', 'disabled'] as const)(
  'blocks %s immediately before dispatch without a fake write',
  async (kind) => {
    const f = await fixture()
    try {
      await f.approve()
      if (kind === 'mutation') f.mutations.push({ et: 3, at: { b: 101 }, r: '777' })
      if (kind === 'lease') f.options.leaseOwned = () => false
      if (kind === 'disabled') f.options.executionDisabled = () => true
      const result = await f.service().submit(f.user, f.draft.id, f.input())
      expect(result).toMatchObject({ status: 'FAILED', request_id: null })
      expect(f.wire).toEqual([])
      expect(f.scoped.submitStrategy as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    } finally {
      await f.db.close()
    }
  },
  30000,
)

it('rejects approved run expiry after an awaited snapshot without dispatching', async () => {
  const f = await fixture()
  try {
    await f.approve()
    f.snapshotHook(async () => {
      f.clock.value += 60_001
      f.data.snapshot.observedAt = f.clock.value
      for (const key of ['marketObservedAt', 'headObservedAt', 'balanceObservedAt'] as const)
        f.data.snapshot.market[key] = f.clock.value
      return undefined
    })
    const result = await f.service().submit(f.user, f.draft.id, f.input())
    expect(result).toMatchObject({ status: 'FAILED', request_id: null, error: 'STRATEGY_RUN_EXPIRED' })
    expect(f.wire).toEqual([])
  } finally {
    await f.db.close()
  }
}, 30000)

it('holds the dedicated account against subsequent Book or opening capital admission', async () => {
  const f = await fixture()
  try {
    await f.approve()
    const client = await f.store.pool.connect()
    try {
      await expect(
        assertAccountCapitalCoverage(
          client,
          { environment: 'testnet', account_id: '642', user_id: f.user },
          {
            environment: 'testnet',
            accountId: 642,
            free: '1000.000000',
            observedAt: f.clock.value,
            observedBlock: 100,
          },
          '1.000000',
          undefined,
          f.clock.value,
        ),
      ).rejects.toThrow('STRATEGY_ACCOUNT_EXCLUSIVE')
    } finally {
      client.release()
    }
  } finally {
    await f.db.close()
  }
}, 30000)

it('does not reserve money for unapproved drafts, but claims full capital during confirmation', async () => {
  const f = await fixture()
  try {
    const unused = await f.strategies.create(f.user, f.connection, { ...f.data.config, liveConfirmed: false })
    expect((await f.strategies.stop(f.user, unused.id)).live_cleanup_pending).toBe(false)
    const client = await f.store.pool.connect()
    try {
      expect(
        await assertAccountCapitalCoverage(
          client,
          { environment: 'testnet', account_id: '642', user_id: f.user },
          { environment: 'testnet', accountId: 642, free: '100.000000', observedAt: f.clock.value, observedBlock: 100 },
          '1.000000',
          undefined,
          f.clock.value,
        ),
      ).toBe('99.000000')
    } finally {
      client.release()
    }
    await f.approve()
    expect((await f.db.query('SELECT amount::text,status FROM strategy_capital_allocations')).rows).toEqual([
      { amount: '100.000000', status: 'HELD' },
    ])
  } finally {
    await f.db.close()
  }
}, 30000)

it('keeps the existing capital allocator from overfunding an unapproved draft', async () => {
  const f = await fixture()
  try {
    const capital = new StrategyCapital(
      f.store.pool,
      'testnet',
      async () => ({
        environment: 'testnet',
        accountId: 642,
        free: '50.000000',
        observedAt: Date.now(),
        observedBlock: 100,
      }),
      async () => {
        throw Error('NO_ORDER_COST_REQUESTED')
      },
    )
    await expect(capital.allocate(f.user, f.draft.id)).rejects.toThrow('STRATEGY_WOULD_UNDERFUND_BOOK_RESERVES')
    expect((await f.db.query('SELECT * FROM strategy_capital_allocations')).rows).toEqual([])
  } finally {
    await f.db.close()
  }
}, 30000)

it('retains stopped capital through execution deadline and any position, then releases a flat account', async () => {
  const f = await fixture()
  try {
    await f.approve()
    const sent = await f.service().submit(f.user, f.draft.id, f.input())
    // A fake proven-negative recovery fixture. No receipt or real execution is invented.
    await f.db.query("UPDATE strategy_orders SET status='FAILED',error='PERPL_ORDER_WINDOW_EXPIRED' WHERE id=$1", [
      sent.id,
    ])
    const stopped = await f.strategies.stop(f.user, f.draft.id)
    await releaseLiveStrategyCapital(f.store.pool, f.venues, stopped, f.options.leaseOwned)
    const allocation = async () =>
      (
        await f.db.query<{ status: string; available: string; reserved: string }>(
          'SELECT status,available::text,reserved::text FROM strategy_capital_allocations WHERE strategy_id=$1',
          [f.draft.id],
        )
      ).rows[0]
    expect((await allocation()).status).toBe('HELD')
    f.data.snapshot.chainBlock = 121
    f.data.snapshot.headBlock = 121
    f.data.snapshot.positions.push({
      acc: 642,
      mkt: 16,
      pid: 55,
      st: 1,
      sd: 1,
      c: '1000000',
      ep: 10000,
      s: 10,
      lv: 200,
      at: { b: 120 },
      efs: 0,
      xfs: 0,
      fee: '0',
    })
    await releaseLiveStrategyCapital(f.store.pool, f.venues, stopped, f.options.leaseOwned)
    expect((await allocation()).status).toBe('HELD')
    f.data.snapshot.positions = []
    f.data.snapshot.chainFinalized = false
    await releaseLiveStrategyCapital(f.store.pool, f.venues, stopped, f.options.leaseOwned)
    expect((await allocation()).status).toBe('HELD')
    f.data.snapshot.chainFinalized = true
    await releaseLiveStrategyCapital(f.store.pool, f.venues, stopped, f.options.leaseOwned)
    expect(await allocation()).toEqual({ status: 'RELEASED', available: '0.000000', reserved: '0.000000' })
  } finally {
    await f.db.close()
  }
}, 30000)
