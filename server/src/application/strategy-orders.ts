import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import { requestId } from '../../../packages/perpl/src/request-id.js'
import { PerplPreSubmissionError, type PerplOrder } from '../../../packages/perpl/src/trading.js'
import { strategyIntentHash as hash, type StrategyBuilderTerms } from '../../../packages/strategies/src/order-intent.js'
import type { PostgresStore } from '../infrastructure/database/postgres-store.js'
import type { RuntimeVenue } from '../runtime.js'
import {
  decodeStrategyOrderIdentity,
  encodeStrategyOrderIdentity,
  type StrategyOrderIdentity,
} from '../../../packages/perpl/src/strategy-identity.js'
import { reconcileStrategyIntent } from '../../../packages/strategies/src/order-reconciliation.js'
import type { VerifiedStrategyOperation } from '../../../packages/perpl/src/strategy-receipts.js'

const Exact = Decimal.clone({ precision: 80 })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Terms = {
  priceDecimals: number
  sizeDecimals: number
  contractMarketId?: number
  targetIdentity?: string
} & StrategyBuilderTerms
export type StrategyIntentInput = {
  idempotencyKey: string
  order: PerplOrder
  /** Server-produced units. The required admission callback must revalidate them against fresh venue metadata. */
  marketTerms: Terms
  targetOrderId?: string
}
export type StrategyOrderRecord = {
  id: string
  strategy_id: string
  environment: 'testnet' | 'mainnet'
  account_id: string
  market_id: number
  kind: 'POST' | 'CHANGE' | 'CANCEL'
  status: string
  simulated: boolean
  wire_order: PerplOrder
  market_terms: Terms
  payload_hash: string
  target_order_id: string | null
  venue_order_id: number | null
  request_id: string | null
  last_execution_block: string | number | null
  submitted_at: Date | null
  size: string | null
  price: string | null
  error: string | null
  venue_progress?: Record<string, unknown> | null
}
type StrategyBinding = {
  id: string
  connection_id: string
  account_id: string
  market_id: number
  mode: string
  builder_id: number | null
  builder_fee_ceiling: number | null
}
type Options = { enabled: boolean; executionDisabled: boolean; accountMode: 'operator' | 'per-user' }

/** Internal, fake-tested submission seam. Not mounted in HTTP or the worker.
 * LIVE startup remains blocked until capital isolation, verified cleanup and confirmation are implemented.
 */
export class StrategyOrders {
  constructor(
    private readonly store: PostgresStore,
    private readonly venues: RuntimeVenue | undefined,
    private readonly environment: 'testnet' | 'mainnet',
    private readonly options: Options,
    private readonly verifyBeforeSend: (intent: StrategyOrderRecord) => Promise<void>,
  ) {
    if (typeof verifyBeforeSend !== 'function') throw new Error('STRATEGY_ADMISSION_REQUIRED')
  }

  private assertEnabled() {
    if (!this.options.enabled || this.options.executionDisabled || this.options.accountMode !== 'per-user')
      throw new Error('STRATEGY_SUBMISSION_DISABLED')
  }

  private async binding(userId: string, strategyId: string): Promise<StrategyBinding> {
    const result = await this.store.pool.query<StrategyBinding>(
      `SELECT s.id,s.connection_id,s.account_id::text,s.market_id,s.mode,c.builder_id,c.builder_fee_ceiling
       FROM strategies s JOIN perpl_connections c ON c.id=s.connection_id AND c.user_id=s.user_id
       WHERE s.id=$1 AND s.user_id=$2 AND s.environment=$3`,
      [strategyId, userId, this.environment],
    )
    if (!result.rows[0]) throw new Error('STRATEGY_NOT_FOUND')
    return result.rows[0]
  }

  private builderTerms(binding: Pick<StrategyBinding, 'builder_id' | 'builder_fee_ceiling'>): StrategyBuilderTerms {
    if (binding.builder_id === null && binding.builder_fee_ceiling === null)
      return { builderId: null, builderFeePer100K: 0 }
    if (
      !Number.isSafeInteger(binding.builder_id) ||
      binding.builder_id! < 1 ||
      binding.builder_id! > 255 ||
      !Number.isSafeInteger(binding.builder_fee_ceiling) ||
      binding.builder_fee_ceiling! < 0
    )
      throw new Error('STRATEGY_BUILDER_TERMS_INVALID')
    return { builderId: binding.builder_id, builderFeePer100K: 0 }
  }

