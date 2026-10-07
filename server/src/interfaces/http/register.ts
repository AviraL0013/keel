import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isAddress } from 'viem'
import type { Config } from '../../config/index.js'
import { executionDisabled as isExecutionDisabled, logger } from '../../config/index.js'
import type { Book, CapitalSnapshot } from '../../../../packages/domain/src/index.js'
import { buildTelemetryFreshness } from '../../../../packages/domain/src/index.js'
import {
  AuthenticationError,
  AuthorizationError,
  InfrastructureError,
  NotFoundError,
  ValidationError,
} from '../../application/errors.js'
import { evaluateBookSnapshot } from '../../application/book-risk.js'
import { PostgresExecutionRepository } from '../../infrastructure/database/execution-repository.js'
import { BooksApplication, type CreateBookCommand } from '../../application/books.js'
import type { Store } from '../../infrastructure/database/postgres-store.js'
import { PostgresStore } from '../../infrastructure/database/postgres-store.js'
import { MemoryStore } from '../../memoryStore.js'
import type { AuthService } from '../../auth.js'
import type { NotificationStore } from '../../infrastructure/database/notification-store.js'
import type { EyelerRuntime, RuntimeVenue } from '../../runtime.js'
import { resolveRuntimeVenue } from '../../runtime.js'
import type { DeterministicTestRuntime } from '../../infrastructure/replay/test-runtime.js'
import type { PerplEnrollmentService } from '../../infrastructure/perpl/enrollment-service.js'
import type { TelegramLinks } from '../../infrastructure/telegram/links.js'
import { toBookDto } from './dto.js'
import { OpeningTrades, type OpeningPreviewInput } from '../../application/opening-trades.js'
import { registerAnalyticsRoutes } from './routes/analytics.js'
import {
  toActionDto,
  toAutopsyDto,
  toBookRiskDto,
  toDecisionDto,
  toExecutionSummaryDto,
  toNotificationDto,
  toPositionDto,
  toReserveDto,
  toRiskDto,
  toTelemetryDto,
} from './mappers.js'

export type HttpContext = {
  app: FastifyInstance
  config: Config
  persistence: Store
  auth: AuthService
  notificationStore: NotificationStore | null
  venue?: RuntimeVenue
  runtime?: EyelerRuntime
  closeBook?: (userId: string, bookId: string) => Promise<{ actionId: string; status: string }>
  executeAction?: (
    userId: string,
    bookId: string,
    kind: 'DEFEND' | 'REDUCE',
  ) => Promise<{ actionId: string; status: string }>
  testRuntime?: DeterministicTestRuntime
  enrollment?: PerplEnrollmentService
  telegramLinks?: TelegramLinks
  publicCapital?: (wallet: string, userId: string) => Promise<CapitalSnapshot>
}

type Session = { userId: string; walletAddress: string; expiresAt: number }
type RequestWithSession = FastifyRequest & { user?: Session }

