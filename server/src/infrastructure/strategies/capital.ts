import type { Pool, PoolClient } from 'pg'
import { moneyMicros, formatMoney } from '../../../../packages/ausd/src/money.js'
import { strategyIntentHash } from '../../../../packages/strategies/src/order-intent.js'
import { withAccountCapital, assertAccountCapitalCoverage, type AccountCapitalBalance } from '../capital/admission.js'
import type { StrategyOrderRecord } from '../../application/strategy-orders.js'

type Binding = {
  id: string
  user_id: string
  connection_id: string
  environment: 'testnet' | 'mainnet'
  account_id: string
  market_id: number
  capital: string
  mode: string
  status: string
}
type Allocation = {
  strategy_id: string
  amount: string
  available: string
  reserved: string
  status: 'HELD' | 'RELEASED'
}
type Transaction = Pick<PoolClient, 'query'>
type BalanceReader = (strategy: Binding, transaction: Transaction) => Promise<AccountCapitalBalance>
type CostReader = (
  intent: StrategyOrderRecord,
  strategy: Binding,
  transaction: Transaction,
) => Promise<{ required: string; balance: AccountCapitalBalance }>

/** Internal capital seam; no runtime/controller mount or order transmission.
 * Required readers are server-owned, run AFTER the shared account lock, and never accept client balances.
 * Filled/transmitted reservations cannot be released until financial settlement proof is integrated.
 */
