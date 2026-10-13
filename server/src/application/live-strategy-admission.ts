import type { Pool, PoolClient } from 'pg'
import Decimal from 'decimal.js'
import { planLiveStrategy, startLiveRisk, type LiveStrategySnapshot } from '../../../packages/strategies/src/live.js'
import {
  strategyLiveConsentHash,
  type StrategyRecord,
  type StrategyLiveController,
} from '../infrastructure/strategies/store.js'
import { assertAccountCapitalCoverage, withAccountCapital } from '../infrastructure/capital/admission.js'
import type { RuntimeVenue } from '../runtime.js'
import type { StrategyOrderRecord } from './strategy-orders.js'
import type { LiveStrategyWorkerOptions } from '../workers/live-strategy-worker.js'

const Exact = Decimal.clone({ precision: 160 })
type Transaction = Pick<PoolClient, 'query'>
const active = ['QUEUED', 'SUBMITTING', 'UNKNOWN', 'OPEN', 'PARTIAL']
async function exclusive(transaction: Transaction, row: StrategyRecord) {
  const claims = await transaction.query(
    `SELECT 1 FROM books b LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id
     WHERE b.venue_account_id=$1 AND (c.environment=$2 OR c.id IS NULL) AND (b.status<>'CLOSED'
       OR EXISTS(SELECT 1 FROM actions a WHERE a.book_id=b.id AND a.status IN
         ('QUEUED','VALIDATING','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN','PARTIAL')))
     UNION ALL SELECT 1 FROM opening_orders WHERE account_id=$1 AND environment=$2
       AND status IN ('QUEUED','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN')
     UNION ALL SELECT 1 FROM strategies s LEFT JOIN strategy_capital_allocations a ON a.strategy_id=s.id
       WHERE s.account_id=$1 AND s.environment=$2 AND s.mode='LIVE' AND s.id<>$3
       AND (s.status='RUNNING' OR s.live_cleanup_pending=true OR a.status='HELD') LIMIT 1`,
    [row.account_id, row.environment, row.id],
  )
  if (claims.rows.length) throw Error('STRATEGY_DEDICATED_ACCOUNT_REQUIRED')
}
async function resolveVenue(venues: RuntimeVenue | undefined, row: StrategyRecord) {
  const venue = await venues?.forUser?.(row.user_id, row.connection_id)
  if (
    !venue?.ready() ||
    venue.accountId !== Number(row.account_id) ||
    venue.connectionId !== row.connection_id ||
    !venue.strategySnapshot
  )
    throw Error('STRATEGY_CONNECTION_UNAVAILABLE')
  return venue
}
async function snapshot(
  venues: RuntimeVenue | undefined,
  row: StrategyRecord,
  transaction?: Transaction,
  prepared?: RuntimeVenue,
) {
  const venue = prepared ?? (await resolveVenue(venues, row))
  if (
    !venue.ready() ||
    venue.accountId !== Number(row.account_id) ||
    venue.connectionId !== row.connection_id ||
    !venue.strategySnapshot
  )
    throw Error('STRATEGY_CONNECTION_UNAVAILABLE')
  return { venue, value: await venue.strategySnapshot(row.market_id, transaction) }
}
function optionsReady(options: LiveStrategyWorkerOptions) {
  if (!options.enabled() || options.executionDisabled() || !options.leaseOwned())
    throw Error('STRATEGIES_LIVE_DISABLED')
}
function proposal(row: StrategyRecord, value: LiveStrategySnapshot, now: number) {
  const state = startLiveRisk(value, now)
  const plan = planLiveStrategy({ ...row.config, liveConfirmed: true }, value, state, now)
  if (plan.risk.length) throw Error(plan.risk[0])
  return state
}
export class LiveStrategyAdmission implements StrategyLiveController {
  constructor(
    private readonly pool: Pool,
    private readonly venues: RuntimeVenue | undefined,
    private readonly environment: 'mainnet' | 'testnet',
    private readonly options: LiveStrategyWorkerOptions,
    private readonly now: () => number = Date.now,
  ) {}
  get enabled() {
    return this.options.enabled() && !this.options.executionDisabled() && this.options.leaseOwned()
  }
  async prepare(userId: string, row: StrategyRecord) {
    if (row.user_id !== userId || row.environment !== this.environment) throw Error('STRATEGY_BINDING_CHANGED')
    return resolveVenue(this.venues, row)
  }
  async review(userId: string, row: StrategyRecord, _maxRunMs: number) {
    try {
      optionsReady(this.options)
      if (row.user_id !== userId || row.environment !== this.environment) throw Error('STRATEGY_BINDING_CHANGED')
      await exclusive(this.pool, row)
      const { value } = await snapshot(this.venues, row)
      if (value.orders.length || value.positions.length || new Exact(value.account.locked).gt(0))
        throw Error('STRATEGY_EMPTY_ACCOUNT_REQUIRED')
      proposal(row, value, this.now())
      if (new Exact(value.market.freeBalance).lt(row.capital)) throw Error('STRATEGY_CAPITAL_INSUFFICIENT')
      const unresolved = await this.pool.query(
        `SELECT 1 FROM strategy_orders WHERE strategy_id=$1 AND simulated=false AND status=ANY($2::text[]) LIMIT 1`,
        [row.id, active],
      )
      if (unresolved.rows.length || row.live_cleanup_pending) throw Error('STRATEGY_CLEANUP_PENDING')
      return {
        ready: true,
        reasons: [],
        snapshot: {
          accountId: value.accountId,
          marketId: value.marketId,
          freeBalance: value.market.freeBalance,
          equity: value.equity,
          block: value.chainBlock,
          dedicatedAccountRequired: true,
          positionsOnPause: 'RETAINED',
          profitability: 'UNPROVEN',
        },
      }
    } catch (error) {
      return { ready: false, reasons: [error instanceof Error ? error.message : 'STRATEGY_LIVE_UNAVAILABLE'] }
    }
  }
  async admit(
    userId: string,
    row: StrategyRecord,
    transaction: PoolClient,
    approval: { configHash: string; maxRunMs: number },
    prepared?: unknown,
  ) {
    optionsReady(this.options)
    if (
      row.user_id !== userId ||
      row.environment !== this.environment ||
      strategyLiveConsentHash(row, approval.maxRunMs) !== approval.configHash
    )
      throw Error('STRATEGY_BINDING_CHANGED')
    await exclusive(transaction, row)
    if (!prepared) throw Error('STRATEGY_CONNECTION_PREPARATION_REQUIRED')
    const { value } = await snapshot(this.venues, row, transaction, prepared as RuntimeVenue)
    if (value.orders.length || value.positions.length || new Exact(value.account.locked).gt(0))
      throw Error('STRATEGY_EMPTY_ACCOUNT_REQUIRED')
    const unresolved = await transaction.query(
      `SELECT 1 FROM strategy_orders WHERE strategy_id=$1 AND simulated=false AND status=ANY($2::text[]) LIMIT 1`,
      [row.id, active],
    )
    if (unresolved.rows.length || row.live_cleanup_pending) throw Error('STRATEGY_CLEANUP_PENDING')
    const state = proposal(row, value, this.now())
    const allocation = (
      await transaction.query<{ status: string; amount: string }>(
        'SELECT status,amount::text FROM strategy_capital_allocations WHERE strategy_id=$1 FOR UPDATE',
        [row.id],
      )
    ).rows[0]
    const unallocatedDraft = !allocation && row.live_confirmed_at === null && row.config.liveConfirmed === false
    const additional =
      unallocatedDraft || allocation?.status === 'RELEASED'
        ? new Exact(row.capital)
        : allocation?.status === 'HELD'
          ? Exact.max(0, new Exact(row.capital).minus(allocation.amount))
          : new Exact(0)
    // An unapproved draft has no promise. Confirmation claims its full capital here.
    await assertAccountCapitalCoverage(
      transaction,
      { environment: row.environment, account_id: row.account_id, user_id: userId },
      {
        environment: row.environment,
        accountId: value.accountId,
        free: value.market.freeBalance,
        observedAt: value.observedAt,
        observedBlock: value.chainBlock,
      },
      additional.toFixed(6),
      undefined,
      this.now(),
      row.id,
    )
    await transaction.query(
      `INSERT INTO strategy_capital_allocations(strategy_id,environment,account_id,market_id,amount,available,reserved,status)
       VALUES($1,$2,$3,$4,$5,$5,0,'HELD') ON CONFLICT(strategy_id) DO UPDATE SET
       amount=EXCLUDED.amount,available=EXCLUDED.amount,reserved=0,status='HELD',updated_at=now()`,
      [row.id, row.environment, row.account_id, row.market_id, row.capital],
    )
    await transaction.query('UPDATE strategies SET live_state=$2 WHERE id=$1', [row.id, JSON.stringify(state)])
    optionsReady(this.options)
  }
}

