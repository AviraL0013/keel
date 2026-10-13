import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  AuthenticationError,
  InfrastructureError,
  NotFoundError,
  ValidationError,
} from '../../../application/errors.js'
import type { PostgresStore } from '../../../infrastructure/database/postgres-store.js'
import { buildStrategyRunReport, createStrategyEvidencePublication } from '../../../infrastructure/strategies/report.js'

export type StrategyEvidenceArtifact = ReturnType<typeof createStrategyEvidencePublication>
export type StrategyEvidenceContext = {
  app: FastifyInstance
  persistence: PostgresStore | null
  environment: 'testnet' | 'mainnet'
  session(request: FastifyRequest): Promise<{ userId: string } | null>
  /** Server configuration only. Never read these values from publication input. */
  systemUrl?: string
  candidateSha?: () => string | undefined
  now?: () => Date
}

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
const transactionLink = (environment: string, hash: string) =>
  /^0x[0-9a-f]{64}$/i.test(hash)
    ? `<a rel="noopener noreferrer" target="_blank" href="https://${environment === 'mainnet' ? '' : 'testnet.'}monadvision.com/tx/${escape(hash)}">${escape(hash)}</a>`
    : escape(hash)

/** Static, script-free view of one saved publication. No private endpoint or live account read occurs. */
export function renderStrategyEvidencePage(artifact: StrategyEvidenceArtifact): string {
  const report = artifact.report
  const admissions = report.strategies.reduce((sum, row) => sum + row.automatedMainnetAdmissions, 0)
  const fills = report.strategies.reduce((sum, row) => sum + row.automatedMainnetFills, 0)
  const unresolved = report.strategies.reduce((sum, row) => sum + row.unresolvedOrders, 0)
  const strategies = report.strategies
    .map((row) => {
      const commands = row.commandAdmissions
        .map(
          (command) => `<li>
      <div class="record-title">${escape(command.kind)} <span>${escape(command.origin)}</span></div>
      <dl><dt>Submitted UTC</dt><dd>${escape(command.submittedAt)}</dd><dt>Request</dt><dd>${escape(command.requestId)}</dd>
      <dt>Confirmed block</dt><dd>${escape(command.block)}</dd><dt>Transaction</dt><dd>${transactionLink(row.environment, command.transactionHash)}</dd></dl>
      <p class="muted">Stored command admission. This is not fill evidence.</p></li>`,
        )
        .join('')
      const fillRows = row.fills
        .map(
          (fill) => `<li>
      <div class="record-title">${escape(fill.side)} ${escape(fill.size)} <span>${fill.simulated ? 'PAPER / simulated' : escape(fill.origin)}</span></div>
      <dl><dt>Price</dt><dd>${escape(fill.price)} AUSD</dd><dt>Gross fee</dt><dd>${escape(fill.fee)} AUSD</dd>
      ${fill.builderFee === null ? '' : `<dt>Builder component</dt><dd>${escape(fill.builderFee)} AUSD, already included</dd>`}
      <dt>${fill.simulated ? 'Simulated fill UTC' : 'Ledger recorded UTC'}</dt><dd>${escape(fill.at)}</dd>
      ${
        fill.transactionHash
          ? `<dt>Block / log</dt><dd>${escape(fill.block)} / ${escape(fill.logIndex)}</dd>
      <dt>Transaction</dt><dd>${transactionLink(row.environment, fill.transactionHash)}</dd>`
          : ''
      }</dl>
      <p class="muted">${fill.simulated ? 'Simulation only. No real transaction.' : 'Stored verified fill. Recording time may differ from chain event time.'}</p></li>`,
        )
        .join('')
      const riskRows = row.riskEvents.map((event) => `<li>${escape(event.at)}: ${escape(event.code)}</li>`).join('')
      return `<section><h2>${escape(row.mode)} · Market ${escape(row.marketId)}</h2>
      <p class="muted">Account ${escape(row.accountId)} · Strategy <span class="identity">${escape(row.id)}</span></p>
      <dl class="summary"><dt>Recorded minutes</dt><dd>${escape(row.observedMinutes)}/${escape(row.expectedMinutes)}</dd>
      <dt>${row.mode === 'PAPER' ? 'Simulated equity change' : 'Net realized PnL'}</dt>
      <dd>${row.pnl === null ? '<span class="signal">Unavailable</span>' : `${escape(row.pnl)} AUSD (simulated)`}</dd></dl>
      ${row.pnlReason ? `<p class="muted">${escape(row.pnlReason)}</p>` : ''}
      <details ${commands ? 'open' : ''}><summary>Stored command admissions (${row.commandAdmissions.length})</summary>
      ${commands ? `<ul class="records">${commands}</ul>` : '<p class="muted">No command admission proof in this window.</p>'}</details>
      <details ${fillRows ? 'open' : ''}><summary>${row.mode === 'PAPER' ? 'Simulated fills' : 'Stored verified fills'} (${row.fills.length})</summary>
      ${fillRows ? `<ul class="records">${fillRows}</ul>` : '<p class="muted">No fill evidence in this window.</p>'}</details>
      ${riskRows ? `<details><summary>Risk events (${row.riskEvents.length})</summary><ul>${riskRows}</ul></details>` : ''}</section>`
    })
    .join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>EYELER · Perpl automation evidence</title><meta name="robots" content="noindex,nofollow">
    <style>:root{color-scheme:dark;font-family:"IBM Plex Mono","JetBrains Mono",ui-monospace,monospace;background:#0B0C0A;color:#eef0eb;font-variant-numeric:tabular-nums}
    *{box-sizing:border-box}body{margin:0;padding:32px 20px;line-height:1.55;font-size:14px}main{max-width:1080px;margin:auto}
    a{color:#FFB800;text-underline-offset:3px;overflow-wrap:anywhere}h1{font-size:clamp(25px,4vw,44px);line-height:1.15;margin:28px 0 14px;letter-spacing:-1.4px}h2{font-size:18px;margin:0 0 10px}
    nav{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #35372f;padding-bottom:20px}nav strong{letter-spacing:2px}p{margin:10px 0 16px}.muted{color:#b2b7a7}.signal{color:#FFB800}
    .metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid #35372f;margin:26px 0}.metric{padding:18px;border-right:1px solid #35372f}.metric:last-child{border:0}.number{display:block;font-size:36px;color:#FFB800;line-height:1.25}
    section,.notice{border:1px solid #35372f;padding:22px;margin:18px 0}.notice{border-left:3px solid #FFB800}dl{display:grid;grid-template-columns:170px minmax(0,1fr);gap:6px 12px;margin:12px 0}dt{color:#b2b7a7}dd{margin:0;overflow-wrap:anywhere}.identity{overflow-wrap:anywhere}
    details{border-top:1px solid #35372f;padding-top:14px;margin-top:18px}summary{cursor:pointer}.records{list-style:none;margin:16px 0 0;padding:0}.records>li{border-top:1px solid #35372f;padding:16px 0 2px}.record-title{font-weight:700;display:flex;gap:12px;justify-content:space-between}.record-title span{font-size:12px;font-weight:400;color:#b2b7a7}footer{margin-top:32px;border-top:1px solid #35372f;padding-top:18px}
    @media(max-width:600px){body{padding:20px 14px;font-size:13px}.metrics{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid #35372f;padding:14px;display:flex;align-items:center;gap:16px}.number{font-size:30px;min-width:44px}.metric:last-child{border:0}section,.notice{padding:16px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:8px}.record-title{flex-direction:column;gap:2px}}
    </style></head><body><main><nav><strong>EYELER</strong><a href="${escape(artifact.systemUrl)}" rel="noopener noreferrer">Open trading system</a></nav>
    <h1>Perpl automation evidence</h1><p>${report.environment === 'mainnet' ? 'Monad mainnet' : 'Monad testnet'} · Owner-reviewed snapshot</p>
    <p class="muted">Report window UTC: ${escape(report.from)} to ${escape(report.to)}</p>
    <div class="metrics"><div class="metric"><strong class="number">${admissions}</strong><span>Automatic mainnet<br>command admissions</span></div>
      <div class="metric"><strong class="number">${fills}</strong><span>Automatic mainnet<br>stored verified fills</span></div>
      <div class="metric"><strong class="number">${unresolved}</strong><span>Unresolved commands<br>in report window</span></div></div>
    <div class="notice">${admissions || fills ? 'Stored evidence is available. Independently check the linked receipts, account and request before claiming real automatic execution.' : 'No mainnet automation evidence in this report.'}
      <p class="muted">This page cannot trade or access private account data. Stored command admission is not a fill. Net profit is not established.</p></div>
    ${strategies || '<section><p>No strategies in this owner-scoped window.</p></section>'}
    <footer><h2>Data limits</h2><p class="muted">${escape(report.limitation)}</p>
      <dl><dt>Published UTC</dt><dd>${escape(artifact.publishedAt)}</dd><dt>Candidate SHA</dt><dd>${escape(artifact.candidateSha)}</dd></dl>
      <p class="muted">The server records its source SHA. This snapshot does not independently attest deployment or reverify mainnet receipts. Its owner can revoke public access.</p></footer>
    </main></body></html>`
}

export function registerStrategyEvidenceRoutes(context: StrategyEvidenceContext): void {
  const now = context.now ?? (() => new Date())
  const candidateSha =
    context.candidateSha ??
    (() => process.env.SOURCE_VERSION ?? process.env.GITHUB_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA)
  const owner = async (request: FastifyRequest) => {
    const current = await context.session(request)
    if (!current) throw new AuthenticationError()
    if (!context.persistence) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    return current.userId
  }
  context.app.get<{ Querystring: { strategyId?: string } }>(
    '/strategies/evidence-publications',
    async (request, reply) => {
      const userId = await owner(request)
      const strategyId = request.query.strategyId
      if (strategyId !== undefined && !uuid(strategyId)) throw new ValidationError('STRATEGY_ID_INVALID')
      const rows = await context.persistence!.pool.query<{ id: string; created_at: string | Date }>(
        `SELECT id,created_at FROM strategy_evidence_publications
       WHERE user_id=$1 AND environment=$2 AND revoked_at IS NULL
         AND ($3::jsonb IS NULL OR artifact @> $3::jsonb)
       ORDER BY created_at DESC,id LIMIT 100`,
        [
          userId,
          context.environment,
          strategyId ? JSON.stringify({ report: { strategies: [{ id: strategyId }] } }) : null,
        ],
      )
      reply.header('Cache-Control', 'no-store')
      return rows.rows.map((row) => ({
        id: row.id,
        path: `/evidence/${row.id}`,
        createdAt: new Date(row.created_at).toISOString(),
      }))
    },
  )
  context.app.post<{ Body: { from?: string; to?: string; strategyId?: string; ownerReviewed?: boolean } }>(
    '/strategies/evidence-publications',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = await owner(request),
        body = request.body
      if (
        !body ||
        typeof body !== 'object' ||
        body.ownerReviewed !== true ||
        Object.keys(body).some((key) => !['from', 'to', 'strategyId', 'ownerReviewed'].includes(key))
      )
        throw new ValidationError('STRATEGY_PUBLICATION_REVIEW_REQUIRED')
      if (
        typeof body.from !== 'string' ||
        typeof body.to !== 'string' ||
        (body.strategyId !== undefined && !uuid(body.strategyId))
      )
        throw new ValidationError('STRATEGY_REPORT_WINDOW_INVALID')
      const sha = candidateSha()
      if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new InfrastructureError('STRATEGY_CANDIDATE_SHA_UNAVAILABLE')
      let report
      try {
        report = await buildStrategyRunReport(context.persistence!.pool, body.from, body.to, body.strategyId, {
          userId,
          environment: context.environment,
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'STRATEGY_REPORT_UNAVAILABLE'
        if (
          [
            'STRATEGY_REPORT_WINDOW_INVALID',
            'STRATEGY_REPORT_SCOPE_INVALID',
            'STRATEGY_REPORT_LIMIT_EXCEEDED',
          ].includes(code)
        )
          throw new ValidationError(code)
        throw new InfrastructureError('STRATEGY_REPORT_UNAVAILABLE')
      }
      if (!report.strategies.length) throw new NotFoundError('STRATEGY_NOT_FOUND')
      const artifact = createStrategyEvidencePublication(report, {
        ownerReviewed: true,
        systemUrl: context.systemUrl ?? 'https://app.eyeler.xyz',
        candidateSha: sha,
        publishedAt: now().toISOString(),
      })
      const id = randomUUID()
      await context.persistence!.pool.query(
        `INSERT INTO strategy_evidence_publications(id,user_id,environment,artifact,created_at) VALUES($1,$2,$3,$4,$5)`,
        [id, userId, context.environment, JSON.stringify(artifact), artifact.publishedAt],
      )
      reply.header('Cache-Control', 'no-store').code(201)
      return { id, path: `/evidence/${id}`, artifact }
    },
  )
  context.app.delete<{ Params: { id: string } }>('/strategies/evidence-publications/:id', async (request, reply) => {
    const userId = await owner(request)
    if (!uuid(request.params.id)) throw new NotFoundError('STRATEGY_EVIDENCE_NOT_FOUND')
    const revoked = await context.persistence!.pool.query(
      `UPDATE strategy_evidence_publications SET revoked_at=COALESCE(revoked_at,now())
       WHERE id=$1 AND user_id=$2 AND environment=$3 RETURNING id`,
      [request.params.id, userId, context.environment],
    )
    if (!revoked.rows.length) throw new NotFoundError('STRATEGY_EVIDENCE_NOT_FOUND')
    reply.header('Cache-Control', 'no-store')
    return { revoked: true }
  })
  context.app.get<{ Params: { id: string } }>('/evidence/:id', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      )
    if (!uuid(request.params.id)) throw new NotFoundError('STRATEGY_EVIDENCE_NOT_FOUND')
    if (!context.persistence) throw new InfrastructureError('DATABASE_NOT_CONFIGURED')
    const row = (
      await context.persistence.pool.query<{ artifact: StrategyEvidenceArtifact }>(
        `SELECT artifact FROM strategy_evidence_publications WHERE id=$1 AND environment=$2 AND revoked_at IS NULL`,
        [request.params.id, context.environment],
      )
    ).rows[0]
    if (!row) throw new NotFoundError('STRATEGY_EVIDENCE_NOT_FOUND')
    if (request.headers.accept?.includes('application/json')) return row.artifact
    return reply.type('text/html; charset=utf-8').send(renderStrategyEvidencePage(row.artifact))
  })
}
