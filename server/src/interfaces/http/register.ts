import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isAddress } from 'viem'
import type { Config } from '../../config/index.js'
import { logger } from '../../config/index.js'
import type { Book } from '../../../../packages/domain/src/index.js'
import { buildTelemetryFreshness } from '../../../../packages/domain/src/index.js'
import { AuthenticationError, ValidationError } from '../../application/errors.js'
import { BooksApplication, type CreateBookCommand } from '../../application/books.js'
import type { Store } from '../../infrastructure/database/postgres-store.js'
import { PostgresStore } from '../../infrastructure/database/postgres-store.js'
import { MemoryStore } from '../../memoryStore.js'
import type { AuthService } from '../../auth.js'
import type { NotificationStore } from '../../infrastructure/database/notification-store.js'
import type { KeelRuntime, RuntimeVenue } from '../../runtime.js'
import type { DeterministicTestRuntime } from '../../infrastructure/replay/test-runtime.js'
import { toBookDto } from './dto.js'
import { toActionDto, toAutopsyDto, toBookRiskDto, toDecisionDto, toExecutionSummaryDto, toNotificationDto, toPositionDto, toReserveDto, toRiskDto, toTelemetryDto } from './mappers.js'

export type HttpContext = {
  app: FastifyInstance
  config: Config
  persistence: Store
  auth: AuthService
  notificationStore: NotificationStore | null
  venue?: RuntimeVenue
  runtime?: KeelRuntime
  closeBook?: (userId: string, bookId: string) => Promise<{ actionId: string; status: string }>
  executeAction?: (userId: string, bookId: string, kind: 'DEFEND' | 'REDUCE') => Promise<{ actionId: string; status: string }>
  testRuntime?: DeterministicTestRuntime
}

type Session = { userId: string; walletAddress: string; expiresAt: number }
type RequestWithSession = FastifyRequest & { user?: Session }