/** Release a stopped claim only after its last execution window and a complete flat account view. */
export async function releaseLiveStrategyCapital(
  pool: Pool,
  venues: RuntimeVenue | undefined,
  row: StrategyRecord,
  leaseOwned: () => boolean,
) {
  if (!leaseOwned()) return
  const prepared = await resolveVenue(venues, row)
  await withAccountCapital(
    pool,
    {
      userId: row.user_id,
      connectionId: row.connection_id,
      accountId: Number(row.account_id),
      environment: row.environment,
    },
    async (client) => {
      const current = (await client.query<StrategyRecord>('SELECT * FROM strategies WHERE id=$1 FOR UPDATE', [row.id]))
        .rows[0]
      if (!current || !['STOPPED', 'HALTED'].includes(current.status)) return
      const unresolved = await client.query(
        `SELECT 1 FROM strategy_orders WHERE strategy_id=$1 AND simulated=false
      AND status=ANY($2::text[]) LIMIT 1`,
        [row.id, active],
      )
      if (unresolved.rows.length) return
      const { value } = await snapshot(venues, current, client, prepared)
      if (
        !value.chainFinalized ||
        value.orders.length ||
        value.positions.length ||
        new Exact(value.account.locked).gt(0)
      )
        return
      const barrier = (
        await client.query<{ block: string | null }>(
          'SELECT max(last_execution_block)::text AS block FROM strategy_orders WHERE strategy_id=$1 AND simulated=false',
          [row.id],
        )
      ).rows[0]?.block
      if (barrier && BigInt(barrier) >= BigInt(value.chainBlock)) return
      if (!leaseOwned()) return
      await client.query(
        `UPDATE strategy_capital_allocations SET status='RELEASED',available=0,reserved=0,updated_at=now()
      WHERE strategy_id=$1 AND status='HELD'`,
        [row.id],
      )
    },
  )
}

