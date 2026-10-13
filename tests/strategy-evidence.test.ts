import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import {
  registerStrategyEvidenceRoutes,
  renderStrategyEvidencePage,
  type StrategyEvidenceArtifact,
} from '../server/src/interfaces/http/routes/strategy-evidence.js'

const from = '2026-10-05T00:00:00Z',
  to = '2026-10-05T01:00:00Z'
const candidateSha = 'a'.repeat(40)
afterEach(() => vi.unstubAllEnvs())

async function fixture(options: { environment?: 'mainnet' | 'testnet'; sha?: string | null } = {}) {
  const { db, store } = await databaseFixture()
  const app = Fastify({ logger: false })
  const user = await store.ensureUser('0x0000000000000000000000000000000000000075')
  const other = await store.ensureUser('0x0000000000000000000000000000000000000076')
  const environment = options.environment ?? 'mainnet'
  const connection = randomUUID(),
    strategy = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status)
     VALUES($1,$2,$3,'trade','never-export-key','ACTIVE')`,
    [connection, user, environment],
  )
  await db.query(
    `INSERT INTO strategies(id,user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status,created_at)
     VALUES($1,$2,$3,$4,642,16,'PAPER','GRID',1000,'{}','{}','STOPPED',$5)`,
    [strategy, user, connection, environment, from],
  )
  await db.query(
    `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory)
     VALUES($1,$2,1000,0),($1,'2026-10-05T00:59:00Z',1001,0)`,
    [strategy, from],
  )
  registerStrategyEvidenceRoutes({
    app,
    persistence: store,
    environment,
    session: async (request) =>
      request.headers.authorization === 'Bearer owner'
        ? { userId: user }
        : request.headers.authorization === 'Bearer other'
          ? { userId: other }
          : null,
    candidateSha: () => (options.sha === null ? undefined : (options.sha ?? candidateSha)),
    now: () => new Date('2026-10-05T02:00:00Z'),
  })
  app.setErrorHandler((error, _request, reply) => {
    const typed = error as Error & { statusCode?: number }
    reply.code(typed.statusCode ?? 500).send({ error: typed.message })
  })
  const payload = { from, to, strategyId: strategy, ownerReviewed: true }
  const publish = (body = payload, auth = 'owner') =>
    app.inject({
      method: 'POST',
      url: '/strategies/evidence-publications',
      headers: { authorization: `Bearer ${auth}` },
      payload: body,
    })
  const close = async () => {
    await app.close()
    await db.close()
  }
  return { db, app, user, other, connection, strategy, payload, publish, close }
}

it('requires authenticated owner review and server SHA; ignores no client-supplied evidence', async () => {
  const f = await fixture()
  try {
    expect((await f.publish(f.payload, 'anonymous')).statusCode).toBe(401)
    expect((await f.publish({ ...f.payload, ownerReviewed: false })).statusCode).toBe(400)
    expect((await f.publish({ ...f.payload, strategyId: randomUUID() })).statusCode).toBe(404)
    expect((await f.publish(f.payload, 'other')).statusCode).toBe(404)
    const suppliedSha = await f.app.inject({
      method: 'POST',
      url: '/strategies/evidence-publications',
      headers: { authorization: 'Bearer owner' },
      payload: { ...f.payload, candidateSha: 'f'.repeat(40) },
    })
    expect(suppliedSha.statusCode).toBe(400)
    const created = await f.publish()
    expect(created.statusCode).toBe(201)
    const value = created.json()
    expect(value.path).toBe(`/evidence/${value.id}`)
    expect(value.artifact).toMatchObject({
      candidateSha,
      deploymentAttested: false,
      visibility: 'OWNER_REVIEWED_PUBLIC',
    })
    expect(value.artifact.report.strategies[0]).toMatchObject({
      pnl: '1',
      pnlAvailability: 'SIMULATED',
      automatedMainnetAdmissions: 0,
      automatedMainnetFills: 0,
    })
    expect(created.headers['cache-control']).toBe('no-store')
    expect((await f.app.inject({ method: 'GET', url: '/strategies/evidence-publications' })).statusCode).toBe(401)
    const list = await f.app.inject({
      method: 'GET',
      url: `/strategies/evidence-publications?strategyId=${f.strategy}`,
      headers: { authorization: 'Bearer owner' },
    })
    expect(list.json()).toEqual([{ id: value.id, path: value.path, createdAt: '2026-10-05T02:00:00.000Z' }])
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: '/strategies/evidence-publications',
          headers: { authorization: 'Bearer other' },
        })
      ).json(),
    ).toEqual([])
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `/strategies/evidence-publications?strategyId=${randomUUID()}`,
          headers: { authorization: 'Bearer owner' },
        })
      ).json(),
    ).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)

it('serves only saved sanitized evidence publicly, with honest empty-automation and financial labels', async () => {
  const f = await fixture()
  try {
    const created = (await f.publish()).json()
    const page = await f.app.inject({ method: 'GET', url: created.path })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['content-security-policy']).toContain("default-src 'none'")
    expect(page.body).toContain('No mainnet automation evidence in this report.')
    expect(page.body).toContain('Simulated equity change')
    expect(page.body).toContain('Net profit is not established.')
    expect(page.body).not.toContain('never-export-key')
    expect(page.body).not.toContain(f.user)
    expect(page.body).not.toContain(f.connection)
    const json = await f.app.inject({ method: 'GET', url: created.path, headers: { accept: 'application/json' } })
    expect(json.json().report.independentlyReverified).toBe(false)
    await f.db.query(`UPDATE strategy_equity_points SET equity=1200 WHERE strategy_id=$1 AND observed_at>$2`, [
      f.strategy,
      from,
    ])
    expect(
      (await f.app.inject({ method: 'GET', url: created.path, headers: { accept: 'application/json' } })).json().report
        .strategies[0].pnl,
    ).toBe('1')
  } finally {
    await f.close()
  }
}, 30_000)

it('lets only publication owner revoke access and never caches a revoked page', async () => {
  const f = await fixture()
  try {
    const created = (await f.publish()).json()
    const path = `/strategies/evidence-publications/${created.id}`
    expect((await f.app.inject({ method: 'DELETE', url: path })).statusCode).toBe(401)
    expect(
      (await f.app.inject({ method: 'DELETE', url: path, headers: { authorization: 'Bearer other' } })).statusCode,
    ).toBe(404)
    expect((await f.app.inject({ method: 'GET', url: created.path })).statusCode).toBe(200)
    expect(
      (await f.app.inject({ method: 'DELETE', url: path, headers: { authorization: 'Bearer owner' } })).json(),
    ).toEqual({ revoked: true })
    const revoked = await f.app.inject({ method: 'GET', url: created.path })
    expect(revoked.statusCode).toBe(404)
    expect(revoked.headers['cache-control']).toBe('no-store')
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: '/strategies/evidence-publications',
          headers: { authorization: 'Bearer owner' },
        })
      ).json(),
    ).toEqual([])
    expect(
      (await f.app.inject({ method: 'DELETE', url: path, headers: { authorization: 'Bearer owner' } })).statusCode,
    ).toBe(200)
    expect((await f.app.inject({ method: 'GET', url: `/evidence/${randomUUID()}` })).statusCode).toBe(404)
  } finally {
    await f.close()
  }
}, 30_000)

it('refuses publication when actual server source SHA is unavailable', async () => {
  const f = await fixture({ sha: null })
  try {
    const result = await f.publish()
    expect(result.statusCode).toBe(503)
    expect(result.json().error).toBe('STRATEGY_CANDIDATE_SHA_UNAVAILABLE')
    expect((await f.db.query('SELECT id FROM strategy_evidence_publications')).rows).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)

it('keeps artifacts immutable and revocation irreversible; migration safely reapplies', async () => {
  const f = await fixture()
  try {
    const created = (await f.publish()).json()
    await expect(
      f.db.query(
        `UPDATE strategy_evidence_publications SET artifact=artifact||'{"candidateSha":"fake"}'::jsonb WHERE id=$1`,
        [created.id],
      ),
    ).rejects.toThrow('STRATEGY_EVIDENCE_ARTIFACT_IMMUTABLE')
    await f.app.inject({
      method: 'DELETE',
      url: `/strategies/evidence-publications/${created.id}`,
      headers: { authorization: 'Bearer owner' },
    })
    await expect(
      f.db.query(`UPDATE strategy_evidence_publications SET revoked_at=NULL WHERE id=$1`, [created.id]),
    ).rejects.toThrow('STRATEGY_EVIDENCE_ARTIFACT_IMMUTABLE')
    await f.db.exec(await readFile('database/migrations/040_strategy_public_evidence.sql', 'utf8'))
    expect((await f.db.query('SELECT id FROM strategies WHERE id=$1', [f.strategy])).rows).toHaveLength(1)
    expect((await f.app.inject({ method: 'GET', url: created.path })).statusCode).toBe(404)
  } finally {
    await f.close()
  }
}, 30_000)

it('escapes all text and uses only hash-validated explorer links in responsive script-free HTML', async () => {
  const f = await fixture()
  try {
    const artifact = (await f.publish()).json().artifact as StrategyEvidenceArtifact
    artifact.report.strategies[0].pnlReason = '<script>alert("xss")</script>'
    artifact.report.strategies[0].commandAdmissions.push({
      orderId: randomUUID(),
      kind: '<img src=x onerror=alert(1)>',
      submittedAt: from,
      origin: 'ORIGIN_NOT_RECORDED',
      requestId: '45',
      block: 110,
      transactionHash: 'javascript:alert(1)',
      evidence: 'STORED_COMMAND_ADMISSION',
    })
    const html = renderStrategyEvidencePage(artifact)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('@media(max-width:600px)')
    expect(html).toContain('overflow-wrap:anywhere')
    expect(html).toContain('name="viewport"')
  } finally {
    await f.close()
  }
}, 30_000)

it('refuses a report outside bounded window and does not create a partial artifact', async () => {
  const f = await fixture()
  try {
    expect((await f.publish({ ...f.payload, to: '2026-11-06T00:00:00Z' })).statusCode).toBe(400)
    expect((await f.db.query('SELECT id FROM strategy_evidence_publications')).rows).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)
