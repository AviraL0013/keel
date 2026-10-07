import type { Pool } from 'pg'
import { reconcileStrategyOrder } from '../../../../packages/strategies/src/order-reconciliation.js'
import type { RuntimeVenue } from '../../runtime.js'

type PendingOrder = {
  id: string
  strategy_id: string
  user_id: string
  connection_id: string
  account_id: string
  market_id: number
  kind: 'POST' | 'CHANGE' | 'CANCEL'
  request_id: string
  venue_order_id: string | null
  status: string
}

/** Read-only recovery. UNKNOWN and missing request IDs have no submission path. */
export class StrategyOrderRecovery {
  constructor(
    private readonly pool: Pool,
    private readonly venue: RuntimeVenue | undefined,
    private readonly environment: 'testnet' | 'mainnet',
  ) {}

  async recover(): Promise<void> {
    const pending = await this.pool.query<PendingOrder>(
      `SELECT o.id,o.strategy_id,s.user_id,s.connection_id,o.account_id,o.market_id,o.kind,
         o.request_id::text,o.venue_order_id::text,o.status
       FROM strategy_orders o JOIN strategies s ON s.id=o.strategy_id
       WHERE o.environment=$1 AND o.simulated=false AND o.request_id IS NOT NULL
         AND o.status IN ('SUBMITTING','UNKNOWN','OPEN','PARTIAL')
       ORDER BY o.created_at LIMIT 100`,
      [this.environment],
    )
    for (const row of pending.rows) {
      try {
        const scoped =
          (await this.venue?.forUser?.(row.user_id, row.connection_id)) ??
          (await this.venue?.recoveryForUser?.(row.user_id, row.connection_id))
        if (!scoped?.strategyOrderEvidence || scoped.accountId !== Number(row.account_id)) continue
        const intent = {
          accountId: Number(row.account_id),
          marketId: Number(row.market_id),
          requestId: row.request_id,
          kind: row.kind,
          ...(row.venue_order_id ? { venueOrderId: Number(row.venue_order_id) } : {}),
        }
        const resolution = reconcileStrategyOrder(intent, await scoped.strategyOrderEvidence(intent))
        await this.pool.query(
          `UPDATE strategy_orders SET status=$2,venue_order_id=COALESCE($3,venue_order_id),
          transaction_hash=COALESCE($4,transaction_hash),updated_at=now()
          WHERE id=$1 AND status IN ('SUBMITTING','UNKNOWN','OPEN','PARTIAL')`,
          [row.id, resolution.status, resolution.venueOrderId ?? null, resolution.transactionHash ?? null],
        )
      } catch {
        // Transport/history failures keep prior state; next locked worker tick retries read-only.
      }
    }
  }
}