  private async authorize(userId: string, binding: StrategyBinding, terms: Terms) {
    this.assertEnabled()
    const allowed = await this.store.pool.query(
      `SELECT c.builder_id,c.builder_fee_ceiling FROM strategies s JOIN perpl_connections c ON c.id=s.connection_id AND c.user_id=s.user_id
       JOIN perpl_accounts a ON a.connection_id=c.id AND a.account_id=s.account_id
       JOIN perpl_account_owners o ON o.environment=s.environment AND o.account_id=s.account_id AND o.user_id=s.user_id
       WHERE s.id=$1 AND s.user_id=$2 AND s.environment=$3 AND s.connection_id=$4::uuid AND s.mode='LIVE' AND s.status='RUNNING'
         AND s.live_confirmed_at IS NOT NULL AND c.environment=s.environment AND c.status='ACTIVE'
         AND c.revoked_at IS NULL AND c.expires_at>now() AND c.scope='trade' AND a.forwarding=true AND a.frozen=false
         AND NOT EXISTS(SELECT 1 FROM strategy_user_controls u WHERE u.user_id=s.user_id AND u.killed=true)`,
      [binding.id, userId, this.environment, binding.connection_id],
    )
    if (!allowed.rows.length) throw new Error('STRATEGY_CONNECTION_UNAVAILABLE')
    if (this.builderTerms(allowed.rows[0]).builderId !== terms.builderId || terms.builderFeePer100K !== 0)
      throw new Error('STRATEGY_BUILDER_TERMS_CHANGED')
    const venue = await this.venues?.forUser?.(userId, binding.connection_id)
    if (
      !venue?.submitStrategy ||
      venue.accountId !== Number(binding.account_id) ||
      venue.connectionId !== binding.connection_id
    )
      throw new Error('STRATEGY_CONNECTION_UNAVAILABLE')
    return venue
  }

