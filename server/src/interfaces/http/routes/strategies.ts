import type { FastifyInstance, FastifyRequest } from 'fastify'
import { strategyEquity, type StrategyConfig } from '../../../../../packages/strategies/src/index.js'
import {
  AuthenticationError,
  AuthorizationError,
  InfrastructureError,
  NotFoundError,
  ValidationError,
} from '../../../application/errors.js'
import { PostgresStore } from '../../../infrastructure/database/postgres-store.js'
import { StrategyStore } from '../../../infrastructure/strategies/store.js'
import { PerplAdapter } from '../../../../../packages/perpl/src/index.js'

type Context = {
  app: FastifyInstance
  persistence: PostgresStore | null
  environment: 'testnet' | 'mainnet'
  session(request: FastifyRequest): Promise<{ userId: string } | null>
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export function registerStrategyRoutes(context: Context): void {
  const repo = context.persistence ? new StrategyStore(context.persistence.pool, context.environment) : null
  const owned = async (request: FastifyRequest, id: unknown) => {
    const current = await context.session(request)
    if (!current) throw new AuthenticationError()
    if (!repo) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    if (!uuid(id)) throw new ValidationError('STRATEGY_ID_INVALID')
    const row = await repo.get(current.userId, id)
    if (!row) throw new NotFoundError('STRATEGY_NOT_FOUND')
    return { row, userId: current.userId }
  }
  context.app.get('/strategies', async (request) => {
    const current = await context.session(request)
    if (!current) throw new AuthenticationError()
    return repo?.list(current.userId) ?? []
  })
  context.app.get('/strategies/setup', async (request) => {
    const current = await context.session(request)
    if (!current) throw new AuthenticationError()
    if (!context.persistence) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    const accounts = await context.persistence.pool.query(
      `SELECT c.id AS "connectionId",a.account_id AS "accountId",c.environment
       FROM perpl_connections c JOIN perpl_accounts a ON a.connection_id=c.id
       JOIN perpl_account_owners o ON o.environment=c.environment AND o.account_id=a.account_id
       WHERE c.user_id=$1 AND o.user_id=$1 AND c.environment=$2 AND c.status='ACTIVE'
         AND c.expires_at>now() AND c.scope='trade' AND a.forwarding=true AND a.frozen=false
       ORDER BY c.created_at DESC`,
      [current.userId, context.environment],
    )
    const adapter = new PerplAdapter(context.environment)
    try {
      const protocol = await adapter.getProtocolContext()
      return {
        accounts: accounts.rows,
        markets: protocol.markets
          .filter((market) => market.config.is_open === true)
          .map((market) => ({ id: market.id, symbol: market.symbol || `Market ${market.id}` })),
      }
    } catch {
      return { accounts: accounts.rows, markets: [], marketStatus: 'UNAVAILABLE' }
    } finally {
      adapter.close()
    }
  })
  context.app.post<{ Body: { connectionId?: string; config?: StrategyConfig } }>('/strategies', async (request) => {
    const current = await context.session(request)
    if (!current) throw new AuthenticationError()
    if (!repo) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    if (!uuid(request.body?.connectionId) || !request.body?.config || typeof request.body.config !== 'object')
      throw new ValidationError('STRATEGY_CONFIG_INVALID')
    try {
      return await repo.create(current.userId, request.body.connectionId, request.body.config)
    } catch (error) {
      if (error instanceof Error && error.message === 'STRATEGY_CONNECTION_UNAVAILABLE')
        throw new AuthorizationError(error.message)
      throw new ValidationError(error instanceof Error ? error.message : 'STRATEGY_CONFIG_INVALID')
    }
  })
  context.app.get<{ Params: { id: string } }>(
    '/strategies/:id',
    async (request) => (await owned(request, request.params.id)).row,
  )
  context.app.patch<{ Params: { id: string }; Body: { config?: StrategyConfig } }>(
    '/strategies/:id',
    async (request) => {
      const { userId } = await owned(request, request.params.id)
      if (!request.body?.config || typeof request.body.config !== 'object')
        throw new ValidationError('STRATEGY_CONFIG_INVALID')
      try {
        return await repo!.configure(userId, request.params.id, request.body.config)
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : 'STRATEGY_CONFIG_INVALID')
      }
    },
  )
  for (const operation of ['start', 'resume', 'pause', 'stop'] as const)
    context.app.post<{ Params: { id: string } }>(`/strategies/:id/${operation}`, async (request) => {
      const { userId } = await owned(request, request.params.id)
      try {
        return operation === 'start' || operation === 'resume'
          ? await repo!.start(userId, request.params.id)
          : operation === 'pause'
            ? await repo!.pause(userId, request.params.id)
            : await repo!.stop(userId, request.params.id)
      } catch (error) {
        throw new AuthorizationError(error instanceof Error ? error.message : 'STRATEGY_CONTROL_REJECTED')
      }
    })
  context.app.get<{ Params: { id: string } }>('/strategies/:id/status', async (request) => {
    const { row, userId } = await owned(request, request.params.id)
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      state: row.state,
      killed: await repo!.killed(userId),
      liveEnabled: false,
    }
  })
  context.app.get<{ Params: { id: string } }>('/strategies/:id/pnl', async (request) => {
    const { row } = await owned(request, request.params.id)
    const mark = row.state.lastMark
    const equity = mark === undefined ? null : strategyEquity(row.state, mark)
    return {
      mode: row.mode,
      simulated: row.mode !== 'LIVE',
      mark: mark ?? null,
      equity,
      pnl: equity === null ? null : equity - row.state.capital,
      inventory: row.state.inventory,
      feesPaid: row.state.feesPaid,
      fundingPaid: row.state.fundingPaid,
    }
  })
  context.app.get<{ Params: { id: string } }>('/strategies/:id/orders', async (request) => {
    const { userId } = await owned(request, request.params.id)
    return repo!.orders(userId, request.params.id)
  })
  context.app.get<{ Params: { id: string } }>('/strategies/:id/fills', async (request) => {
    const { userId } = await owned(request, request.params.id)
    return repo!.fills(userId, request.params.id)
  })
  context.app.get<{ Params: { id: string } }>('/strategies/:id/risk-events', async (request) => {
    const { userId } = await owned(request, request.params.id)
    return repo!.riskEvents(userId, request.params.id)
  })
  context.app.get('/strategies/kill-switch', async (request) => {
    const current = await context.session(request)
    if (!current) throw new AuthenticationError()
    return { killed: (await repo?.killed(current.userId)) ?? false }
  })
  context.app.post('/strategies/kill-switch', async (request) => {
    const current = await context.session(request)
    if (!current) throw new AuthenticationError()
    if (!repo) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    await repo.kill(current.userId)
    return { killed: true }
  })
  context.app.post('/strategies/kill-switch/reset', async (request) => {
    const current = await context.session(request)
    if (!current) throw new AuthenticationError()
    if (!repo) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    await repo.resetKill(current.userId)
    return { killed: false }
  })
}