export class StrategyCapital {
  constructor(
    private readonly pool: Pool,
    private readonly environment: 'testnet' | 'mainnet',
    private readonly readBalance: BalanceReader,
    private readonly readCost: CostReader,
  ) {
    if (typeof readBalance !== 'function' || typeof readCost !== 'function')
      throw Error('STRATEGY_CAPITAL_ADMISSION_REQUIRED')
  }
  private async locked<T>(
    userId: string,
    strategyId: string,
    work: (
      client: PoolClient,
      row: Binding,
      binding: { environment: 'testnet' | 'mainnet'; account_id: string; user_id: string },
    ) => Promise<T>,
  ) {
    const found = (
      await this.pool.query<Binding>('SELECT * FROM strategies WHERE id=$1 AND user_id=$2 AND environment=$3', [
        strategyId,
        userId,
        this.environment,
      ])
    ).rows[0]
    if (!found) throw Error('STRATEGY_NOT_FOUND')
    return withAccountCapital(
      this.pool,
      { userId, connectionId: found.connection_id, accountId: Number(found.account_id), environment: this.environment },
      async (client, binding) => {
        const row = (
          await client.query<Binding>(
            'SELECT * FROM strategies WHERE id=$1 AND user_id=$2 AND environment=$3 FOR UPDATE',
            [strategyId, userId, this.environment],
          )
        ).rows[0]
        if (
          !row ||
          row.connection_id !== found.connection_id ||
          row.account_id !== found.account_id ||
          row.mode !== 'LIVE'
        )
          throw Error('STRATEGY_CAPITAL_BINDING_CHANGED')
        return work(client, row, binding)
      },
    )
  }
  private async coverage(
    client: PoolClient,
    binding: { environment: 'testnet' | 'mainnet'; account_id: string; user_id: string },
    balance: AccountCapitalBalance,
  ) {
    try {
      await assertAccountCapitalCoverage(client, binding, balance, '0.000000')
    } catch (error) {
      if (error instanceof Error && error.message === 'ACCOUNT_CAPITAL_INSUFFICIENT')
        throw Error('STRATEGY_WOULD_UNDERFUND_BOOK_RESERVES')
      throw error
    }
  }
  async allocate(userId: string, strategyId: string): Promise<Allocation> {
    return this.locked(userId, strategyId, async (client, row, binding) => {
      const existing = (
        await client.query<Allocation>('SELECT * FROM strategy_capital_allocations WHERE strategy_id=$1', [row.id])
      ).rows[0]
      if (existing) {
        if (existing.status !== 'HELD' || moneyMicros(existing.amount) !== moneyMicros(row.capital))
          throw Error('STRATEGY_CAPITAL_CHANGED')
        return existing
      }
      if (row.status !== 'PAUSED' || moneyMicros(row.capital) <= 0n) throw Error('STRATEGY_CAPITAL_NOT_PAUSED')
      await this.coverage(client, binding, await this.readBalance(row, client))
      return (
        await client.query<Allocation>(
          `INSERT INTO strategy_capital_allocations(strategy_id,environment,
        account_id,market_id,amount,available,status) VALUES($1,$2,$3,$4,$5,$5,'HELD') RETURNING *`,
          [row.id, row.environment, row.account_id, row.market_id, formatMoney(moneyMicros(row.capital))],
        )
      ).rows[0]
    })
  }
  async reserve(userId: string, strategyId: string, orderId: string) {
    return this.locked(userId, strategyId, async (client, row, binding) => {
      const allocation = (
        await client.query<Allocation>('SELECT * FROM strategy_capital_allocations WHERE strategy_id=$1 FOR UPDATE', [
          row.id,
        ])
      ).rows[0]
      if (!allocation || allocation.status !== 'HELD' || moneyMicros(allocation.amount) !== moneyMicros(row.capital))
        throw Error('STRATEGY_CAPITAL_CHANGED')
      const intent = (
        await client.query<StrategyOrderRecord>(
          `SELECT * FROM strategy_orders WHERE id=$1 AND strategy_id=$2
        AND environment=$3 AND account_id=$4 AND market_id=$5 FOR UPDATE`,
          [orderId, row.id, row.environment, row.account_id, row.market_id],
        )
      ).rows[0]
      if (
        !intent ||
        intent.simulated ||
        intent.kind !== 'POST' ||
        !intent.wire_order ||
        !intent.market_terms ||
        intent.target_order_id !== null ||
        intent.payload_hash !== strategyIntentHash(intent.wire_order, intent.market_terms, null)
      )
        throw Error('STRATEGY_RESERVATION_INTENT_INVALID')
      const cost = await this.readCost(intent, row, client),
        amount = moneyMicros(cost.required)
      if (amount <= 0n) throw Error('STRATEGY_RESERVATION_AMOUNT_INVALID')
      // A held reservation is idempotent, but never a substitute for fresh pre-send state.
      await this.coverage(client, binding, cost.balance)
      const existing = (
        await client.query<{ amount: string; intent_hash: string; status: string }>(
          'SELECT amount,intent_hash,status FROM strategy_capital_reservations WHERE order_id=$1',
          [intent.id],
        )
      ).rows[0]
      if (existing) {
        if (
          existing.status !== 'HELD' ||
          moneyMicros(existing.amount) !== amount ||
          existing.intent_hash !== intent.payload_hash
        )
          throw Error('STRATEGY_RESERVATION_CONFLICT')
        return existing
      }
      if (intent.status !== 'QUEUED' || intent.request_id !== null) throw Error('STRATEGY_RESERVATION_TOO_LATE')
      if (amount > moneyMicros(allocation.available)) throw Error('STRATEGY_ALLOCATION_INSUFFICIENT')
      const reserved = (
        await client.query(
          `INSERT INTO strategy_capital_reservations(order_id,strategy_id,environment,
        account_id,market_id,amount,intent_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,'HELD') RETURNING *`,
          [intent.id, row.id, row.environment, row.account_id, row.market_id, formatMoney(amount), intent.payload_hash],
        )
      ).rows[0]
      await client.query(
        `UPDATE strategy_capital_allocations SET available=available-$2,reserved=reserved+$2,updated_at=now()
        WHERE strategy_id=$1`,
        [row.id, formatMoney(amount)],
      )
      return reserved
    })
  }
  async releaseIdle(userId: string, strategyId: string) {
    return this.locked(userId, strategyId, async (client, row) => {
      if (!['STOPPED', 'HALTED'].includes(row.status)) throw Error('STRATEGY_CAPITAL_NOT_STOPPED')
      const allocation = await client.query(
        'SELECT strategy_id FROM strategy_capital_allocations WHERE strategy_id=$1 FOR UPDATE',
        [row.id],
      )
      if (!allocation.rows.length) throw Error('STRATEGY_CAPITAL_ALLOCATION_MISSING')
      await client.query('SELECT id FROM strategy_orders WHERE strategy_id=$1 AND simulated=false FOR UPDATE', [row.id])
      const exposure = await client.query(
        `SELECT 1 FROM strategy_orders WHERE strategy_id=$1 AND simulated=false
        AND (request_id IS NOT NULL OR status NOT IN ('QUEUED','FAILED'))
        UNION ALL SELECT 1 FROM strategy_verified_fills WHERE strategy_id=$1 LIMIT 1`,
        [row.id],
      )
      if (exposure.rows.length) throw Error('STRATEGY_CAPITAL_EXPOSURE_UNRESOLVED')
      // This wins or loses the same row lock/CAS as beforeSend. A later sender cannot transmit a released intent.
      await client.query(
        `UPDATE strategy_orders SET status='FAILED',error='STRATEGY_CAPITAL_RELEASED_BEFORE_SEND',updated_at=now()
        WHERE strategy_id=$1 AND simulated=false AND status='QUEUED' AND request_id IS NULL`,
        [row.id],
      )
      await client.query(
        `UPDATE strategy_capital_reservations SET status='RELEASED',released_at=now()
        WHERE strategy_id=$1 AND status='HELD'`,
        [row.id],
      )
      await client.query(
        `UPDATE strategy_capital_allocations SET status='RELEASED',available=0,reserved=0,updated_at=now()
        WHERE strategy_id=$1 AND status='HELD'`,
        [row.id],
      )
    })
  }
  async leaks(userId: string) {
    const rows = await this.pool.query<{ id: string }>(
      `SELECT s.id FROM strategies s LEFT JOIN strategy_capital_allocations a ON a.strategy_id=s.id
      WHERE s.user_id=$1 AND s.environment=$2 AND s.mode='LIVE' AND s.status IN ('STOPPED','HALTED')
        AND (a.status='HELD' OR a.strategy_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM strategy_orders o WHERE o.strategy_id=s.id AND o.simulated=false AND o.request_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM strategy_verified_fills f WHERE f.strategy_id=s.id)`,
      [userId, this.environment],
    )
    return rows.rows.map((row) => ({ strategyId: row.id, code: 'STRATEGY_IDLE_CAPITAL_HELD' }))
  }
}