  private async payload(binding: StrategyBinding, input: StrategyIntentInput, prior?: StrategyOrderRecord | null) {
    const raw = input.order
    const terms: Terms = {
      priceDecimals: input.marketTerms?.priceDecimals,
      sizeDecimals: input.marketTerms?.sizeDecimals,
      contractMarketId: input.marketTerms?.contractMarketId,
      ...(prior
        ? Object.hasOwn(prior.market_terms, 'builderId')
          ? { builderId: prior.market_terms.builderId, builderFeePer100K: prior.market_terms.builderFeePer100K }
          : {}
        : this.builderTerms(binding)),
    }
    const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    if (
      !uuid.test(input.idempotencyKey) ||
      !raw ||
      ![1, 2, 5, 7].includes(raw.t) ||
      !positive(raw.orderTtlBlocks) ||
      !positive(terms.contractMarketId) ||
      ![terms.priceDecimals, terms.sizeDecimals].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 18) ||
      Object.keys(raw).some((key) => !['acc', 'mkt', 't', 's', 'p', 'lv', 'fl', 'oid', 'orderTtlBlocks'].includes(key))
    )
      throw new Error('STRATEGY_ORDER_INVALID')
    if (raw.acc !== Number(binding.account_id) || raw.mkt !== binding.market_id)
      throw new Error('STRATEGY_ORDER_BINDING_INVALID')
    const kind = raw.t === 5 ? 'CANCEL' : raw.t === 7 ? 'CHANGE' : 'POST'
    const target = input.targetOrderId?.toLowerCase() ?? null
    const order: PerplOrder = {
      acc: raw.acc,
      mkt: raw.mkt,
      t: raw.t,
      s: raw.s,
      lv: raw.lv,
      fl: raw.fl,
      orderTtlBlocks: raw.orderTtlBlocks,
    }
    if (kind === 'POST') {
      if (
        target ||
        raw.oid !== undefined ||
        raw.fl !== 1 ||
        !positive(raw.s) ||
        !positive(raw.p) ||
        !positive(raw.lv) ||
        raw.lv < 100
      )
        throw new Error('STRATEGY_ORDER_INVALID')
      order.p = raw.p
    } else {
      if (
        !target ||
        !uuid.test(target) ||
        raw.lv !== 0 ||
        raw.fl !== 0 ||
        (kind === 'CANCEL' ? raw.s !== 0 || raw.p !== undefined : !positive(raw.s) || !positive(raw.p))
      )
        throw new Error('STRATEGY_ORDER_TARGET_INVALID')
      const identity = prior
        ? decodeStrategyOrderIdentity(prior.market_terms.targetIdentity)
        : await this.targetIdentity(binding, target, terms)
      if (!identity) throw new Error('STRATEGY_ORDER_TARGET_INVALID')
      const oid = identity.venueOrderId
      if (raw.oid !== undefined && raw.oid !== oid) throw new Error('STRATEGY_ORDER_TARGET_INVALID')
      terms.targetIdentity = encodeStrategyOrderIdentity(identity)
      order.oid = oid
      if (kind === 'CHANGE') order.p = raw.p
    }
    return { order, terms, target, kind, payloadHash: hash(order, terms, target) }
  }

  private async targetIdentity(binding: StrategyBinding, target: string, terms: Terms): Promise<StrategyOrderIdentity> {
    const result = await this.store.pool.query<StrategyOrderRecord>(
      `SELECT * FROM strategy_orders WHERE id=$1 AND strategy_id=$2
       AND environment=$3 AND account_id=$4 AND market_id=$5 AND kind='POST' AND simulated=false
       AND status IN ('OPEN','PARTIAL') AND venue_order_id IS NOT NULL`,
      [target, binding.id, this.environment, binding.account_id, binding.market_id],
    )
    const owned = result.rows[0]
    if (
      !owned?.wire_order ||
      !owned.market_terms ||
      !owned.request_id ||
      !owned.submitted_at ||
      owned.market_terms.priceDecimals !== terms.priceDecimals ||
      owned.market_terms.sizeDecimals !== terms.sizeDecimals ||
      owned.market_terms.contractMarketId !== terms.contractMarketId ||
      owned.target_order_id !== null ||
      owned.payload_hash !== hash(owned.wire_order, owned.market_terms, null)
    )
      throw new Error('STRATEGY_ORDER_TARGET_INVALID')
    const resolution = reconcileStrategyIntent(
      {
        accountId: Number(binding.account_id),
        marketId: binding.market_id,
        contractMarketId: owned.market_terms.contractMarketId,
        requestId: String(owned.request_id),
        kind: 'POST',
        order: owned.wire_order,
        lastExecutionBlock: Number(owned.last_execution_block),
        submittedAt: owned.submitted_at.getTime(),
        venueOrderId: Number(owned.venue_order_id),
        previousAdmission: owned.venue_progress?.strategyAdmission as VerifiedStrategyOperation | undefined,
        ...(Object.hasOwn(owned.market_terms, 'builderId')
          ? { builderId: owned.market_terms.builderId, builderFeePer100K: owned.market_terms.builderFeePer100K }
          : {}),
      },
      { snapshotReady: false, snapshot: [], history: [], operations: [] },
    )
    if (!resolution.admission?.identity) throw new Error('STRATEGY_ORDER_TARGET_INVALID')
    return resolution.admission.identity
  }

  async prepare(userId: string, strategyId: string, input: StrategyIntentInput) {
    const binding = await this.binding(userId, strategyId)
    if (!uuid.test(input.idempotencyKey)) throw new Error('STRATEGY_ORDER_INVALID')
    const findExisting = async () => {
      const found = await this.store.pool.query<StrategyOrderRecord>(
        'SELECT * FROM strategy_orders WHERE strategy_id=$1 AND idempotency_key=$2',
        [strategyId, input.idempotencyKey],
      )
      const row = found.rows[0]
      if (
        row &&
        (!row.wire_order ||
          !row.market_terms ||
          row.payload_hash !== hash(row.wire_order, row.market_terms, row.target_order_id))
      )
        throw new Error('STRATEGY_INTENT_CHANGED')
      return row ?? null
    }
    // Replay uses the durable identity even after its target has settled.
    // Only a new intent or its final send requires current target eligibility.
    const prior = await findExisting()
    const payload = await this.payload(binding, input, prior)
    const existing = async () => {
      const row = await findExisting()
      if (row && row.payload_hash !== payload.payloadHash) throw new Error('STRATEGY_IDEMPOTENCY_CONFLICT')
      return row ? { ...row, createdNow: false } : null
    }
    if (prior) {
      if (prior.payload_hash !== payload.payloadHash) throw new Error('STRATEGY_IDEMPOTENCY_CONFLICT')
      return { ...prior, createdNow: false }
    }
    await this.authorize(userId, binding, payload.terms)
    const price =
      payload.order.p === undefined
        ? null
        : new Exact(payload.order.p)
            .div(new Exact(10).pow(payload.terms.priceDecimals))
            .toFixed(payload.terms.priceDecimals)
    const size =
      payload.kind === 'CANCEL'
        ? null
        : new Exact(payload.order.s)
            .div(new Exact(10).pow(payload.terms.sizeDecimals))
            .toFixed(payload.terms.sizeDecimals)
    try {
      const inserted = await this.store.pool.query<StrategyOrderRecord>(
        `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,simulated,status,
          side,price,size,idempotency_key,wire_order,market_terms,payload_hash,target_order_id,venue_order_id)
         VALUES($1,$2,$3,$4,$5,$6,false,'QUEUED',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          randomUUID(),
          strategyId,
          this.environment,
          binding.account_id,
          binding.market_id,
          payload.kind,
          payload.kind === 'POST' ? (payload.order.t === 1 ? 'BUY' : 'SELL') : null,
          price,
          size,
          input.idempotencyKey,
          JSON.stringify(payload.order),
          JSON.stringify(payload.terms),
          payload.payloadHash,
          payload.target,
          payload.order.oid ?? null,
        ],
      )
      return { ...inserted.rows[0]!, createdNow: true }
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const duplicate = await existing()
        if (duplicate) return duplicate
      }
      throw error
    }
  }

  async submit(userId: string, strategyId: string, input: StrategyIntentInput): Promise<StrategyOrderRecord> {
    const intent = await this.prepare(userId, strategyId, input)
    if (!intent.createdNow) return intent
    const binding = await this.binding(userId, strategyId)
    const current = async () =>
      (
        await this.store.pool.query<StrategyOrderRecord>(
          'SELECT * FROM strategy_orders WHERE id=$1 AND strategy_id=$2',
          [intent.id, strategyId],
        )
      ).rows[0]!
    let ownedRequest: string | null = null
    let ownedExpiry: number | null = null
    try {
      const venue = await this.authorize(userId, binding, intent.market_terms)
      const result = await venue.submitStrategy!(
        intent.id,
        intent.wire_order,
        async (reference, lb) => {
          try {
            const parts = reference.split(':')
            if (
              parts.length !== 2 ||
              parts[0] !== binding.account_id ||
              requestId(parts[1]) === 0n ||
              !Number.isSafeInteger(lb) ||
              lb <= 0
            )
              throw new Error('STRATEGY_REFERENCE_INVALID')
            const saved = await this.store.pool.query(
              `UPDATE strategy_orders SET status='SUBMITTING',request_id=$2,last_execution_block=$3,
              submitted_at=now(),updated_at=now() WHERE id=$1 AND strategy_id=$4 AND status='QUEUED'
              AND simulated=false AND request_id IS NULL AND payload_hash=$5 RETURNING id`,
              [intent.id, parts[1], lb, strategyId, intent.payload_hash],
            )
            if (saved.rows.length !== 1) throw new Error('STRATEGY_REFERENCE_PERSIST_FAILED')
            ownedRequest = parts[1]
            ownedExpiry = lb
          } catch (error) {
            throw new PerplPreSubmissionError(
              error instanceof Error ? error.message : 'STRATEGY_REFERENCE_PERSIST_FAILED',
            )
          }
        },
        async () => {
          const verifyIdentity = async () => {
            await this.authorize(userId, binding, intent.market_terms)
            const saved = await current()
            if (
              saved.status !== 'SUBMITTING' ||
              saved.request_id !== ownedRequest ||
              ownedExpiry === null ||
              String(saved.last_execution_block) !== String(ownedExpiry) ||
              saved.payload_hash !== hash(saved.wire_order, saved.market_terms, saved.target_order_id) ||
              saved.payload_hash !== intent.payload_hash
            )
              throw new Error('STRATEGY_INTENT_CHANGED')
            if (
              saved.target_order_id &&
              saved.market_terms.targetIdentity !==
                encodeStrategyOrderIdentity(
                  await this.targetIdentity(binding, saved.target_order_id, saved.market_terms),
                )
            )
              throw new Error('STRATEGY_ORDER_TARGET_INVALID')
            return saved
          }
          const saved = await verifyIdentity()
          await this.verifyBeforeSend(saved)
          // Admission may await fresh RPC data. Revocation or kill during that
          // wait must prevent the frame, rather than using earlier permission.
          await verifyIdentity()
        },
      )
      // ACK and mt:24 alone cannot prove receipt-backed execution. Recovery owns final states.
      await this.store.pool.query(
        `UPDATE strategy_orders SET status=$2,venue_progress=$3,error=$4,updated_at=now()
          WHERE id=$1 AND status='SUBMITTING' AND payload_hash=$5 AND request_id IS NOT DISTINCT FROM $6::numeric`,
        [
          intent.id,
          'UNKNOWN', // A failed mt:24 is not proof that this request never executed.
          result.venueProgress ? JSON.stringify(result.venueProgress) : null,
          result.reason ?? null,
          intent.payload_hash,
          ownedRequest,
        ],
      )
    } catch (error) {
      await this.store.pool.query(
        `UPDATE strategy_orders SET status=$2,error=$3,updated_at=now()
          WHERE id=$1 AND status IN ('QUEUED','SUBMITTING') AND payload_hash=$4
            AND request_id IS NOT DISTINCT FROM $5::numeric`,
        [
          intent.id,
          error instanceof PerplPreSubmissionError ? 'FAILED' : 'UNKNOWN',
          error instanceof Error ? error.message : 'STRATEGY_SUBMISSION_AMBIGUOUS',
          intent.payload_hash,
          ownedRequest,
        ],
      )
      // A durable request survives ambiguity; repeated callers never dispatch it again.
    }
    return current()
  }
}