export function registerRoutes(context: HttpContext) {
  const { app, config, persistence, auth, notificationStore } = context
  if (process.env.EYELER_ANALYTICS_ENABLED === 'true')
    registerAnalyticsRoutes(app, persistence instanceof PostgresStore ? persistence.pool : null)
  const books = new BooksApplication(persistence, context.venue)
  const authToken = (request: FastifyRequest) => {
    const bearer = request.headers.authorization
    return (
      (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined) ??
      request.cookies.eyeler_session ??
      request.cookies.keel_session
    )
  }
  const session = async (request: FastifyRequest): Promise<Session | null> => {
    const token = authToken(request)
    return token ? auth.get(token) : null
  }
  const requireSession = async (request: FastifyRequest) => {
    const current = await session(request)
    if (!current) throw new AuthenticationError()
    return current
  }
  const openingVenue = async (request: FastifyRequest) => {
    const current = await requireSession(request)
    if (!config.openingEnabled || config.perplAccountMode !== 'per-user' || isExecutionDisabled(process.env))
      throw new AuthorizationError('OPENING_DISABLED')
    const venue = await context.venue?.forUser?.(current.userId)
    if (!venue?.ready() || !venue.connectionId || !venue.accountId)
      throw new InfrastructureError('PERPL_CONNECTION_UNAVAILABLE')
    return venue
  }
  app.get('/openings/markets', async (request) => {
    const venue = await openingVenue(request)
    if (!venue.listOpeningMarkets) throw new InfrastructureError('PERPL_MARKET_UNAVAILABLE')
    return venue.listOpeningMarkets()
  })
  app.get<{ Params: { id: string } }>('/openings/markets/:id/snapshot', async (request) => {
    const venue = await openingVenue(request)
    const marketId = Number(request.params.id)
    if (!Number.isSafeInteger(marketId) || marketId <= 0) throw new ValidationError('PERPL_MARKET_INVALID')
    if (!venue.openingMarketSnapshot) throw new InfrastructureError('PERPL_MARKET_UNAVAILABLE')
    return venue.openingMarketSnapshot(marketId)
  })
  app.post<{ Body: OpeningPreviewInput }>('/openings/previews', async (request) => {
    const current = await requireSession(request)
    if (!config.openingEnabled || config.perplAccountMode !== 'per-user' || isExecutionDisabled(process.env))
      throw new AuthorizationError('OPENING_DISABLED')
    if (!(persistence instanceof PostgresStore)) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    const previewTtlMs = Number(process.env.EYELER_OPENING_PREVIEW_TTL_MS ?? 15_000)
    return new OpeningTrades(persistence, context.venue, config.environment === 'mainnet' ? 'mainnet' : 'testnet', {
      enabled: true,
      executionDisabled: isExecutionDisabled(process.env),
      previewTtlMs,
    }).preview(current.userId, request.body)
  })
  app.post<{ Body: { previewId: string; idempotencyKey: string } }>('/openings/confirm', async (request) => {
    const current = await requireSession(request)
    if (!config.openingEnabled || config.perplAccountMode !== 'per-user' || isExecutionDisabled(process.env))
      throw new AuthorizationError('OPENING_DISABLED')
    if (!(persistence instanceof PostgresStore)) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    const service = new OpeningTrades(
      persistence,
      context.venue,
      config.environment === 'mainnet' ? 'mainnet' : 'testnet',
      {
        enabled: true,
        executionDisabled: isExecutionDisabled(process.env),
        previewTtlMs: Number(process.env.EYELER_OPENING_PREVIEW_TTL_MS ?? 15_000),
      },
    )
    return service.confirm(current.userId, request.body?.previewId, request.body?.idempotencyKey)
  })
  app.get<{ Params: { id: string } }>('/openings/:id', async (request) => {
    const current = await requireSession(request)
    if (!(persistence instanceof PostgresStore)) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    const found = await persistence.pool.query('SELECT * FROM opening_orders WHERE id=$1 AND user_id=$2', [
      request.params.id,
      current.userId,
    ])
    if (!found.rows[0]) throw new NotFoundError('OPENING_ORDER_NOT_FOUND')
    return found.rows[0]
  })
  app.get('/', async () => ({
    name: 'EYELER API',
    environment: config.environment,
    status: 'online',
    endpoints: { health: '/health', ready: '/ready', metrics: '/metrics' },
  }))
  app.get('/health', async () => ({ ok: true, environment: config.environment }))
  app.get('/ready', async (_request, reply) => {
    const health = context.runtime?.health()
    const detail = {
      lastTickAgeMs: health?.lastTickAgeMs ?? null,
      venueReady: health?.venueReady ?? false,
      lockOwned: health?.lockOwned ?? false,
      executionDisabled: isExecutionDisabled(process.env),
    }
    if (!(persistence instanceof PostgresStore))
      return reply.code(503).send({ ready: false, reason: 'DATABASE_NOT_CONFIGURED', ...detail })
    try {
      await persistence.pool.query('SELECT 1')
      if (health?.waitingForLock)
        return reply.code(503).send({ ready: false, reason: 'WAITING_FOR_LOCK', ...detail, worker: health })
      if (!health?.executionReady || !health.running)
        return reply.code(503).send({ ready: false, reason: 'WORKER_OR_VENUE_UNAVAILABLE', ...detail, worker: health })
      if (detail.lastTickAgeMs !== null && detail.lastTickAgeMs > config.tickStaleMs)
        return reply.code(503).send({ ready: false, reason: 'MONITOR_TICK_STALE', ...detail })
      return { ready: true, ...detail }
    } catch {
      return reply.code(503).send({ ready: false, reason: 'DATABASE_UNAVAILABLE', ...detail })
    }
  })
  app.get('/metrics', async () => ({
    books: 'database-backed',
    worker: context.runtime?.health() ?? { running: false, executionReady: false },
    environment: config.environment,
  }))
  app.get('/connections/telegram', async (request) => {
    const current = await requireSession(request)
    return context.telegramLinks?.status(current.userId) ?? { status: 'UNAVAILABLE', reason: 'TELEGRAM_NOT_CONFIGURED' }
  })
  app.post(
    '/connections/telegram/link',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      const current = await requireSession(request)
      if (!context.telegramLinks) throw new InfrastructureError('TELEGRAM_NOT_CONFIGURED')
      return context.telegramLinks.start(current.userId)
    },
  )
  app.post('/connections/telegram/unlink', async (request) => {
    const current = await requireSession(request)
    if (!context.telegramLinks) throw new InfrastructureError('TELEGRAM_NOT_CONFIGURED')
    await context.telegramLinks.unlink(current.userId)
    return { status: 'NOT_LINKED' }
  })
  app.post('/integrations/telegram/webhook', { bodyLimit: 16384 }, async (request) => {
    if (!context.telegramLinks) throw new InfrastructureError('TELEGRAM_NOT_CONFIGURED')
    return context.telegramLinks.handle(request.headers['x-telegram-bot-api-secret-token'], request.body)
  })
  app.post<{ Body: { address: string } }>(
    '/auth/challenge',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['address'],
          additionalProperties: false,
          properties: { address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } },
        },
      },
    },
    async (request) => {
      if (!isAddress(request.body.address)) throw new ValidationError('INVALID_WALLET_ADDRESS')
      return auth.challenge(request.body.address)
    },
  )
  app.post<{ Body: { address: string; nonce: string; message: string; signature: `0x${string}` } }>(
    '/auth/verify',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['address', 'nonce', 'message', 'signature'],
          additionalProperties: false,
          properties: {
            address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
            nonce: { type: 'string', minLength: 1, maxLength: 128 },
            message: { type: 'string', minLength: 1, maxLength: 2048 },
            signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await auth.verify(
        request.body.address,
        request.body.nonce,
        request.body.message,
        request.body.signature,
      )
      reply.setCookie('eyeler_session', result.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ['mainnet', 'testnet'].includes(config.environment),
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
      })
      return { ...result.session, token: result.token }
    },
  )
  app.get('/auth/session', async (request, reply) => {
    const current = await auth.get(authToken(request))
    if (!current) return reply.code(401).send({ error: 'UNAUTHENTICATED' })
    return current
  })
  app.post('/auth/logout', async (request, reply) => {
    const selected = authToken(request)
    await auth.revoke(selected)
    if (request.cookies.eyeler_session && request.cookies.eyeler_session !== selected)
      await auth.revoke(request.cookies.eyeler_session)
    if (request.cookies.keel_session && request.cookies.keel_session !== selected)
      await auth.revoke(request.cookies.keel_session)
    reply.clearCookie('eyeler_session', { path: '/' })
    reply.clearCookie('keel_session', { path: '/' })
    return { ok: true }
  })
  app.post('/auth/logout-all', async (request, reply) => {
    const current = await requireSession(request)
    await auth.revokeAll(current.userId)
    reply.clearCookie('eyeler_session', { path: '/' })
    reply.clearCookie('keel_session', { path: '/' })
    return { ok: true }
  })
  app.addHook('preHandler', async (request, reply) => {
    // Telegram has no browser session. This one route authenticates the webhook secret itself.
    if (request.method === 'POST' && request.routeOptions.url === '/integrations/telegram/webhook') return
    if (
      request.url === '/' ||
      request.url === '/health' ||
      request.url === '/ready' ||
      request.url === '/metrics' ||
      request.url.startsWith('/auth/')
    )
      return
    const current = await session(request)
    if (!current) return reply.code(401).send({ error: 'UNAUTHENTICATED' })
    ;(request as RequestWithSession).user = current
  })

  app.get('/books', async (request) => {
    const userId = (await requireSession(request)).userId
    const listed = await books.list(userId)
    if (context.venue) {
      try {
        if (context.venue.forUser) {
          for (const connectionId of new Set(listed.map((book) => book.perplConnectionId).filter(Boolean))) {
            const bound = listed.filter((book) => book.perplConnectionId === connectionId)
            const venue = await resolveRuntimeVenue(context.venue, userId, bound[0])
            await venue?.syncClosedBooks?.(bound)
          }
        } else await context.venue.syncClosedBooks?.(listed)
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : 'BOOK_CLOSURE_SYNC_FAILED' },
          'Book closure sync deferred',
        )
      }
    }
    return (await books.list(userId)).map(toBookDto)
  })
  app.post<{ Body: CreateBookCommand }>('/books', async (request) => {
    const current = await requireSession(request)
    return toBookDto(await books.create(current.userId, request.body))
  })
  app.get<{ Params: { id: string } }>('/books/:id', async (request) =>
    toBookDto(await books.get((await requireSession(request)).userId, request.params.id)),
  )
  app.patch<{
    Params: { id: string }
    Body: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] }
  }>('/books/:id', async (request) =>
    toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, request.body)),
  )
  app.post<{
    Params: { id: string }
    Body: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] }
  }>('/books/:id/controls', async (request) =>
    toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, request.body)),
  )
  app.patch<{
    Params: { id: string }
    Body: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] }
  }>('/books/:id/controls', async (request) =>
    toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, request.body)),
  )
  app.post<{ Params: { id: string } }>('/books/:id/pause', async (request) =>
    toBookDto(
      await books.controls((await requireSession(request)).userId, request.params.id, {
        automationEnabled: false,
        status: 'PAUSED',
      }),
    ),
  )
  app.post<{ Params: { id: string } }>('/books/:id/arm', async (request) =>
    toBookDto(
      await books.controls((await requireSession(request)).userId, request.params.id, {
        automationEnabled: true,
        status: 'ACTIVE',
      }),
    ),
  )
  app.post<{ Params: { id: string } }>('/books/:id/recover', async (request, reply) => {
    const current = await requireSession(request)
    if (!context.runtime) return reply.code(503).send({ error: 'LIVE_RECOVERY_NOT_CONFIGURED' })
    return toBookDto(await context.runtime.recoverBook(current.userId, request.params.id))
  })
  app.post<{ Params: { id: string } }>('/books/:id/kill', async (request) =>
    toBookDto(
      await books.controls((await requireSession(request)).userId, request.params.id, {
        automationEnabled: false,
        stance: 'KILL',
      }),
    ),
  )
  app.post('/controls/kill-switch', async (request) => {
    const current = await requireSession(request)
    const affectedBooks: string[] = []
    for (const book of await books.list(current.userId)) {
      await books.controls(current.userId, book.id, { automationEnabled: false, stance: 'KILL' })
      affectedBooks.push(book.id)
    }
    return { enabled: true, affectedBooks }
  })
  app.post<{ Params: { id: string } }>('/books/:id/close', async (request, reply) => {
    const current = await requireSession(request)
    if (!context.closeBook)
      return reply.code(503).send({ error: 'LIVE_EXECUTION_NOT_CONFIGURED', positionClosed: false })
    return books.close(current.userId, request.params.id, context.closeBook)
  })
  app.post<{ Params: { id: string }; Body: { kind: 'DEFEND' | 'REDUCE' } }>(
    '/books/:id/actions',
    async (request, reply) => {
      const current = await requireSession(request)
      if (!context.executeAction) return reply.code(503).send({ error: 'LIVE_EXECUTION_NOT_CONFIGURED' })
      if (!['DEFEND', 'REDUCE'].includes(request.body?.kind)) throw new ValidationError('INVALID_ACTION_KIND')
      return context.executeAction(current.userId, request.params.id, request.body.kind)
    },
  )

  app.get<{ Params: { id: string } }>('/books/:id/position', async (request) => {
    const current = await requireSession(request)
    const book = await books.get(current.userId, request.params.id)
    const row = await persistence.getPositionRow(current.userId, request.params.id)
    return row ? toPositionDto(row, book.side) : null
  })
  app.get<{ Params: { id: string } }>('/books/:id/telemetry', async (request) => {
    const current = await requireSession(request)
    await books.get(current.userId, request.params.id)
    const row = await persistence.getTelemetryRow(current.userId, request.params.id)
    return row ? toTelemetryDto(row) : null
  })
  app.get<{ Params: { id: string } }>('/books/:id/risk', async (request) => {
    const current = await requireSession(request)
    await books.get(current.userId, request.params.id)
    const row = await persistence.getRiskRow(current.userId, request.params.id)
    return row ? toRiskDto(row) : null
  })
  app.get<{ Params: { id: string } }>('/books/:id/state', async (request) => {
    const current = await requireSession(request)
    let book = await books.get(current.userId, request.params.id)
    let venue: RuntimeVenue | undefined
    if (context.venue?.refresh) {
      try {
        venue = await resolveRuntimeVenue(context.venue, current.userId, book)
        await venue?.refresh(book)
        book = await books.get(current.userId, request.params.id)
      } catch (error) {
        logger.warn(
          { bookId: book.id, error: error instanceof Error ? error.message : 'VENUE_REFRESH_FAILED' },
          'Book telemetry refresh failed; serving persisted state with its real freshness',
        )
      }
    }
    const [positionRow, telemetryRow, riskRow, actionRows, reserveRow] = await Promise.all([
      persistence.getPositionRow(current.userId, request.params.id),
      persistence.getTelemetryRow(current.userId, request.params.id),
      persistence.getRiskRow(current.userId, request.params.id),
      persistence.listActions(current.userId, request.params.id),
      persistence.getReserve(current.userId, request.params.id),
    ])
    let risk = toBookRiskDto(riskRow)
    const positionUpdatedAt =
      positionRow?.observed_at instanceof Date
        ? positionRow.observed_at.getTime()
        : Date.parse(String(positionRow?.observed_at ?? ''))
    const snapshotUpdatedAt =
      telemetryRow?.timestamp instanceof Date
        ? telemetryRow.timestamp.getTime()
        : Date.parse(String(telemetryRow?.timestamp ?? ''))
    const telemetrySourceRow =
      telemetryRow && !telemetryRow.freshness_detail
        ? {
            ...telemetryRow,
            freshness_detail: Number.isFinite(snapshotUpdatedAt)
              ? buildTelemetryFreshness({
                  marketUpdatedAt: snapshotUpdatedAt,
                  positionUpdatedAt: Number.isFinite(positionUpdatedAt) ? positionUpdatedAt : undefined,
                  fundingUpdatedAt: snapshotUpdatedAt,
                  orderbookUpdatedAt: snapshotUpdatedAt,
                })
              : null,
          }
        : telemetryRow
    const telemetry = telemetrySourceRow ? toTelemetryDto(telemetrySourceRow) : null
    const position = positionRow ? toPositionDto(positionRow, book.side) : null
    const reserve = reserveRow ? toReserveDto(reserveRow as Record<string, unknown>) : null
    const unresolved = actionRows.some(
      (row) =>
        row &&
        typeof row === 'object' &&
        ['QUEUED', 'VALIDATING', 'SUBMITTING', 'SUBMITTED', 'VERIFYING', 'UNKNOWN'].includes(
          String((row as Record<string, unknown>).status),
        ),
    )
    const priorEfficiency =
      persistence instanceof PostgresStore
        ? await new PostgresExecutionRepository(persistence).priorEfficiency(book.id)
        : Infinity
    const decision = evaluateBookSnapshot(
      book,
      position,
      telemetry,
      reserve,
      priorEfficiency,
      !unresolved && (venue?.ready() ?? false),
    )
    if (decision) {
      risk = toBookRiskDto({
        state: decision.state,
        action: decision.action,
        amount: decision.amount,
        reason_codes: decision.reasonCodes,
        human_readable_reasons: decision.humanReadableReasons,
        risk_features: decision.riskFeatures,
        created_at: decision.createdAt,
      })
    } else {
      risk = {
        ...toBookRiskDto(null),
        reasonCode: 'BOOK_INPUTS_UNAVAILABLE',
        reason: 'Current position, telemetry, or reserve is unavailable.',
      }
    }
    if (telemetry && telemetry.liquidationDistance == null && positionRow) {
      const mark = Number(telemetry.mark)
      const liquidation = Number(positionRow.liquidation_price)
      if (Number.isFinite(mark) && mark > 0 && Number.isFinite(liquidation)) {
        telemetry.liquidationDistance =
          ((book.side === 'SHORT' ? liquidation - mark : mark - liquidation) / Math.abs(mark)) * 100
      }
    }
    const action =
      actionRows.length && actionRows[0] && typeof actionRows[0] === 'object'
        ? (actionRows[0] as Record<string, unknown>)
        : null
    return { book: toBookDto(book), position, telemetry, risk, execution: toExecutionSummaryDto(action), reserve }
  })
  app.get<{ Params: { id: string } }>('/books/:id/autopsy', async (request) =>
    (await persistence.listAutopsy((await requireSession(request)).userId, request.params.id)).map((row) =>
      toAutopsyDto(row as Record<string, unknown>),
    ),
  )
  app.get<{ Params: { id: string } }>('/books/:id/decisions', async (request) =>
    (await persistence.listDecisions((await requireSession(request)).userId, request.params.id)).map((row) =>
      toDecisionDto(row as Record<string, unknown>),
    ),
  )
  app.get<{ Params: { id: string } }>('/books/:id/actions', async (request) =>
    (await persistence.listActions((await requireSession(request)).userId, request.params.id)).map((row) =>
      toActionDto(row as Record<string, unknown>),
    ),
  )
  app.get<{ Params: { id: string } }>('/books/:id/reserve', async (request) => {
    const row = await persistence.getReserve((await requireSession(request)).userId, request.params.id)
    return row ? toReserveDto(row as Record<string, unknown>) : null
  })

  app.post('/connections/revoke', async (request) => {
    await persistence.revokeConnection((await requireSession(request)).userId)
    return { ok: true }
  })
  app.get('/connections', async (request) => {
    const current = await requireSession(request)
    if (!(persistence instanceof PostgresStore)) {
      const venue = await resolveRuntimeVenue(context.venue, current.userId)
      return venue
        ? [
            {
              id: 'test-venue',
              environment: 'testnet',
              scope: 'read,trade',
              status: 'VALID',
              walletAddress: current.walletAddress,
            },
          ]
        : []
    }
    await context.enrollment?.cleanupExpired()
    const result = await persistence.pool.query(
      "SELECT id,environment,scope,CASE WHEN status='ACTIVE' AND expires_at<=now() THEN 'EXPIRED' ELSE status END AS status,created_at,revoked_at,wallet_address AS \"walletAddress\",label,expires_at AS \"expiresAt\",public_key AS \"publicKey\",CASE WHEN last_error IN ('ENROLLED_NOT_SAVED','ENROLLMENT_OUTCOME_UNKNOWN') THEN last_error ELSE NULL END AS \"lastError\",CASE WHEN last_error IN ('ENROLLED_NOT_SAVED','ENROLLMENT_OUTCOME_UNKNOWN') THEN CASE WHEN environment='mainnet' THEN 'https://app.perpl.xyz/apikeys' ELSE 'https://testnet.perpl.xyz/apikeys' END ELSE NULL END AS \"perplKeyPageUrl\" FROM perpl_connections WHERE user_id=$1 ORDER BY created_at DESC",
      [current.userId],
    )
    return result.rows
  })
  app.get('/connections/perpl/capabilities', async (request) => {
    await requireSession(request)
    if (config.perplAccountMode !== 'per-user')
      return { status: 'UNAVAILABLE', reason: 'OPERATOR_ACCOUNT_MODE', environment: config.environment }
    return (
      context.enrollment?.capabilities() ?? {
        status: 'UNAVAILABLE',
        reason: 'PERPL_ENROLLMENT_NOT_CONFIGURED',
        environment: config.environment,
      }
    )
  })
  app.get('/connections/perpl/account-state', async (request) => {
    const current = await requireSession(request)
    if (!context.enrollment) return { status: 'NOT_CONNECTED' }
    return context.enrollment.accountState(current.userId, current.walletAddress)
  })
  app.post(
    '/connections/perpl/enrollment',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      const current = await requireSession(request)
      if (!context.enrollment) throw new InfrastructureError('PERPL_ENROLLMENT_NOT_CONFIGURED')
      return context.enrollment.start(current.userId, current.walletAddress)
    },
  )
  app.post<{ Params: { id: string }; Body: { signature?: string } }>(
    '/connections/perpl/enrollment/:id/complete',
    async (request) => {
      const current = await requireSession(request)
      if (!context.enrollment) throw new InfrastructureError('PERPL_ENROLLMENT_NOT_CONFIGURED')
      if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(request.body?.signature ?? ''))
        throw new ValidationError('INVALID_WALLET_SIGNATURE')
      return context.enrollment.complete(
        current.userId,
        current.walletAddress,
        request.params.id,
        request.body.signature!,
      )
    },
  )
  app.post<{ Params: { id: string } }>('/connections/perpl/:id/disconnect', async (request) => {
    const current = await requireSession(request)
    if (!context.enrollment) throw new InfrastructureError('PERPL_ENROLLMENT_NOT_CONFIGURED')
    return context.enrollment.disconnect(current.userId, request.params.id)
  })
  app.post('/connections/perpl/validate', async (request) => {
    const current = await requireSession(request)
    const venue = await resolveRuntimeVenue(context.venue, current.userId)
    if (context.venue?.forUser) {
      if (!venue?.validate) return { status: 'NOT_CONNECTED', connections: [] }
      return {
        status: await venue.validate(),
        connections: [
          { id: venue.connectionId, environment: config.environment, scope: 'read,trade', accountId: venue.accountId },
        ],
      }
    }
    if (!(persistence instanceof PostgresStore)) {
      if (!context.venue?.validate) return { status: 'UNAVAILABLE', connections: [] }
      return {
        status: await context.venue.validate(),
        connections: [
          {
            id: 'test-venue',
            environment: 'testnet',
            scope: 'read,trade',
            status: 'VALID',
            walletAddress: current.walletAddress,
          },
        ],
      }
    }
    const connection = await persistence.pool.query(
      'SELECT id,environment,status FROM perpl_connections WHERE user_id=$1 AND revoked_at IS NULL AND wallet_address IS NULL ORDER BY created_at DESC LIMIT 1',
      [current.userId],
    )
    const expected = config.environment === 'mainnet' ? 'mainnet' : 'testnet'
    if (!connection.rows.length && context.venue?.validate) {
      const outcome = await context.venue.validate()
      return {
        status: outcome,
        connections: [
          {
            id: 'server-perpl',
            environment: expected,
            scope: 'read',
            status: outcome,
            accountId: context.venue.accountId,
          },
        ],
      }
    }
    if (!connection.rows.length) return { status: 'NOT_CONNECTED', connections: [] }
    const outcome =
      connection.rows[0].environment !== expected
        ? 'INVALID'
        : context.venue?.validate
          ? await context.venue.validate()
          : 'UNAVAILABLE'
    const result = await persistence.pool.query(
      'UPDATE perpl_connections SET status=$2 WHERE id=$1 RETURNING id,status',
      [connection.rows[0].id, outcome],
    )
    return { status: result.rows[0]?.status ?? outcome, connections: result.rows }
  })
  app.get('/connections/perpl/positions', async (request) => {
    const current = await requireSession(request)
    const venue = await resolveRuntimeVenue(context.venue, current.userId)
    if (!venue?.listPositions) return { status: 'UNAVAILABLE', reason: 'PERPL_NOT_CONNECTED', positions: [] }
    return { status: 'VALID', positions: await venue.listPositions() }
  })
  app.get('/capital', async (request) => {
    const current = await requireSession(request)
    let venue: RuntimeVenue | undefined
    try {
      venue = await resolveRuntimeVenue(context.venue, current.userId)
    } catch {
      // A disconnected private account must not hide the user's public AUSD balance.
    }
    if (!venue?.capital) {
      if (context.publicCapital) return context.publicCapital(current.walletAddress, current.userId)
      const unavailable = (source: string, reason: string) => ({
        amount: null,
        asset: 'AUSD',
        decimals: 6,
        source,
        availability: 'UNAVAILABLE' as const,
        freshness: 'UNKNOWN' as const,
        reason,
      })
      return {
        status: 'UNAVAILABLE' as const,
        walletAusd: unavailable('MONAD_AUSD', 'VENUE_NOT_CONFIGURED'),
        walletAgoraAusd: unavailable('MONAD_AGORA_AUSD', 'VENUE_NOT_CONFIGURED'),
        perplAvailable: unavailable('PERPL_COLLATERAL', 'VENUE_NOT_CONFIGURED'),
        perplLocked: unavailable('PERPL_COLLATERAL', 'VENUE_NOT_CONFIGURED'),
        bookReserved: unavailable('EYELER_LEDGER', 'VENUE_NOT_CONFIGURED'),
        bookDeployed: unavailable('EYELER_LEDGER', 'VENUE_NOT_CONFIGURED'),
        bookRemaining: unavailable('EYELER_LEDGER', 'VENUE_NOT_CONFIGURED'),
        unreservedCapital: unavailable('EYELER_LEDGER', 'VENUE_NOT_CONFIGURED'),
      }
    }
    return venue.capital(current.walletAddress, current.userId)
  })
  app.get('/capital/agora-activity', async (request) => {
    const current = await requireSession(request)
    const venue = await resolveRuntimeVenue(context.venue, current.userId)
    const cursor = (request.query as { cursor?: unknown }).cursor
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 1024 || cursor.length === 0))
      throw new ValidationError('INVALID_AGORA_CURSOR')
    return (
      venue?.agoraActivity?.(current.walletAddress, cursor as string | undefined) ?? {
        status: 'UNAVAILABLE',
        reason: 'AGORA_NOT_CONNECTED',
        rows: [],
      }
    )
  })
  app.post('/devices', async (request) => {
    const current = await requireSession(request)
    const body = request.body as { pushToken?: string; platform?: string }
    if (!body.pushToken || !['ios', 'android', 'web'].includes(body.platform ?? ''))
      throw new ValidationError('INVALID_DEVICE')
    await persistence.registerDevice(current.userId, body.pushToken, body.platform!)
    return { ok: true }
  })
  app.get('/notifications', async (request) => {
    const current = await requireSession(request)
    if (notificationStore)
      return (await notificationStore.list(current.userId)).map((row) =>
        toNotificationDto(row as Record<string, unknown>),
      )
    if (persistence instanceof MemoryStore)
      return persistence.listNotifications(current.userId).map((row) => toNotificationDto(row))
    return []
  })
  app.post<{ Params: { id: string } }>('/notifications/:id/read', async (request) => {
    const current = await requireSession(request)
    if (notificationStore) await notificationStore.markRead(current.userId, request.params.id)
    else if (persistence instanceof MemoryStore) persistence.markNotificationRead(current.userId, request.params.id)
    return { ok: true }
  })
  app.post<{ Body: { scenario: string } }>('/dev/test-venue/scenario', async (request) => {
    await requireSession(request)
    if (!context.testRuntime || config.environment === 'mainnet')
      throw Object.assign(new Error('TEST_VENUE_NOT_ENABLED'), { statusCode: 404 })
    context.testRuntime.venue.setScenario(request.body.scenario)
    return { ok: true, scenario: request.body.scenario, environment: 'DEV / TEST VENUE' }
  })
  app.setErrorHandler((error, _request, reply) => {
    logger.error({ error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }, 'request failed')
    const typed = error as Error & { statusCode?: number; details?: unknown }
    const rateLimited = error instanceof Error && ['VENUE_HTTP_429', 'PERPL_HISTORY_HTTP_429'].includes(error.message)
    const status = rateLimited ? 503 : error instanceof Error && 'statusCode' in error ? Number(typed.statusCode) : 500
    return reply.code(status).send({
      error: rateLimited ? 'PERPL_RATE_LIMITED' : error instanceof Error ? error.message : 'INTERNAL_ERROR',
      ...(typed.details === undefined ? {} : { details: typed.details }),
    })
  })
}