export function registerRoutes(context: HttpContext) {
  const { app, config, persistence, auth, notificationStore } = context
  const books = new BooksApplication(persistence, context.venue)
  const session = async (request: FastifyRequest): Promise<Session | null> => {
    const bearer = request.headers.authorization
    const token = request.cookies.keel_session ?? (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined)
    return token ? auth.get(token) : null
  }
  const requireSession = async (request: FastifyRequest) => {
    const current = await session(request)
    if (!current) throw new AuthenticationError()
    return current
  }
  app.get('/', async () => ({ name: 'KEEL API', environment: config.environment, status: 'online', endpoints: { health: '/health', ready: '/ready', metrics: '/metrics' } }))
  app.get('/health', async () => ({ ok: true, environment: config.environment }))
  app.get('/ready', async (_request, reply) => {
    if (!(persistence instanceof PostgresStore)) return reply.code(503).send({ ready: false, reason: 'DATABASE_NOT_CONFIGURED' })
    try {
      await persistence.pool.query('SELECT 1')
      const health = context.runtime?.health()
      if (!health?.executionReady || !health.running) return reply.code(503).send({ ready: false, reason: 'WORKER_OR_VENUE_UNAVAILABLE', worker: health })
      return { ready: true }
    } catch { return reply.code(503).send({ ready: false, reason: 'DATABASE_UNAVAILABLE' }) }
  })
  app.get('/metrics', async () => ({ books: 'database-backed', worker: context.runtime?.health() ?? { running: false, executionReady: false }, environment: config.environment }))
  app.post<{ Body: { address: string } }>('/auth/challenge', async request => { if (!isAddress(request.body.address)) throw new ValidationError('INVALID_WALLET_ADDRESS'); return auth.challenge(request.body.address) })
  app.post<{ Body: { address: string; nonce: string; message: string; signature: `0x${string}` } }>('/auth/verify', async (request, reply) => { const result = await auth.verify(request.body.address, request.body.nonce, request.body.message, request.body.signature); reply.setCookie('keel_session', result.token, { httpOnly: true, sameSite: 'lax', secure: config.environment === 'mainnet', path: '/', maxAge: 7 * 24 * 60 * 60 }); return { ...result.session, token: result.token } })
  app.get('/auth/session', async (request, reply) => { const bearer = request.headers.authorization; const token = request.cookies.keel_session ?? (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined); const current = await auth.get(token); if (!current) return reply.code(401).send({ error: 'UNAUTHENTICATED' }); return current })
  app.post('/auth/logout', async (request, reply) => { const bearer = request.headers.authorization; const token = request.cookies.keel_session ?? (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined); await auth.revoke(token); reply.clearCookie('keel_session', { path: '/' }); return { ok: true } })
  app.addHook('preHandler', async (request, reply) => { if (request.url === '/' || request.url === '/health' || request.url === '/ready' || request.url === '/metrics' || request.url.startsWith('/auth/')) return; const current = await session(request); if (!current) return reply.code(401).send({ error: 'UNAUTHENTICATED' }); (request as RequestWithSession).user = current })

  app.get('/books', async request => (await books.list((await requireSession(request)).userId)).map(toBookDto))
  app.post<{ Body: CreateBookCommand }>('/books', async request => { const current = await requireSession(request); return toBookDto(await books.create(current.userId, request.body)) })
  app.get<{ Params: { id: string } }>('/books/:id', async request => toBookDto(await books.get((await requireSession(request)).userId, request.params.id)))
  app.patch<{ Params: { id: string }; Body: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] } }>('/books/:id', async request => toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, request.body)))
  app.post<{ Params: { id: string }; Body: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] } }>('/books/:id/controls', async request => toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, request.body)))
  app.patch<{ Params: { id: string }; Body: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] } }>('/books/:id/controls', async request => toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, request.body)))
  app.post<{ Params: { id: string } }>('/books/:id/pause', async request => toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, { automationEnabled: false, status: 'PAUSED' })))
  app.post<{ Params: { id: string } }>('/books/:id/arm', async request => toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, { automationEnabled: true, status: 'ACTIVE' })))
  app.post<{ Params: { id: string } }>('/books/:id/kill', async request => toBookDto(await books.controls((await requireSession(request)).userId, request.params.id, { automationEnabled: false, stance: 'KILL' })))
  app.post('/controls/kill-switch', async request => { const current = await requireSession(request); const affectedBooks: string[] = []; for (const book of await books.list(current.userId)) { await books.controls(current.userId, book.id, { automationEnabled: false, stance: 'KILL' }); affectedBooks.push(book.id) } return { enabled: true, affectedBooks } })
  app.post<{ Params: { id: string } }>('/books/:id/close', async (request, reply) => { const current = await requireSession(request); if (!context.closeBook) return reply.code(503).send({ error: 'LIVE_EXECUTION_NOT_CONFIGURED', positionClosed: false }); return books.close(current.userId, request.params.id, context.closeBook) })
  app.post<{ Params: { id: string }; Body: { kind: 'DEFEND' | 'REDUCE' } }>('/books/:id/actions', async (request, reply) => { const current = await requireSession(request); if (!context.executeAction) return reply.code(503).send({ error: 'LIVE_EXECUTION_NOT_CONFIGURED' }); if (!['DEFEND', 'REDUCE'].includes(request.body?.kind)) throw new ValidationError('INVALID_ACTION_KIND'); return context.executeAction(current.userId, request.params.id, request.body.kind) })

  app.get<{ Params: { id: string } }>('/books/:id/position', async request => { const current = await requireSession(request); const book = await books.get(current.userId, request.params.id); const row = await persistence.getPositionRow(current.userId, request.params.id); return row ? toPositionDto(row, book.side) : null })
  app.get<{ Params: { id: string } }>('/books/:id/telemetry', async request => { const current = await requireSession(request); await books.get(current.userId, request.params.id); const row = await persistence.getTelemetryRow(current.userId, request.params.id); return row ? toTelemetryDto(row) : null })
  app.get<{ Params: { id: string } }>('/books/:id/risk', async request => { const current = await requireSession(request); await books.get(current.userId, request.params.id); const row = await persistence.getRiskRow(current.userId, request.params.id); return row ? toRiskDto(row) : null })
  app.get<{ Params: { id: string } }>('/books/:id/state', async request => {
    const current = await requireSession(request)
    const book = await books.get(current.userId, request.params.id)
    const [positionRow, telemetryRow, riskRow, actionRows, reserveRow] = await Promise.all([
      persistence.getPositionRow(current.userId, request.params.id),
      persistence.getTelemetryRow(current.userId, request.params.id),
      persistence.getRiskRow(current.userId, request.params.id),
      persistence.listActions(current.userId, request.params.id),
      persistence.getReserve(current.userId, request.params.id),
    ])
    const risk = toBookRiskDto(riskRow)
    const positionUpdatedAt = positionRow?.observed_at instanceof Date ? positionRow.observed_at.getTime() : Date.parse(String(positionRow?.observed_at ?? ''))
    const snapshotUpdatedAt = telemetryRow?.timestamp instanceof Date ? telemetryRow.timestamp.getTime() : Date.parse(String(telemetryRow?.timestamp ?? ''))
    const telemetrySourceRow = telemetryRow && !telemetryRow.freshness_detail
      ? { ...telemetryRow, freshness_detail: Number.isFinite(snapshotUpdatedAt) ? buildTelemetryFreshness({ marketUpdatedAt: snapshotUpdatedAt, positionUpdatedAt: Number.isFinite(positionUpdatedAt) ? positionUpdatedAt : undefined, fundingUpdatedAt: snapshotUpdatedAt, orderbookUpdatedAt: snapshotUpdatedAt }) : null }
      : telemetryRow
    const telemetry = telemetrySourceRow ? toTelemetryDto(telemetrySourceRow) : null
    if (telemetry && risk.riskFeatures && typeof risk.riskFeatures === 'object') {
      const distance = (risk.riskFeatures as Record<string, unknown>).liquidationDistance
      telemetry.liquidationDistance = distance == null ? null : Number(distance)
    }
    if (telemetry && telemetry.liquidationDistance == null && positionRow) {
      const mark = Number(telemetry.mark)
      const liquidation = Number(positionRow.liquidation_price)
      if (Number.isFinite(mark) && mark > 0 && Number.isFinite(liquidation)) {
        telemetry.liquidationDistance = (book.side === 'SHORT' ? liquidation - mark : mark - liquidation) / Math.abs(mark) * 100
      }
    }
    const action = actionRows.length && actionRows[0] && typeof actionRows[0] === 'object' ? actionRows[0] as Record<string, unknown> : null
    return { book: toBookDto(book), position: positionRow ? toPositionDto(positionRow, book.side) : null, telemetry, risk, execution: toExecutionSummaryDto(action), reserve: reserveRow ? toReserveDto(reserveRow as Record<string, unknown>) : null }
  })
  app.get<{ Params: { id: string } }>('/books/:id/autopsy', async request => (await persistence.listAutopsy((await requireSession(request)).userId, request.params.id)).map(row => toAutopsyDto(row as Record<string, unknown>)))
  app.get<{ Params: { id: string } }>('/books/:id/decisions', async request => (await persistence.listDecisions((await requireSession(request)).userId, request.params.id)).map(row => toDecisionDto(row as Record<string, unknown>)))
  app.get<{ Params: { id: string } }>('/books/:id/actions', async request => (await persistence.listActions((await requireSession(request)).userId, request.params.id)).map(row => toActionDto(row as Record<string, unknown>)))
  app.get<{ Params: { id: string } }>('/books/:id/reserve', async request => { const row = await persistence.getReserve((await requireSession(request)).userId, request.params.id); return row ? toReserveDto(row as Record<string, unknown>) : null })

  app.post('/connections/revoke', async request => { await persistence.revokeConnection((await requireSession(request)).userId); return { ok: true } })
  app.get('/connections', async request => { const current = await requireSession(request); if (!(persistence instanceof PostgresStore)) return context.venue ? [{ id: 'test-venue', environment: 'testnet', scope: 'read,trade', status: 'VALID', walletAddress: current.walletAddress }] : []; const result = await persistence.pool.query('SELECT id,environment,scope,status,created_at,revoked_at FROM perpl_connections WHERE user_id=$1 ORDER BY created_at DESC', [current.userId]); return result.rows })
  app.post('/connections/perpl/validate', async request => {
    const current = await requireSession(request)
    if (!(persistence instanceof PostgresStore)) {
      if (!context.venue?.validate) return { status: 'UNAVAILABLE', connections: [] }
      return { status: await context.venue.validate(), connections: [{ id: 'test-venue', environment: 'testnet', scope: 'read,trade', status: 'VALID', walletAddress: current.walletAddress }] }
    }
    const connection = await persistence.pool.query('SELECT id,environment,status FROM perpl_connections WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [current.userId])
    const expected = config.environment === 'mainnet' ? 'mainnet' : 'testnet'
    if (!connection.rows.length && context.venue?.validate) {
      const outcome = await context.venue.validate()
      return { status: outcome, connections: [{ id: 'server-perpl', environment: expected, scope: 'read', status: outcome, accountId: context.venue.accountId }] }
    }
    if (!connection.rows.length) return { status: 'NOT_CONNECTED', connections: [] }
    const outcome = connection.rows[0].environment !== expected ? 'INVALID' : context.venue?.validate ? await context.venue.validate() : 'UNAVAILABLE'
    const result = await persistence.pool.query('UPDATE perpl_connections SET status=$2 WHERE id=$1 RETURNING id,status', [connection.rows[0].id, outcome])
    return { status: result.rows[0]?.status ?? outcome, connections: result.rows }
  })
  app.get('/connections/perpl/positions', async request => { await requireSession(request); if (!context.venue?.listPositions) return { status: 'UNAVAILABLE', positions: [] }; return { status: 'VALID', positions: await context.venue.listPositions() } })
  app.get('/capital', async request => { const current = await requireSession(request); if (!context.venue?.capital) { const unavailable = (source: string, reason: string) => ({ amount: null, asset: 'AUSD', decimals: 6, source, availability: 'UNAVAILABLE' as const, freshness: 'UNKNOWN' as const, reason }); return { status: 'UNAVAILABLE' as const, walletAusd: unavailable('MONAD_AUSD', 'VENUE_NOT_CONFIGURED'), perplAvailable: unavailable('PERPL_COLLATERAL', 'VENUE_NOT_CONFIGURED'), perplLocked: unavailable('PERPL_COLLATERAL', 'VENUE_NOT_CONFIGURED'), bookReserved: unavailable('KEEL_LEDGER', 'VENUE_NOT_CONFIGURED'), bookDeployed: unavailable('KEEL_LEDGER', 'VENUE_NOT_CONFIGURED'), bookRemaining: unavailable('KEEL_LEDGER', 'VENUE_NOT_CONFIGURED'), unreservedCapital: unavailable('KEEL_LEDGER', 'VENUE_NOT_CONFIGURED') } } return context.venue.capital(current.walletAddress) })
  app.post('/devices', async request => { const current = await requireSession(request); const body = request.body as { pushToken?: string; platform?: string }; if (!body.pushToken || !['ios', 'android', 'web'].includes(body.platform ?? '')) throw new ValidationError('INVALID_DEVICE'); await persistence.registerDevice(current.userId, body.pushToken, body.platform!); return { ok: true } })
  app.get('/notifications', async request => { const current = await requireSession(request); if (notificationStore) return (await notificationStore.list(current.userId)).map(row => toNotificationDto(row as Record<string, unknown>)); if (persistence instanceof MemoryStore) return persistence.listNotifications(current.userId).map(row => toNotificationDto(row)); return [] })
  app.post<{ Params: { id: string } }>('/notifications/:id/read', async request => { const current = await requireSession(request); if (notificationStore) await notificationStore.markRead(current.userId, request.params.id); else if (persistence instanceof MemoryStore) persistence.markNotificationRead(current.userId, request.params.id); return { ok: true } })
  app.post<{ Body: { scenario: string } }>('/dev/test-venue/scenario', async request => { await requireSession(request); if (!context.testRuntime || config.environment === 'mainnet') throw Object.assign(new Error('TEST_VENUE_NOT_ENABLED'), { statusCode: 404 }); context.testRuntime.venue.setScenario(request.body.scenario); return { ok: true, scenario: request.body.scenario, environment: 'DEV / TEST VENUE' } })
  app.setErrorHandler((error, _request, reply) => { logger.error({ error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }, 'request failed'); const typed = error as Error & { statusCode?: number; details?: unknown }; const status = error instanceof Error && 'statusCode' in error ? Number(typed.statusCode) : 500; return reply.code(status).send({ error: error instanceof Error ? error.message : 'INTERNAL_ERROR', ...(typed.details === undefined ? {} : { details: typed.details }) }) })
}



