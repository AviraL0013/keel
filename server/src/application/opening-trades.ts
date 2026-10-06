import { createHash, randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import { previewOpeningTrade, type OpeningInput } from '../../../packages/perpl/src/opening-preview.js'
import { assertOpeningReserveCoverage } from './opening-reserves.js'
import type { PostgresStore } from '../infrastructure/database/postgres-store.js'
import type { RuntimeVenue } from '../runtime.js'
import { AuthorizationError, ConflictError, InfrastructureError, NotFoundError, ValidationError } from './errors.js'

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
    const now = this.now()
    const snapshot = await venue.openingMarketSnapshot(input.marketId)
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
    if (existing.rows[0]) return existing.rows[0]
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
    const snapshot = await venue.openingMarketSnapshot(row.market_id)
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
      now,
    )
    if (current.sizeRaw !== old.sizeRaw || current.leverageHundredths !== old.leverageHundredths)
      throw new ConflictError('PREVIEW_STALE')
    if (new Decimal(current.estimatedRequiredBalance).gt(old.estimatedRequiredBalance))
      throw new ConflictError('PREVIEW_STALE')
    const reserves = await this.store.pool.query<{ available: string }>(
      `SELECT r.available::text AS available FROM reserves r JOIN books b ON b.id=r.book_id
       WHERE b.user_id=$1 AND b.venue_account_id=$2 AND b.status<>'CLOSED'`,
      [userId, venue.accountId],
    )
    assertOpeningReserveCoverage(
      snapshot.freeBalance,
      old.estimatedRequiredBalance,
      reserves.rows.map((item) => item.available),
    )
    const fee = new Decimal(old.estimatedTradingFee).plus(old.recycleFee).toFixed(6)
    try {
      const inserted = await this.store.pool.query(
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
      return inserted.rows[0]
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error
      const duplicate = await this.store.pool.query(
        'SELECT * FROM opening_orders WHERE user_id=$1 AND idempotency_key=$2',
        [userId, idempotencyKey],
      )
      if (duplicate.rows[0]) return duplicate.rows[0]
      throw new ConflictError('OPENING_ALREADY_UNRESOLVED')
    }
  }
}
