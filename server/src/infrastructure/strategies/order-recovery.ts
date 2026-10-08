import type { Pool } from 'pg'
import {
  reconcileStrategyIntent,
  type StrategyOrderResolution,
} from '../../../../packages/strategies/src/order-reconciliation.js'
import {
  strategyIntentHash,
  validStrategyBuilderTerms,
  type StrategyBuilderTerms,
} from '../../../../packages/strategies/src/order-intent.js'
import type { PerplOrder } from '../../../../packages/perpl/src/trading.js'
import type { VerifiedStrategyOperation } from '../../../../packages/perpl/src/strategy-receipts.js'
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
  created_at: Date
  idempotency_key: string | null
  wire_order: PerplOrder | null
  market_terms: ({ priceDecimals: number; sizeDecimals: number } & StrategyBuilderTerms) | null
  payload_hash: string | null
  target_order_id: string | null
  last_execution_block: string | null
  submitted_at: Date | null
  venue_progress: Record<string, unknown> | null
  recovery_version: string
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
         o.request_id::text,o.venue_order_id::text,o.status,o.created_at
         ,o.idempotency_key,o.wire_order,o.market_terms,o.payload_hash,o.target_order_id,
         o.last_execution_block::text,o.submitted_at,o.venue_progress,o.updated_at::text AS recovery_version
       FROM strategy_orders o JOIN strategies s ON s.id=o.strategy_id
       WHERE o.environment=$1 AND o.simulated=false AND o.request_id IS NOT NULL
         AND o.status IN ('SUBMITTING','UNKNOWN','OPEN','PARTIAL')
       ORDER BY o.created_at LIMIT 100`,
      [this.environment],
    )
    for (const row of pending.rows) {
      try {
        const lb = Number(row.last_execution_block)
        const terms = row.market_terms
        const valid =
          row.idempotency_key &&
          row.wire_order &&
          terms &&
          validStrategyBuilderTerms(terms) &&
          row.payload_hash &&
          Number.isSafeInteger(lb) &&
          lb > 0 &&
          row.submitted_at instanceof Date &&
          Number.isFinite(row.submitted_at.getTime()) &&
          [terms.priceDecimals, terms.sizeDecimals].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 18) &&
          (row.kind === 'POST' ? row.target_order_id === null : !!row.target_order_id && !!row.venue_order_id) &&
          strategyIntentHash(row.wire_order, terms, row.target_order_id) === row.payload_hash
        if (!valid) {
          await this.save(row, { status: 'UNKNOWN', error: 'STRATEGY_INTENT_UNVERIFIED' })
          continue
        }
        const scoped =
          (await this.venue?.forUser?.(row.user_id, row.connection_id)) ??
          (await this.venue?.recoveryForUser?.(row.user_id, row.connection_id))
        if (!scoped?.strategyOrderEvidence || scoped.accountId !== Number(row.account_id)) continue
        const intent = {
          accountId: Number(row.account_id),
          marketId: Number(row.market_id),
          requestId: row.request_id,
          kind: row.kind,
          order: row.wire_order!,
          lastExecutionBlock: lb,
          submittedAt: row.submitted_at!.getTime(),
          // Even a later lfr reset or missing history cannot erase earlier
          // positive command proof. Keep it unresolved until lifecycle proof.
          hasPersistedAdmission: row.venue_progress?.strategyAdmission !== undefined,
          previousAdmission: row.venue_progress?.strategyAdmission as VerifiedStrategyOperation | undefined,
          ...(Object.hasOwn(terms!, 'builderId')
            ? { builderId: terms!.builderId, builderFeePer100K: terms!.builderFeePer100K }
            : {}),
          ...(row.venue_order_id ? { venueOrderId: Number(row.venue_order_id) } : {}),
        }
        const evidence = await scoped.strategyOrderEvidence(intent)
        const resolution = reconcileStrategyIntent(intent, evidence)
        await this.save(row, resolution, {
          strategyOperations: evidence.operations ?? [],
          historyComplete: evidence.historyComplete === true,
        })
      } catch {
        // Transport/history failures keep prior state; next locked worker tick retries read-only.
      }
    }
  }

  private async save(row: PendingOrder, resolution: StrategyOrderResolution, evidence: Record<string, unknown> = {}) {
    const progress = {
      ...row.venue_progress,
      ...evidence,
      ...(resolution.admission ? { strategyAdmission: resolution.admission } : {}),
    }
    // A slow read may finish after another recovery result or intent change.
    // Preserve newer proof and compare the exact persisted command, not only status.
    await this.pool.query(
      `UPDATE strategy_orders SET status=$2,venue_order_id=COALESCE($3,venue_order_id),
       transaction_hash=COALESCE($4,transaction_hash),venue_progress=$5,error=$6,updated_at=now()
       WHERE id=$1 AND status=$7 AND request_id=$8::numeric
         AND payload_hash IS NOT DISTINCT FROM $9 AND wire_order IS NOT DISTINCT FROM $10::jsonb
         AND market_terms IS NOT DISTINCT FROM $11::jsonb AND target_order_id IS NOT DISTINCT FROM $12::uuid
         AND last_execution_block IS NOT DISTINCT FROM $13::bigint AND updated_at=$14::timestamptz
         AND venue_order_id IS NOT DISTINCT FROM $15::bigint`,
      [
        row.id,
        resolution.status,
        resolution.venueOrderId ?? null,
        resolution.transactionHash ?? null,
        JSON.stringify(progress),
        resolution.error ?? null,
        row.status,
        row.request_id,
        row.payload_hash,
        row.wire_order ? JSON.stringify(row.wire_order) : null,
        row.market_terms ? JSON.stringify(row.market_terms) : null,
        row.target_order_id,
        row.last_execution_block,
        row.recovery_version,
        row.venue_order_id,
      ],
    )
  }
}
