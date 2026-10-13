import type { FastifyInstance } from 'fastify'

/** Exact public read route; callers cannot write observations or choose an account. */
export function registerStatusRoute(
  app: FastifyInstance,
  report?: () => Promise<unknown>,
  incidents?: (cursor?: string) => Promise<unknown>,
) {
  app.get('/status.json', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!report)
      return {
        version: 1,
        run: null,
        observedAt: new Date().toISOString(),
        limitations: ['The unattended run is available only on the deployed mainnet service.'],
      }
    try {
      return await report()
    } catch {
      return reply.code(503).send({
        version: 1,
        run: null,
        observedAt: new Date().toISOString(),
        limitations: ['Status storage is temporarily unavailable. No successful observation is inferred.'],
      })
    }
  })
  app.get<{ Querystring: { cursor?: string } }>('/status/incidents.json', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!incidents) return reply.code(503).send({ error: 'STATUS_STORAGE_UNAVAILABLE' })
    try {
      return await incidents(request.query.cursor)
    } catch (error) {
      if (error instanceof Error && error.message === 'RELIABILITY_CURSOR_INVALID')
        return reply.code(400).send({ error: 'STATUS_CURSOR_INVALID' })
      return reply.code(503).send({ error: 'STATUS_STORAGE_UNAVAILABLE' })
    }
  })
}