/** Fresh account and durable claims are checked under the same lock as Book/opening admission. */
export async function verifyLiveStrategySend(
  pool: Pool,
  venues: RuntimeVenue | undefined,
  environment: 'mainnet' | 'testnet',
  intent: StrategyOrderRecord,
  options: LiveStrategyWorkerOptions,
  now: () => number = Date.now,
): Promise<void> {
  if (!options.leaseOwned()) throw Error('STRATEGY_LEASE_LOST')
  if (intent.kind === 'CANCEL') return // StrategyOrders separately proves the owned placement and active connection.
  optionsReady(options)
  const row = (
    await pool.query<StrategyRecord>('SELECT * FROM strategies WHERE id=$1 AND environment=$2', [
      intent.strategy_id,
      environment,
    ])
  ).rows[0]
  if (!row) throw Error('STRATEGY_NOT_FOUND')
  const prepared = await resolveVenue(venues, row)
  await withAccountCapital(
    pool,
    { userId: row.user_id, connectionId: row.connection_id, accountId: Number(row.account_id), environment },
    async (client) => {
      const current = (await client.query<StrategyRecord>('SELECT * FROM strategies WHERE id=$1 FOR UPDATE', [row.id]))
        .rows[0]
      if (
        !current ||
        current.mode !== 'LIVE' ||
        current.status !== 'RUNNING' ||
        current.live_cleanup_pending ||
        !current.live_state ||
        !current.live_expires_at ||
        Date.parse(current.live_expires_at) <= now() ||
        !current.live_max_run_ms ||
        current.live_consent_hash !== strategyLiveConsentHash(current, Number(current.live_max_run_ms))
      )
        throw Error('STRATEGY_LIVE_CONSENT_REQUIRED')
      if (
        (await client.query('SELECT 1 FROM strategy_user_controls WHERE user_id=$1 AND killed=true', [current.user_id]))
          .rows.length
      )
        throw Error('KILL_SWITCH')
      await exclusive(client, current)
      const allocation = (
        await client.query<{ amount: string; status: string }>(
          'SELECT amount::text,status FROM strategy_capital_allocations WHERE strategy_id=$1 FOR UPDATE',
          [current.id],
        )
      ).rows[0]
      if (!allocation || allocation.status !== 'HELD' || !new Exact(allocation.amount).eq(current.capital))
        throw Error('STRATEGY_CAPITAL_CHANGED')
      const { value, venue } = await snapshot(venues, current, client, prepared)
      const plan = planLiveStrategy(current.config, value, current.live_state, now())
      if (plan.risk.length) throw Error(plan.risk[0])
      if (
        !Number.isSafeInteger(intent.wire_order.tif) ||
        intent.wire_order.tif! <= value.headBlock ||
        intent.wire_order.tif! > value.headBlock + value.market.orderTtlBlocks
      )
        throw Error('STRATEGY_ORDER_EXPIRED')
      if (!venue.strategyAccountMutations) throw Error('STRATEGY_ACCOUNT_HISTORY_REQUIRED')
      const mutations = await venue.strategyAccountMutations(current.live_state.lastBlock, client)
      const ownedRequests = new Set(
        (
          await client.query<{ request_id: string }>(
            'SELECT request_id::text FROM strategy_orders WHERE strategy_id=$1 AND environment=$2 AND simulated=false AND request_id IS NOT NULL',
            [current.id, environment],
          )
        ).rows.map((order) => order.request_id),
      )
      if (
        mutations.some(
          (event) =>
            !Number.isSafeInteger(event.at.b) ||
            (event.at.b! >= current.live_state!.lastBlock &&
              (!Number.isSafeInteger(event.et) ||
                ![4, 5, 8, 9, 10].includes(event.et) ||
                (event.et === 4 && !ownedRequests.has(String(event.r))))),
        )
      )
        throw Error('STRATEGY_FOREIGN_ACCOUNT_MUTATION')
      const orders = (
        await client.query<StrategyOrderRecord>(
          `SELECT * FROM strategy_orders WHERE strategy_id=$1 AND environment=$2 AND simulated=false AND kind='POST'
         AND status=ANY($3::text[]) FOR UPDATE`,
          [current.id, environment, active],
        )
      ).rows
      if (!orders.some((order) => order.id === intent.id) || orders.length > current.config.maxOpenOrders)
        throw Error('OPEN_ORDERS')
      const allowedRequests = ownedRequests
      if (
        BigInt(value.account.lastRequestId) > BigInt(current.live_state.lastRequestId) &&
        !allowedRequests.has(value.account.lastRequestId)
      )
        throw Error('STRATEGY_FOREIGN_ACCOUNT_REQUEST')
      if (value.orders.some((order) => !allowedRequests.has(String(order.rq))))
        throw Error('STRATEGY_FOREIGN_ACCOUNT_ORDER')
      if (value.positions.some((position) => position.rq === undefined || !ownedRequests.has(String(position.rq))))
        throw Error('STRATEGY_FOREIGN_ACCOUNT_POSITION')
      let buys = new Exact(0),
        sells = new Exact(0),
        needed = new Exact(0)
      const priceScale = new Exact(10).pow(value.market.priceDecimals),
        sizeScale = new Exact(10).pow(value.market.sizeDecimals)
      for (const order of orders) {
        const wire = order.wire_order
        if (
          ![1, 2].includes(wire.t) ||
          wire.mnp !== 0 ||
          wire.fl !== 1 ||
          !Number.isSafeInteger(wire.p) ||
          wire.p! <= 0 ||
          !Number.isSafeInteger(wire.s) ||
          wire.s <= 0 ||
          order.market_terms.priceDecimals !== value.market.priceDecimals ||
          order.market_terms.sizeDecimals !== value.market.sizeDecimals ||
          order.market_terms.contractMarketId !== value.contractMarketId ||
          !new Exact(wire.lv).eq(new Exact(String(current.config.leverage)).mul(100))
        )
          throw Error('STRATEGY_INTENT_CHANGED')
        const live = value.orders.find((item) => String(item.rq) === String(order.request_id))
        const size = new Exact(live ? Math.max(0, live.os - live.fs) : wire.s).div(sizeScale)
        const price = new Exact(wire.p!).div(priceScale)
        if (order.id === intent.id && (wire.t === 1 ? wire.p! > value.market.bidRaw : wire.p! < value.market.askRaw))
          throw Error('PRICE_BAND')
        const oracle = new Exact(value.oracleRaw).div(priceScale)
        if (
          price
            .minus(oracle)
            .abs()
            .mul(10000)
            .gt(oracle.mul(String(current.config.maxPriceBandBps)))
        )
          throw Error('PRICE_BAND')
        if (
          order.id === intent.id &&
          price.mul(size).mul(new Exact(10).pow(value.market.collateralDecimals)).lt(value.market.minimumNotionalRaw)
        )
          throw Error('STRATEGY_MINIMUM_NOTIONAL')
        if (new Exact(wire.s).gt(new Exact(String(current.config.quoteSize)).mul(sizeScale).floor()))
          throw Error('SIZE_PRECISION')
        if (wire.t === 1) buys = buys.plus(size)
        else sells = sells.plus(size)
        if (!live)
          needed = needed.plus(
            price
              .mul(size)
              .div(String(current.config.leverage))
              .plus(price.mul(size).mul(Exact.max(value.market.takerFeeMicros, value.makerFeeMicros)).div(1_000_000))
              .plus(new Exact(value.market.recycleFeeRaw).div(1_000_000))
              .toDecimalPlaces(6, Decimal.ROUND_CEIL),
          )
      }
      const extreme = Exact.max(
        new Exact(value.inventory).plus(buys).abs(),
        new Exact(value.inventory).minus(sells).abs(),
      )
      if (extreme.gt(String(current.config.maxInventory))) throw Error('INVENTORY')
      const worstPrice = Exact.max(value.market.markRaw, ...orders.map((order) => order.wire_order.p!)).div(priceScale)
      if (extreme.mul(worstPrice).gt(String(current.config.maxNotional))) throw Error('NOTIONAL')
      if (needed.gt(value.market.freeBalance)) throw Error('STRATEGY_CAPITAL_INSUFFICIENT')
      const loss = Exact.max(0, new Exact(current.live_state.baselineEquity).minus(value.equity))
      if (new Exact(value.account.locked).plus(value.positionCollateral).plus(loss).plus(needed).gt(current.capital))
        throw Error('STRATEGY_ALLOCATION_INSUFFICIENT')
      optionsReady(options)
      if (!current.live_expires_at || Date.parse(current.live_expires_at) <= now()) throw Error('STRATEGY_RUN_EXPIRED')
    },
  )
}
