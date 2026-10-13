import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import Decimal from 'decimal.js'
import { planLiveStrategy, type LiveStrategySnapshot } from '../../../packages/strategies/src/live.js'
import { StrategyOrders, type StrategyOrderRecord } from '../application/strategy-orders.js'
import { verifyLiveStrategySend, releaseLiveStrategyCapital } from '../application/live-strategy-admission.js'
import {
  validStrategyOrderIdentity,
  matchesStrategyOrderIdentity,
} from '../../../packages/perpl/src/strategy-identity.js'
import { reconcileStrategyIntent } from '../../../packages/strategies/src/order-reconciliation.js'
import { strategyIntentHash } from '../../../packages/strategies/src/order-intent.js'
import type { VerifiedStrategyOperation } from '../../../packages/perpl/src/strategy-receipts.js'
import type { StrategyStore, StrategyRecord } from '../infrastructure/strategies/store.js'
import type { PostgresStore } from '../infrastructure/database/postgres-store.js'
import type { RuntimeVenue } from '../runtime.js'

export type LiveStrategyWorkerOptions = {
  enabled: () => boolean
  executionDisabled: () => boolean
  leaseOwned: () => boolean
}
type Order = StrategyOrderRecord & { created_at: Date }
const pending = ['QUEUED', 'SUBMITTING', 'UNKNOWN', 'OPEN', 'PARTIAL']

