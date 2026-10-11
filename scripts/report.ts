import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { storedActionEvidence } from '../packages/perpl/src/action-evidence.js'

type QueryPool = Pick<pg.Pool, 'query'>
const safe = (value: unknown) =>
  String(value ?? '')
    .replace(/0x[0-9a-fA-F]{40}/g, (address) => `${address.slice(0, 6)}…${address.slice(-4)}`)
    .replace(/[|\r\n]/g, ' ')
    .slice(0, 100)
const iso = (value: unknown) => new Date(String(value)).toISOString()
const validExplorer = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? value.replace(/\/$/, '') : ''
  } catch {
    return ''
  }
}

export function actionOrigin(row: Record<string, unknown>): string {
  const codes = Array.isArray(row.reason_codes) ? row.reason_codes : []
  const events = Array.isArray(row.provenance_events) ? (row.provenance_events as Array<Record<string, unknown>>) : []
  const origins = new Set(
    events.map((event) => event.origin).filter((value) => ['MANUAL', 'AUTOMATION'].includes(String(value))),
  )
  const manual = codes.some((code) => ['MANUAL_ACTION', 'USER_CLOSE'].includes(String(code)))
  if (origins.size > 1 || (manual && origins.has('AUTOMATION'))) return 'ORIGIN_CONFLICT'
  if (manual || origins.has('MANUAL')) return 'MANUAL'
  if (origins.has('AUTOMATION') || row.automated_retry === true) return 'AUTOMATION'
  return 'ORIGIN_NOT_RECORDED'
}

