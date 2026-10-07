import { createHash, randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import { previewOpeningTrade, type OpeningInput } from '../../../packages/perpl/src/opening-preview.js'
import { PerplPreSubmissionError } from '../../../packages/perpl/src/trading.js'
import { requestId } from '../../../packages/perpl/src/request-id.js'
import { assertOpeningReserveCoverage } from './opening-reserves.js'
import type { PostgresStore } from '../infrastructure/database/postgres-store.js'
import type { RuntimeVenue } from '../runtime.js'
import { AuthorizationError, ConflictError, InfrastructureError, NotFoundError, ValidationError } from './errors.js'
import { assertAccountCapitalCoverage, withAccountCapital } from '../infrastructure/capital/admission.js'

export type OpeningPreviewInput = OpeningInput & { marketId: number }
type Options = { enabled: boolean; executionDisabled: boolean; previewTtlMs?: number }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function parametersHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** All private venue access remains under PerplUserVenues' worker-lock ownership. */
export class OpeningTrades {
  constructor(
    private readonly store: PostgresStore,
    private readonly venues: RuntimeVenue | undefined,
    private readonly environment: 'testnet' | 'mainnet',
    private readonly options: Options,
    private readonly now: () => number = Date.now,
  ) {
    const ttl = options.previewTtlMs ?? 15_000
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 60_000) throw new Error('INVALID_OPENING_PREVIEW_TTL_MS')
  }

  private assertEnabled() {
    if (!this.options.enabled || this.options.executionDisabled) throw new AuthorizationError('OPENING_DISABLED')
  }

  private async venue(userId: string, connectionId?: string) {
    const venue = await this.venues?.forUser?.(userId, connectionId)
    if (
      !venue?.ready() ||
      !venue.connectionId ||
      !venue.accountId ||
      (connectionId && venue.connectionId !== connectionId)
    )
      throw new InfrastructureError('PERPL_CONNECTION_UNAVAILABLE')
    const connection = await this.store.pool.query(
      `SELECT 1 FROM perpl_connections c JOIN users u ON u.id=c.user_id
       JOIN perpl_accounts a ON a.connection_id=c.id
       WHERE c.id=$1 AND c.user_id=$2 AND c.environment=$3 AND a.account_id=$4
       AND c.status='ACTIVE' AND c.revoked_at IS NULL AND c.expires_at>now()
       AND c.scope_mask=3 AND lower(c.wallet_address)=u.wallet_address
       AND a.forwarding IS TRUE AND a.frozen IS FALSE LIMIT 1`,
      [venue.connectionId, userId, this.environment, venue.accountId],
    )
    if (!connection.rows.length) throw new InfrastructureError('PERPL_CONNECTION_UNAVAILABLE')
    return venue
  }

  async preview(userId: string, input: OpeningPreviewInput) {
    this.assertEnabled()
    if (!Number.isSafeInteger(input?.marketId) || input.marketId <= 0) throw new ValidationError('PERPL_MARKET_INVALID')
    const venue = await this.venue(userId)
    if (!venue.openingMarketSnapshot) throw new InfrastructureError('PERPL_MARKET_UNAVAILABLE')
    const snapshot = await venue.openingMarketSnapshot(input.marketId)
    const now = this.now()
    if (
      snapshot.environment !== this.environment ||
      snapshot.accountId !== venue.accountId ||
      snapshot.marketId !== input.marketId
    )
      throw new InfrastructureError('PERPL_MARKET_UNAVAILABLE')
    const quote = previewOpeningTrade(input, snapshot, now, this.options.previewTtlMs ?? 15_000)
    const connectionId = venue.connectionId!
    const parameters = {
      userId,
      connectionId,
      environment: this.environment,
      accountId: venue.accountId!,
      marketId: input.marketId,
      side: quote.side,
      size: quote.size,
      leverage: quote.leverage,
      slippageBps: quote.slippageBps,
      quote,
      marketTerms: {
        priceDecimals: snapshot.priceDecimals,
        sizeDecimals: snapshot.sizeDecimals,
        collateralDecimals: snapshot.collateralDecimals,
        initialMarginBps: snapshot.initialMarginBps,
        takerFeeMicros: snapshot.takerFeeMicros,
        minimumNotionalRaw: snapshot.minimumNotionalRaw,
        recycleFeeRaw: snapshot.recycleFeeRaw,
        orderTtlBlocks: snapshot.orderTtlBlocks,
      },
    }
    const parameterHash = parametersHash(parameters)
    const id = randomUUID()
    const expiresAt = now + (this.options.previewTtlMs ?? 15_000)
    await this.store.pool.query(
      `INSERT INTO opening_previews
       (id,user_id,connection_id,environment,account_id,market_id,parameters,parameter_hash,quote,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0))`,
      [
        id,
        userId,
        connectionId,
        this.environment,
        venue.accountId,
        input.marketId,
        JSON.stringify(parameters),
        parameterHash,
        JSON.stringify(quote),
        expiresAt,
      ],
    )
    return { id, connectionId, accountId: venue.accountId, expiresAt, quote }
  }

  /** Admission only; it persists a user-owned intent but never writes to a venue socket. */
  async prepareConfirmation(userId: string, previewId: string, idempotencyKey: string) {
    this.assertEnabled()
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuid.test(previewId)) throw new NotFoundError('OPENING_PREVIEW_NOT_FOUND')
    if (!uuid.test(idempotencyKey)) throw new ValidationError('OPENING_IDEMPOTENCY_KEY_INVALID')
    const found = await this.store.pool.query<{
      connection_id: string
      environment: string
      account_id: string
      market_id: number
      parameters: Record<string, unknown>
      parameter_hash: string
      quote: ReturnType<typeof previewOpeningTrade>
      expires_at: Date
    }>(
      'SELECT connection_id,environment,account_id,market_id,parameters,parameter_hash,quote,expires_at FROM opening_previews WHERE id=$1 AND user_id=$2',
      [previewId, userId],
    )
    const row = found.rows[0]
    if (!row) throw new NotFoundError('OPENING_PREVIEW_NOT_FOUND')
    const existing = await this.store.pool.query(
      'SELECT * FROM opening_orders WHERE user_id=$1 AND idempotency_key=$2',
      [userId, idempotencyKey],
    )
    if (existing.rows[0]) return { ...existing.rows[0], createdNow: false }
    const now = this.now()
    if (
      new Date(row.expires_at).getTime() <= now ||
      row.environment !== this.environment ||
      parametersHash(row.parameters) !== row.parameter_hash ||
      canonicalJson(row.quote) !== canonicalJson(row.parameters.quote)
    )
      throw new ConflictError('PREVIEW_STALE')
    const old = row.quote
    const parameters = row.parameters
    const venue = await this.venue(userId, row.connection_id)
    if (
      venue.accountId !== Number(row.account_id) ||
      old.accountId !== venue.accountId ||
      old.marketId !== row.market_id ||
      parameters.userId !== userId ||
      parameters.connectionId !== row.connection_id
    )
      throw new NotFoundError('OPENING_PREVIEW_NOT_FOUND')
    if (!venue.openingMarketSnapshot) throw new InfrastructureError('PERPL_MARKET_UNAVAILABLE')
    try {
      return await withAccountCapital(
        this.store.pool,
        { userId, connectionId: row.connection_id, accountId: venue.accountId!, environment: this.environment },
        async (client, binding) => {
          const duplicate = await client.query('SELECT * FROM opening_orders WHERE user_id=$1 AND idempotency_key=$2', [
            userId,
            idempotencyKey,
          ])
          if (duplicate.rows[0]) return { ...duplicate.rows[0], createdNow: false }
          if (new Date(row.expires_at).getTime() <= this.now()) throw new ConflictError('PREVIEW_STALE')
          const snapshot = await venue.openingMarketSnapshot!(row.market_id, client)
          if (
            snapshot.environment !== this.environment ||
            snapshot.accountId !== venue.accountId ||
            snapshot.marketId !== row.market_id
          )
            throw new ConflictError('PREVIEW_STALE')
          const oldTerms = parameters.marketTerms as Record<string, unknown> | undefined
          if (
            !oldTerms ||
            Object.entries(oldTerms).some(([key, value]) => snapshot[key as keyof typeof snapshot] !== value) ||
            snapshot.collateralDecimals !== 6
          )
            throw new ConflictError('PREVIEW_STALE')
          if (
            (old.side === 'LONG' && snapshot.askRaw > old.limitPriceRaw) ||
            (old.side === 'SHORT' && snapshot.bidRaw < old.limitPriceRaw)
          )
            throw new ConflictError('PREVIEW_STALE')
          const nextLb = snapshot.headBlock + snapshot.orderTtlBlocks
          if (!Number.isSafeInteger(nextLb) || nextLb <= snapshot.headBlock)
            throw new InfrastructureError('PERPL_ORDER_EXPIRY_UNAVAILABLE')
          const current = previewOpeningTrade(
            { side: old.side, size: old.size, leverage: old.leverage, slippageBps: old.slippageBps },
            snapshot,
            this.now(),
          )
          if (current.sizeRaw !== old.sizeRaw || current.leverageHundredths !== old.leverageHundredths)
            throw new ConflictError('PREVIEW_STALE')
          if (new Decimal(current.estimatedRequiredBalance).gt(old.estimatedRequiredBalance))
            throw new ConflictError('PREVIEW_STALE')
          const reserves = await client.query<{ available: string }>(
            `SELECT r.available::text AS available FROM reserves r JOIN books b ON b.id=r.book_id
       LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id
       WHERE b.user_id=$1 AND b.venue_account_id=$2 AND b.status<>'CLOSED' AND (c.environment=$3 OR c.id IS NULL)`,
            [userId, venue.accountId, this.environment],
          )
          assertOpeningReserveCoverage(
            snapshot.freeBalance,
            old.estimatedRequiredBalance,
            reserves.rows.map((item) => item.available),
          )
          await assertAccountCapitalCoverage(
            client,
            binding,
            {
              environment: snapshot.environment,
              accountId: snapshot.accountId,
              free: snapshot.freeBalance,
              observedAt: snapshot.balanceObservedAt,
              observedBlock: snapshot.balanceBlock!,
            },
            old.estimatedRequiredBalance,
            undefined,
            this.now(),
          )
          if (new Date(row.expires_at).getTime() <= this.now()) throw new ConflictError('PREVIEW_STALE')
          const fee = new Decimal(old.estimatedTradingFee).plus(old.recycleFee).toFixed(6)
          const inserted = await client.query(
            `INSERT INTO opening_orders
         (user_id,connection_id,environment,account_id,market_id,side,size,price_limit,leverage,collateral,fees,preview_id,idempotency_key,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'QUEUED') RETURNING *`,
            [
              userId,
              row.connection_id,
              this.environment,
              venue.accountId,
              row.market_id,
              old.side,
              old.size,
              old.limitPrice,
              old.leverage,
              old.estimatedMargin,
              fee,
              previewId,
              idempotencyKey,
            ],
          )
          return { ...inserted.rows[0], createdNow: true }
        },
      )
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error
      const duplicate = await this.store.pool.query(
        'SELECT * FROM opening_orders WHERE user_id=$1 AND idempotency_key=$2',
        [userId, idempotencyKey],
      )
      if (duplicate.rows[0]) return { ...duplicate.rows[0], createdNow: false }
      throw new ConflictError('OPENING_ALREADY_UNRESOLVED')
    }
  }

  async confirm(userId: string, previewId: string, idempotencyKey: string) {
    const intent = await this.prepareConfirmation(userId, previewId, idempotencyKey)
    // Persisted intent owns the idempotency key. A repeat never reaches the socket.
    if (!intent.createdNow) return intent
    const current = async () => {
      const result = await this.store.pool.query('SELECT * FROM opening_orders WHERE id=$1 AND user_id=$2', [
        intent.id,
        userId,
      ])
      return result.rows[0]
    }
    let referencePersisted = false
    try {
      const venue = await this.venue(userId, intent.connection_id)
      if (!venue.submitOpening) throw new InfrastructureError('PERPL_OPENING_UNAVAILABLE')
      const preview = await this.store.pool.query<{
        quote: ReturnType<typeof previewOpeningTrade>
        parameters: { marketTerms?: Record<string, unknown> }
        expires_at: Date
      }>('SELECT quote,parameters,expires_at FROM opening_previews WHERE id=$1 AND user_id=$2', [previewId, userId])
      const quote = preview.rows[0]?.quote
      if (!quote || quote.accountId !== venue.accountId) throw new NotFoundError('OPENING_PREVIEW_NOT_FOUND')
      const order = {
        mkt: quote.marketId,
        acc: quote.accountId,
        t: quote.side === 'LONG' ? 1 : 2,
        s: quote.sizeRaw,
        p: quote.limitPriceRaw,
        lv: quote.leverageHundredths,
        orderTtlBlocks: quote.orderTtlBlocks,
      }
      const result = await venue.submitOpening(
        intent.id,
        order,
        async (reference, lb) => {
          const [account, rq] = reference.split(':')
          if (
            Number(account) !== venue.accountId ||
            !rq ||
            requestId(rq) === 0n ||
            !Number.isSafeInteger(lb) ||
            lb <= 0
          )
            throw new Error('PERPL_OPENING_REFERENCE_INVALID')
          const updated = await this.store.pool.query(
            `UPDATE opening_orders SET status='SUBMITTING',request_id=$2,lb=$3,submitted_at=now(),updated_at=now()
             WHERE id=$1 AND user_id=$4 AND status='QUEUED' AND request_id IS NULL RETURNING id`,
            [intent.id, rq, lb, userId],
          )
          if (updated.rows.length !== 1) throw new Error('PERPL_OPENING_REFERENCE_PERSIST_FAILED')
          referencePersisted = true
        },
        async () => {
          const authorized = await this.venue(userId, intent.connection_id)
          if (!authorized.openingMarketSnapshot || authorized.accountId !== venue.accountId)
            throw new Error('PERPL_CONNECTION_UNAVAILABLE')
          return withAccountCapital(
            this.store.pool,
            { userId, connectionId: intent.connection_id, accountId: venue.accountId!, environment: this.environment },
            async (client, binding) => {
              if (!preview.rows[0] || new Date(preview.rows[0].expires_at).getTime() <= this.now())
                throw new Error('PREVIEW_STALE')
              const snapshot = await authorized.openingMarketSnapshot!(quote.marketId, client)
              const originalTerms = preview.rows[0]?.parameters.marketTerms
              if (
                snapshot.environment !== this.environment ||
                snapshot.accountId !== quote.accountId ||
                !originalTerms ||
                Object.entries(originalTerms).some(
                  ([key, value]) => snapshot[key as keyof typeof snapshot] !== value,
                ) ||
                snapshot.collateralDecimals !== 6 ||
                (quote.side === 'LONG' && snapshot.askRaw > quote.limitPriceRaw) ||
                (quote.side === 'SHORT' && snapshot.bidRaw < quote.limitPriceRaw)
              )
                throw new Error('PREVIEW_STALE')
              const pending = (
                await client.query('SELECT * FROM opening_orders WHERE id=$1 AND user_id=$2', [intent.id, userId])
              ).rows[0]
              if (
                !pending ||
                pending.status !== 'SUBMITTING' ||
                snapshot.headBlock >= Number(pending.lb) ||
                Number(pending.lb) > snapshot.headBlock + snapshot.orderTtlBlocks
              )
                throw new Error('PREVIEW_STALE')
              const updated = previewOpeningTrade(
                { side: quote.side, size: quote.size, leverage: quote.leverage, slippageBps: quote.slippageBps },
                snapshot,
                this.now(),
              )
              if (
                updated.sizeRaw !== quote.sizeRaw ||
                new Decimal(updated.estimatedRequiredBalance).gt(quote.estimatedRequiredBalance)
              )
                throw new Error('PREVIEW_STALE')
              const reserves = await client.query<{ available: string }>(
                `SELECT r.available::text AS available FROM reserves r JOIN books b ON b.id=r.book_id
             LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id
             WHERE b.user_id=$1 AND b.venue_account_id=$2 AND b.status<>'CLOSED' AND (c.environment=$3 OR c.id IS NULL)`,
                [userId, venue.accountId, this.environment],
              )
              assertOpeningReserveCoverage(
                snapshot.freeBalance,
                quote.estimatedRequiredBalance,
                reserves.rows.map((item) => item.available),
              )
              await assertAccountCapitalCoverage(
                client,
                binding,
                {
                  environment: snapshot.environment,
                  accountId: snapshot.accountId,
                  free: snapshot.freeBalance,
                  observedAt: snapshot.balanceObservedAt,
                  observedBlock: snapshot.balanceBlock!,
                },
                quote.estimatedRequiredBalance,
                intent.id,
                this.now(),
              )
              if (new Date(preview.rows[0].expires_at).getTime() <= this.now()) throw new Error('PREVIEW_STALE')
            },
          )
        },
      )
      await this.store.pool.query(
        `UPDATE opening_orders SET status=$2,venue_progress=$3,error=$4,updated_at=now(),
         resolved_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END WHERE id=$1 AND status='SUBMITTING'`,
        [
          intent.id,
          result.status === 'FAILED' ? 'FAILED' : 'VERIFYING',
          result.venueProgress ? JSON.stringify(result.venueProgress) : null,
          result.reason ?? null,
        ],
      )
      return current()
    } catch (error) {
      const status = error instanceof PerplPreSubmissionError ? 'FAILED' : referencePersisted ? 'VERIFYING' : 'UNKNOWN'
      await this.store.pool.query(
        `UPDATE opening_orders SET status=$2,error=$3,updated_at=now(),
         resolved_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END WHERE id=$1 AND status IN ('QUEUED','SUBMITTING')`,
        [intent.id, status, error instanceof Error ? error.message : 'OPENING_SUBMISSION_UNAVAILABLE'],
      )
      return current()
    }
  }

  /** Reconcile persisted request only. Never resubmit after restart or timeout. */
  async reconcile(userId: string, openingId: string) {
    const found = await this.store.pool.query('SELECT * FROM opening_orders WHERE id=$1 AND user_id=$2', [
      openingId,
      userId,
    ])
    const row = found.rows[0]
    if (!row) throw new NotFoundError('OPENING_ORDER_NOT_FOUND')
    if (['CONFIRMED', 'PARTIAL', 'FAILED'].includes(row.status)) return row
    if (!row.request_id || !row.lb || !row.submitted_at) {
      // No reference means no socket write was allowed by the beforeSend hook.
      // A fresh QUEUED row may belong to an in-flight confirmation; do not race it.
      if (this.now() - new Date(row.created_at).getTime() < 180_000) return row
      await this.store.pool.query(
        `UPDATE opening_orders SET status='FAILED',error='MISSING_DURABLE_VENUE_REFERENCE',
         resolved_at=now(),updated_at=now()
         WHERE id=$1 AND status IN ('QUEUED','UNKNOWN') AND request_id IS NULL`,
        [openingId],
      )
      return (await this.store.pool.query('SELECT * FROM opening_orders WHERE id=$1', [openingId])).rows[0]
    }
    const venue =
      (await this.venues?.forUser?.(userId, row.connection_id)) ??
      (await this.venues?.recoveryForUser?.(userId, row.connection_id))
    if (!venue?.reconcileOpening || venue.accountId !== Number(row.account_id))
      throw new InfrastructureError('PERPL_RECONCILIATION_UNAVAILABLE')
    const preview = await this.store.pool.query<{ quote: ReturnType<typeof previewOpeningTrade> }>(
      'SELECT quote FROM opening_previews WHERE id=$1 AND user_id=$2',
      [row.preview_id, userId],
    )
    const quote = preview.rows[0]?.quote
    if (!quote || quote.accountId !== venue.accountId || quote.marketId !== row.market_id)
      throw new InfrastructureError('PERPL_OPENING_EVIDENCE_UNAVAILABLE')
    const outcome = await venue.reconcileOpening({
      accountId: venue.accountId,
      marketId: row.market_id,
      requestId: String(row.request_id),
      lastExecutionBlock: Number(row.lb),
      side: row.side,
      sizeRaw: quote.sizeRaw,
      priceLimitRaw: quote.limitPriceRaw,
      leverageHundredths: quote.leverageHundredths,
      sizeDecimals: quote.size.split('.')[1]?.length ?? 0,
      priceDecimals: quote.limitPrice.split('.')[1]?.length ?? 0,
      submittedAt: new Date(row.submitted_at).getTime(),
    })
    await this.store.pool.query(
      `UPDATE opening_orders SET status=$2,error=$3,evidence=$4,filled_size=$5,average_price=$6,
       position_id=$7,tx_hash=$8,updated_at=now(),
       resolved_at=CASE WHEN $2 IN ('CONFIRMED','PARTIAL','FAILED') THEN now() ELSE NULL END
       WHERE id=$1 AND status IN ('SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN')`,
      [
        openingId,
        outcome.status,
        outcome.error ?? null,
        outcome.evidence ? JSON.stringify(outcome.evidence) : null,
        outcome.filledSize ?? null,
        outcome.averagePrice ?? null,
        outcome.positionId ?? null,
        outcome.txHash ?? null,
      ],
    )
    return (await this.store.pool.query('SELECT * FROM opening_orders WHERE id=$1', [openingId])).rows[0]
  }

  async reconcilePending() {
    const rows = await this.store.pool.query<{ id: string; user_id: string }>(
      `SELECT id,user_id FROM opening_orders WHERE status IN ('QUEUED','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN')
       ORDER BY created_at LIMIT 20`,
    )
    for (const row of rows.rows) {
      try {
        await this.reconcile(row.user_id, row.id)
      } catch {
        /* Evidence may be unavailable; keep persisted request for the next pass. */
      }
    }
  }
}