/** The runtime's single account lease owns scheduling. No ambiguous intent is dispatched twice. */
export class LiveStrategyWorker {
  private cursor: { createdAt: string; id: string } | null = null
  constructor(
    private readonly pool: Pool,
    private readonly store: StrategyStore,
    private readonly venues: RuntimeVenue | undefined,
    private readonly environment: 'mainnet' | 'testnet',
    private readonly options: LiveStrategyWorkerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  async tick(): Promise<void> {
    if (!this.options.leaseOwned()) return
    const rows = (
      await this.pool.query<StrategyRecord>(
        `SELECT * FROM strategies WHERE environment=$1 AND mode='LIVE'
       AND (status='RUNNING' OR live_cleanup_pending=true OR (status IN ('STOPPED','HALTED') AND
         EXISTS(SELECT 1 FROM strategy_capital_allocations a WHERE a.strategy_id=strategies.id AND a.status='HELD')))
       AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::uuid))
       ORDER BY created_at,id LIMIT 100`,
        [this.environment, this.cursor?.createdAt ?? null, this.cursor?.id ?? null],
      )
    ).rows
    for (const row of rows) {
      if (!this.options.leaseOwned()) return
      this.cursor = { createdAt: row.created_at, id: row.id }
      try {
        await this.run(row)
      } catch (error) {
        if (!this.options.leaseOwned()) return
        await this.halt(row, [error instanceof Error ? error.message : 'STRATEGY_LIVE_RUNTIME_UNAVAILABLE'])
        try {
          await this.cancelOwned(row, await this.orders(row.id))
        } catch {
          // Persisted cleanup remains pending; reconnect/recovery retries owned cancellation.
        }
      }
    }
    if (rows.length < 100) this.cursor = null
  }

  private async orders(strategyId: string): Promise<Order[]> {
    return (
      await this.pool.query<Order>(
        `SELECT * FROM strategy_orders WHERE strategy_id=$1 AND environment=$2 AND simulated=false
       AND status=ANY($3::text[]) ORDER BY created_at,id`,
        [strategyId, this.environment, pending],
      )
    ).rows
  }

  private service(): StrategyOrders {
    const admission = (intent: StrategyOrderRecord) =>
      verifyLiveStrategySend(this.pool, this.venues, this.environment, intent, this.options, this.now)
    return new StrategyOrders(
      { pool: this.pool } as PostgresStore,
      this.venues,
      this.environment,
      {
        enabled: this.options.enabled(),
        liveEnabled: this.options.enabled(),
        executionDisabled: this.options.executionDisabled(),
        accountMode: 'per-user',
      },
      admission,
      admission,
    )
  }

  private async run(row: StrategyRecord): Promise<void> {
    const now = this.now()
    const disabled = !this.options.enabled() || this.options.executionDisabled()
    const expired = !row.live_expires_at || new Date(row.live_expires_at).getTime() <= now
    const killed = await this.store.killed(row.user_id)
    let cleanup = row.status !== 'RUNNING' || row.live_cleanup_pending || disabled || expired || killed
    if (row.status === 'RUNNING' && cleanup) {
      await this.halt(row, [killed ? 'KILL_SWITCH' : expired ? 'RUN_DURATION' : 'EXECUTION_DISABLED'])
    }
    // A prior owner may have crashed between durable preparation and request allocation.
    // Such a QUEUED row is provably unsent. Never dispatch it after handover.
    await this.pool.query(
      `UPDATE strategy_orders SET status='FAILED',error='STRATEGY_UNSENT_OWNER_HANDOVER',updated_at=now()
       WHERE strategy_id=$1 AND environment=$2 AND simulated=false AND execution_origin='AUTOMATION'
       AND status='QUEUED' AND request_id IS NULL`,
      [row.id, this.environment],
    )
    let orders = await this.orders(row.id)
    let uncertain = orders.filter((order) => ['SUBMITTING', 'UNKNOWN'].includes(order.status))
    if (uncertain.some((order) => !order.submitted_at || now - new Date(order.submitted_at).getTime() >= 180_000)) {
      await this.halt(row, ['STRATEGY_OUTCOME_UNVERIFIED'])
      cleanup = true
    }
    if (cleanup) {
      const scoped = await this.venues?.forUser?.(row.user_id, row.connection_id)
      if (scoped?.strategySnapshot) {
        try {
          await this.retireExpired(row, orders, await scoped.strategySnapshot(row.market_id))
          orders = await this.orders(row.id)
        } catch {
          /* Fresh state is optional for cancelling a proved owned order. */
        }
      }
      await this.cancelOwned(row, orders)
      orders = await this.orders(row.id)
      if (orders.length === 0) await this.finishCleanup(row)
      return
    }
    const scoped = await this.venues?.forUser?.(row.user_id, row.connection_id)
    if (!scoped?.strategySnapshot || scoped.accountId !== Number(row.account_id))
      throw Error('STRATEGY_CONNECTION_UNAVAILABLE')
    let snapshot: LiveStrategySnapshot
    try {
      snapshot = await scoped.strategySnapshot(row.market_id)
    } catch (error) {
      await this.halt(row, [error instanceof Error ? error.message : 'STALE_DATA'])
      await this.cancelOwned(row, orders)
      return
    }
    await this.retireExpired(row, orders, snapshot)
    orders = await this.orders(row.id)
    uncertain = orders.filter((order) => ['SUBMITTING', 'UNKNOWN'].includes(order.status))
    if (!row.live_state) throw Error('STRATEGY_LIVE_BASELINE_REQUIRED')
    // Never advance the trusted observation cursor past an external wallet operation.
    // Cancellation requests remain owned after their order has reached a terminal state.
    if (!scoped.strategyAccountMutations) throw Error('STRATEGY_ACCOUNT_HISTORY_REQUIRED')
    const mutations = await scoped.strategyAccountMutations(row.live_state.lastBlock)
    const ownedRequests = new Set(
      (
        await this.pool.query<{ request_id: string }>(
          `SELECT request_id::text FROM strategy_orders WHERE strategy_id=$1 AND environment=$2
       AND simulated=false AND request_id IS NOT NULL`,
          [row.id, this.environment],
        )
      ).rows.map((order) => order.request_id),
    )
    if (
      mutations.some(
        (event) =>
          !Number.isSafeInteger(event.at?.b) ||
          (event.at.b! >= row.live_state!.lastBlock &&
            (![4, 5, 8, 9, 10].includes(event.et) || (event.et === 4 && !ownedRequests.has(String(event.r))))),
      )
    )
      throw Error('STRATEGY_FOREIGN_ACCOUNT_MUTATION')
    if (
      snapshot.account.lastRequestId !== row.live_state.lastRequestId &&
      !ownedRequests.has(snapshot.account.lastRequestId)
    )
      throw Error('STRATEGY_FOREIGN_ACCOUNT_REQUEST')
    if (snapshot.positions.some((position) => position.rq === undefined || !ownedRequests.has(String(position.rq))))
      throw Error('STRATEGY_FOREIGN_ACCOUNT_POSITION')
    const plan = planLiveStrategy(row.config, snapshot, row.live_state, now)
    if (plan.risk.length) {
      await this.halt(row, plan.risk, plan)
      await this.cancelOwned(row, orders)
      return
    }
    if (uncertain.length) return
    // Signed account state must contain only orders from our admitted placement lifetimes.
    if (
      snapshot.orders.some(
        (wire) =>
          !orders.some((order) => {
            const identity = order.venue_progress?.strategyAdmission as { identity?: unknown } | undefined
            return (
              order.kind === 'POST' &&
              validStrategyOrderIdentity(identity?.identity) &&
              matchesStrategyOrderIdentity(wire, identity.identity)
            )
          }),
      )
    ) {
      await this.halt(row, ['STRATEGY_FOREIGN_ACCOUNT_ORDER'])
      await this.cancelOwned(row, orders)
      return
    }
    const refreshMs = row.config.kind === 'MARKET_MAKER' ? row.config.maker!.refreshMs : 5_000
    if (now - row.live_state.lastRefreshAt < refreshMs) {
      await this.save(row, { ...plan, state: { ...plan.state, lastRefreshAt: row.live_state.lastRefreshAt } })
      return
    }
    if (orders.some((order) => order.kind === 'POST' && ['OPEN', 'PARTIAL'].includes(order.status))) {
      await this.cancelOwned(row, orders)
      return
    }
    if (orders.length || snapshot.orders.length) return
    // Persist the exact risk observation before any proposed quote can be dispatched.
    const state = { ...plan.state, lastRefreshAt: now }
    if (!(await this.save(row, { ...plan, state }))) return
    const service = this.service()
    for (const quote of plan.quotes) {
      if (!this.options.leaseOwned()) return
      const order = await service.submit(row.user_id, row.id, {
        idempotencyKey: randomUUID(),
        origin: 'AUTOMATION',
        order: {
          acc: Number(row.account_id),
          mkt: row.market_id,
          t: quote.side === 'BUY' ? 1 : 2,
          p: quote.priceRaw,
          s: quote.sizeRaw,
          lv: new Decimal(String(row.config.leverage)).mul(100).toNumber(),
          fl: 1,
          mnp: 0,
          tif: snapshot.headBlock + snapshot.market.orderTtlBlocks,
          orderTtlBlocks: snapshot.market.orderTtlBlocks,
        },
        marketTerms: {
          priceDecimals: snapshot.market.priceDecimals,
          sizeDecimals: snapshot.market.sizeDecimals,
          contractMarketId: snapshot.contractMarketId,
        },
      })
      if (order.status === 'FAILED' || order.error) {
        await this.halt(row, [order.error ?? 'STRATEGY_SUBMISSION_REFUSED'])
        return
      }
    }
  }

  private async retireExpired(row: StrategyRecord, orders: Order[], snapshot: LiveStrategySnapshot) {
    if (
      !this.options.leaseOwned() ||
      !snapshot.chainFinalized ||
      snapshot.orders.length ||
      !new Decimal(snapshot.account.locked).isZero()
    )
      return
    for (const order of orders) {
      const tif = order.wire_order?.tif,
        deadline = Number(order.last_execution_block)
      if (
        order.kind !== 'POST' ||
        !['OPEN', 'PARTIAL', 'UNKNOWN'].includes(order.status) ||
        !Number.isSafeInteger(tif) ||
        tif! <= 0 ||
        tif! >= snapshot.chainBlock ||
        !Number.isSafeInteger(deadline) ||
        deadline <= 0 ||
        deadline >= snapshot.chainBlock ||
        !order.request_id ||
        !order.submitted_at ||
        order.payload_hash !== strategyIntentHash(order.wire_order, order.market_terms, null)
      )
        continue
      const resolution = reconcileStrategyIntent(
        {
          accountId: Number(row.account_id),
          marketId: row.market_id,
          contractMarketId: order.market_terms.contractMarketId,
          requestId: String(order.request_id),
          kind: 'POST',
          order: order.wire_order,
          lastExecutionBlock: deadline,
          submittedAt: new Date(order.submitted_at).getTime(),
          venueOrderId: Number(order.venue_order_id),
          previousAdmission: order.venue_progress?.strategyAdmission as VerifiedStrategyOperation | undefined,
          ...(Object.hasOwn(order.market_terms, 'builderId')
            ? { builderId: order.market_terms.builderId, builderFeePer100K: order.market_terms.builderFeePer100K }
            : {}),
        },
        { snapshotReady: false, snapshot: [], history: [], operations: [] },
      )
      if (!resolution.admission?.identity) continue
      // Expiry means no future fills. It does not mean zero prior fills or release position collateral.
      await this.pool.query(
        `UPDATE strategy_orders SET status='EXPIRED',error='STRATEGY_NATIVE_LIFETIME_EXPIRED',updated_at=now()
         WHERE id=$1 AND strategy_id=$2 AND status=$3 AND payload_hash=$4 AND request_id=$5::numeric
           AND wire_order=$6::jsonb AND market_terms=$7::jsonb AND simulated=false`,
        [
          order.id,
          row.id,
          order.status,
          order.payload_hash,
          order.request_id,
          JSON.stringify(order.wire_order),
          JSON.stringify(order.market_terms),
        ],
      )
    }
  }

  private async cancelOwned(row: StrategyRecord, orders: Order[]): Promise<void> {
    const service = this.service()
    for (const target of orders.filter(
      (order) => order.kind === 'POST' && ['OPEN', 'PARTIAL'].includes(order.status),
    )) {
      if (!this.options.leaseOwned()) return
      if (orders.some((order) => order.kind === 'CANCEL' && order.target_order_id === target.id)) continue
      await service.submit(row.user_id, row.id, {
        idempotencyKey: randomUUID(),
        origin: 'AUTOMATION',
        targetOrderId: target.id,
        order: {
          acc: Number(row.account_id),
          mkt: row.market_id,
          t: 5,
          s: 0,
          lv: 0,
          fl: 0,
          mnp: 0,
          orderTtlBlocks: target.wire_order.orderTtlBlocks,
        },
        marketTerms: {
          priceDecimals: target.market_terms.priceDecimals,
          sizeDecimals: target.market_terms.sizeDecimals,
          contractMarketId: target.market_terms.contractMarketId,
        },
      })
    }
  }

  private async save(row: StrategyRecord, plan: ReturnType<typeof planLiveStrategy>): Promise<boolean> {
    if (!this.options.leaseOwned()) return false
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const changed = await client.query(
        `UPDATE strategies SET live_state=$3,version=version+1,updated_at=now()
         WHERE id=$1 AND environment=$2 AND mode='LIVE' AND status='RUNNING' AND version=$4
         AND live_cleanup_pending=false AND live_expires_at>to_timestamp($5/1000.0)
         AND NOT EXISTS(SELECT 1 FROM strategy_user_controls u WHERE u.user_id=strategies.user_id AND u.killed=true)
         RETURNING id`,
        [row.id, this.environment, JSON.stringify(plan.state), row.version, this.now()],
      )
      if (!changed.rows.length) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(
        `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory)
         VALUES($1,to_timestamp($2/1000.0),$3,$4) ON CONFLICT(strategy_id,observed_at) DO UPDATE
         SET equity=EXCLUDED.equity,inventory=EXCLUDED.inventory`,
        [row.id, this.now(), plan.equity, plan.inventory],
      )
      await client.query(
        `INSERT INTO strategy_tick_minutes(strategy_id,minute,first_tick,last_tick,tick_count)
         VALUES($1,date_trunc('minute',to_timestamp($2/1000.0)),to_timestamp($2/1000.0),to_timestamp($2/1000.0),1)
         ON CONFLICT(strategy_id,minute) DO UPDATE SET last_tick=EXCLUDED.last_tick,
         tick_count=strategy_tick_minutes.tick_count+1`,
        [row.id, this.now()],
      )
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async halt(row: StrategyRecord, codes: string[], plan?: ReturnType<typeof planLiveStrategy>) {
    if (!this.options.leaseOwned()) return
    const changed = await this.pool.query(
      `UPDATE strategies SET status='HALTED',live_cleanup_pending=true,
       live_state=COALESCE($3::jsonb,live_state),version=version+1,updated_at=now()
       WHERE id=$1 AND environment=$2 AND mode='LIVE' AND status='RUNNING' RETURNING id`,
      [row.id, this.environment, plan ? JSON.stringify(plan.state) : null],
    )
    if (!changed.rows.length) return
    for (const code of [...new Set(codes)])
      await this.pool.query('INSERT INTO strategy_risk_events(strategy_id,code) VALUES($1,$2)', [row.id, code])
  }

  private async finishCleanup(row: StrategyRecord) {
    const scoped = await this.venues?.forUser?.(row.user_id, row.connection_id)
    if (!scoped?.strategySnapshot) return
    const snapshot = await scoped.strategySnapshot(row.market_id)
    if (snapshot.orders.length) return
    if (!this.options.leaseOwned()) return
    await this.pool.query(
      `UPDATE strategies SET live_cleanup_pending=false,version=version+1,updated_at=now()
       WHERE id=$1 AND environment=$2 AND mode='LIVE' AND status<>'RUNNING'
       AND NOT EXISTS(SELECT 1 FROM strategy_orders o WHERE o.strategy_id=$1 AND simulated=false
         AND o.status IN ('QUEUED','SUBMITTING','UNKNOWN','OPEN','PARTIAL'))`,
      [row.id, this.environment],
    )
    await releaseLiveStrategyCapital(this.pool, this.venues, row, this.options.leaseOwned)
  }
}