export async function generateRunReport(
  pool: QueryPool,
  from: Date,
  to: Date,
  bookId?: string,
  explorerBase = '',
  environment = 'unknown',
): Promise<string> {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from)
    throw new Error('INVALID_REPORT_WINDOW')
  const start = from.toISOString()
  const end = to.toISOString()
  const params = bookId ? [start, end, bookId] : [start, end]
  const bookFilter = bookId ? 'AND book_id=$3' : ''
  const heartbeats = await pool.query(
    `SELECT COALESCE(sum(tick_count),0) AS upper_count,
       COALESCE(sum(CASE WHEN first_tick >= $1 AND last_tick < $2 THEN tick_count ELSE 0 END),0) AS lower_count,
       count(*) FILTER (WHERE first_tick < $1 OR last_tick >= $2) AS partial_minutes
     FROM monitor_heartbeat_minutes WHERE last_tick >= $1 AND first_tick < $2`,
    [start, end],
  )
  const decisions = await pool.query(
    `SELECT state,count(*) AS count FROM decisions WHERE created_at >= $1 AND created_at < $2 ${bookFilter} GROUP BY state ORDER BY state`,
    params,
  )
  const actions = await pool.query(
    `SELECT a.id,a.book_id,a.decision_id,a.kind,a.amount,a.status,a.venue_reference,a.venue_progress,a.submitted_at,
       a.confirmed_at,a.error,d.created_at,d.reason_codes,b.market,b.side,b.market_id,b.venue_account_id,b.venue_position_id,
       (SELECT jsonb_agg(jsonb_build_object('id',e.id,'origin',e.payload->>'origin','timestamp',e.timestamp))
          FROM autopsy_events e WHERE e.book_id=a.book_id AND e.payload->>'actionId'=a.id::text
            AND e.type=a.kind||'_QUEUED') AS provenance_events,
       EXISTS(SELECT 1 FROM autopsy_events e WHERE e.book_id=a.book_id AND e.type='AUTOMATION_RETRY'
          AND e.payload->>'decisionId'=a.decision_id::text) AS automated_retry
       FROM actions a JOIN decisions d ON d.id=a.decision_id JOIN books b ON b.id=a.book_id
       WHERE COALESCE(a.submitted_at,d.created_at) >= $1 AND COALESCE(a.submitted_at,d.created_at) < $2
       ${bookId ? 'AND a.book_id=$3' : ''} ORDER BY COALESCE(a.submitted_at,d.created_at),a.id`,
    params,
  )
  const episodes = await pool.query(
    `SELECT book_id,type,payload,timestamp FROM autopsy_events
       WHERE timestamp < $2 AND $1::timestamptz < $2::timestamptz
         AND type IN ('SAFE_MODE_ENTERED','SAFE_MODE_EXITED') ${bookFilter}
       ORDER BY book_id,timestamp`,
    params,
  )
  const retries = await pool.query(
    `SELECT count(*) AS count FROM autopsy_events WHERE type='AUTOMATION_RETRY' AND timestamp >= $1 AND timestamp < $2 ${bookFilter}`,
    params,
  )
  const deliveries = await pool.query(
    `SELECT td.status,count(*) AS count FROM telegram_deliveries td
       JOIN notifications n ON n.id=td.notification_id
       WHERE COALESCE(td.delivered_at,td.started_at,td.next_attempt_at) >= $1
         AND COALESCE(td.delivered_at,td.started_at,td.next_attempt_at) < $2
         ${bookId ? 'AND n.book_id=$3' : ''}
       GROUP BY td.status ORDER BY td.status`,
    params,
  )
  const configurations = await pool.query(
    `SELECT b.id,b.market,b.market_id,b.venue_account_id,b.venue_position_id,b.stance,b.liquidation_floor,
       b.defense_cap,b.time_limit_ms,b.automation_enabled,b.status,r.available,r.reserved,r.deployed
       FROM books b LEFT JOIN reserves r ON r.book_id=b.id
       WHERE b.created_at < $1 ${bookId ? 'AND b.id=$2' : ''} ORDER BY b.created_at,b.id`,
    bookId ? [end, bookId] : [end],
  )
  const expected = Math.ceil((to.getTime() - from.getTime()) / 1000)
  const lower = Number(heartbeats.rows[0]?.lower_count ?? 0)
  const upper = Number(heartbeats.rows[0]?.upper_count ?? 0)
  const partial = Number(heartbeats.rows[0]?.partial_minutes ?? 0)
  const coverage = (ticks: number) => ((Math.min(ticks, expected) / expected) * 100).toFixed(2)
  const base = validExplorer(explorerBase)
  const interpreted = actions.rows.map((row) => ({
    row,
    origin: actionOrigin(row),
    proof: storedActionEvidence({
      kind: row.kind,
      status: row.status,
      accountId: row.venue_account_id,
      venueReference: row.venue_reference,
      venueProgress: row.venue_progress,
    }),
  }))
  const automated = interpreted.filter((item) => item.origin === 'AUTOMATION')
  const automatedReceipts = automated.filter((item) => item.proof.receiptBacked)
  const unresolved = interpreted.filter((item) =>
    ['UNKNOWN', 'PARTIAL', 'QUEUED', 'VALIDATING', 'SUBMITTING', 'SUBMITTED', 'VERIFYING'].includes(
      String(item.row.status),
    ),
  )
  const lines = [
    '# Eyeler run report',
    '',
    `Window: ${start} to ${end}`,
    `Book: ${bookId ?? 'all'}`,
    `Operator-supplied environment: ${safe(environment)} (not independently attested).`,
    '',
    '## Submission evidence',
    '',
    `Automated attempts with explicit origin: ${automated.length}.`,
    `Automated CONFIRMED actions: ${automated.filter((item) => item.row.status === 'CONFIRMED').length}.`,
    `Automated stored receipt-backed confirmations: ${automatedReceipts.length}.`,
    `Unresolved attempts: ${unresolved.length}.`,
    'Stored receipt-backed means DEFEND reconciliation retained a matching account/request, transaction hash and confirmed execution block. This exporter performs no RPC calls and does not independently reverify receipts, canonicality, event logs or mainnet activity.',
    'Venue-reconciled REDUCE/EXIT is not receipt-backed proof. Manual trades and unrecorded origins do not count as demonstrated automation. Review the linked transaction and exact account/request before claiming real on-chain automation; simulated transports are not real activity.',
    '',
    '## Monitor uptime',
    '',
    partial
      ? `Completed ticks: between ${lower} and ${upper} / ${expected} expected (${coverage(lower)}%–${coverage(upper)}% coverage bounds). ${partial} partial-minute aggregate(s); exact coverage is unavailable.`
      : `Completed ticks: ${lower} / ${expected} expected (${coverage(lower)}% coverage).`,
    'Coverage counts completed ticks recorded by the single monitor owner; it is not an exchange uptime claim.',
    '',
    '## Decisions',
    '',
    '| State | Count |',
    '| --- | ---: |',
    ...decisions.rows.map((row) => `| ${safe(row.state)} | ${Number(row.count)} |`),
    '',
    '## Actions',
    '',
    '| Time (UTC) | Book / action / decision | Market / account / position | Side | Action / amount | Origin | Status / error | Evidence | Request | Deadline requested / admitted | Confirmed execution block | Transaction reference | Explorer |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const { row, origin, proof } of interpreted) {
    const link =
      base && proof.receiptBacked
        ? `${base}/tx/${proof.transactionHash}`
        : base && proof.executionBlock
          ? `${base}/block/${proof.executionBlock}`
          : '-'
    lines.push(
      `| ${iso(row.submitted_at ?? row.created_at)} | ${safe(row.book_id)} / ${safe(row.id)} / ${safe(row.decision_id)} | ${safe(row.market)} (${safe(row.market_id)}) / ${safe(row.venue_account_id)} / ${safe(row.venue_position_id)} | ${safe(row.side)} | ${safe(row.kind)} / ${safe(row.amount)} | ${origin} | ${safe(row.status)} / ${safe(row.error) || '-'} | ${proof.level} | ${proof.requestId ?? '-'} | ${proof.requestedLastExecBlock ?? '-'} / ${proof.admittedLastExecBlock ?? '-'} | ${proof.executionBlock ?? '-'} | ${proof.transactionHash ?? '-'} | ${link} |`,
    )
  }
  lines.push('', 'Origin records:', '')
  for (const { row } of interpreted) {
    const events = row.provenance_events as Array<{ id: string; timestamp: string }> | null
    for (const event of events ?? [])
      lines.push(`- ${safe(event.id)} at ${iso(event.timestamp)}; action ${safe(row.id)}.`)
  }
  lines.push(
    '',
    '## Risk limits at export',
    '',
    'Current configuration is not proof of historical consent or limits. DEFEND adds collateral; it does not guarantee principal safety. Estimated liquidation distances are not exchange stop-loss guarantees.',
    '',
    '| Book | Stance | Floor (%) | Defense cap | Available / reserved / deployed | Duration (ms) | Status | Automation now |',
    '| --- | --- | ---: | ---: | --- | ---: | --- | --- |',
    ...configurations.rows.map(
      (row) =>
        `| ${safe(row.id)} | ${safe(row.stance)} | ${safe(row.liquidation_floor)} | ${safe(row.defense_cap)} | ${safe(row.available)} / ${safe(row.reserved)} / ${safe(row.deployed)} | ${safe(row.time_limit_ms)} | ${safe(row.status)} | ${safe(row.automation_enabled)} |`,
    ),
    '',
    '## Profitability',
    '',
    'Net realized P&L: unavailable in this action report. It does not contain a complete attributed ledger of fills, fees, funding, gas, deposits and withdrawals. A confirmed trade, saved reserve, wallet balance or unrealized P&L is not proof of net profit. Export the owner-scoped Analytics performance with its coverage/availability labels, and keep PAPER/backtest results separate from real performance.',
  )
  lines.push(
    '',
    '## SAFE_MODE episodes',
    '',
    '| Book | Reason | Start (UTC) | Duration |',
    '| --- | --- | --- | ---: |',
  )
  const active = new Map<string, { at: number; reason: string }>()
  for (const row of episodes.rows) {
    const id = String(row.book_id)
    const at = new Date(String(row.timestamp)).getTime()
    const payload = (row.payload ?? {}) as Record<string, unknown>
    if (row.type === 'SAFE_MODE_ENTERED') {
      const codes = Array.isArray(payload.reasonCodes) ? payload.reasonCodes.join(', ') : payload.reason
      active.set(id, { at, reason: safe(codes || 'UNKNOWN') })
    } else {
      const entry = active.get(id)
      if (entry && at >= from.getTime()) {
        const clipped = Math.max(entry.at, from.getTime())
        lines.push(
          `| ${id} | ${entry.reason} | ${new Date(clipped).toISOString()} | ${Math.max(0, Math.floor((Math.min(at, to.getTime()) - clipped) / 1000))}s |`,
        )
      }
      active.delete(id)
    }
  }
  for (const [id, entry] of active) {
    const clipped = Math.max(entry.at, from.getTime())
    if (clipped < to.getTime())
      lines.push(
        `| ${id} | ${entry.reason} | ${new Date(clipped).toISOString()} | ${Math.floor((to.getTime() - clipped) / 1000)}s (open) |`,
      )
  }
  lines.push('', `Automatic retries: ${Number(retries.rows[0]?.count ?? 0)}`, '', '## Telegram delivery', '')
  if (!deliveries.rows.length) lines.push('No delivery records in this window.')
  else for (const row of deliveries.rows) lines.push(`- ${safe(row.status)}: ${Number(row.count)}`)
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
  }
  const from = option('--from')
  const to = option('--to')
  if (!from || !to || !/^\d{4}-\d\d-\d\dT/.test(from) || !/^\d{4}-\d\d-\d\dT/.test(to))
    throw new Error('USAGE: --from <iso> --to <iso> [--book <id>] [--out <path>]')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL_REQUIRED')
  const pool = new pg.Pool({ connectionString: url })
  try {
    const markdown = await generateRunReport(
      pool,
      new Date(from),
      new Date(to),
      args.includes('--book') ? option('--book') : undefined,
      process.env.EYELER_MONAD_EXPLORER_URL ?? process.env.KEEL_MONAD_EXPLORER_URL ?? '',
      process.env.EYELER_ENV ?? process.env.KEEL_ENV ?? 'unknown',
    )
    const target = resolve(option('--out') ?? `reports/eyeler-run-${from.replace(/[^0-9A-Za-z]/g, '-')}.md`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, markdown, 'utf8')
    console.log(`Run report written: ${target}`)
  } finally {
    await pool.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main()
