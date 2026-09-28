import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

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

export async function generateRunReport(
  pool: QueryPool,
  from: Date,
  to: Date,
  bookId?: string,
  explorerBase = '',
): Promise<string> {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from)
    throw new Error('INVALID_REPORT_WINDOW')
  const start = from.toISOString()
  const end = to.toISOString()
  const params = bookId ? [start, end, bookId] : [start, end]
  const bookFilter = bookId ? 'AND book_id=$3' : ''
  const heartbeats = await pool.query(
    'SELECT COALESCE(sum(tick_count),0) AS count FROM monitor_heartbeat_minutes WHERE last_tick >= $1 AND first_tick < $2',
    [start, end],
  )
  const decisions = await pool.query(
    `SELECT state,count(*) AS count FROM decisions WHERE created_at >= $1 AND created_at < $2 ${bookFilter} GROUP BY state ORDER BY state`,
    params,
  )
  const actions = await pool.query(
    `SELECT a.id,a.kind,a.amount,a.status,a.venue_reference,a.venue_progress,a.submitted_at,d.created_at,b.market,b.side
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
  const expected = Math.ceil((to.getTime() - from.getTime()) / 1000)
  const observed = Number(heartbeats.rows[0]?.count ?? 0)
  const coverage = expected ? ((Math.min(observed, expected) / expected) * 100).toFixed(2) : '0.00'
  const base = validExplorer(explorerBase)
  const lines = [
    '# Eyeler run report',
    '',
    `Window: ${start} to ${end}`,
    `Book: ${bookId ?? 'all'}`,
    '',
    '## Monitor uptime',
    '',
    `Completed ticks: ${observed} / ${expected} expected (${coverage}% coverage).`,
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
    '| Time (UTC) | Market | Side | Action | Amount | Status | Transaction | Explorer |',
    '| --- | --- | --- | --- | ---: | --- | --- | --- |',
  ]
  for (const row of actions.rows) {
    const hash = String(row.venue_reference ?? '').match(/(?:^|:)(0x[0-9a-fA-F]{64})$/)?.[1]
    const progress = row.venue_progress as Record<string, unknown> | null
    const block = progress?.effectiveLastExecBlock
    const link =
      base && hash
        ? `${base}/tx/${hash}`
        : base && Number.isSafeInteger(block) && Number(block) > 0
          ? `${base}/block/${block}`
          : '-'
    lines.push(
      `| ${iso(row.submitted_at ?? row.created_at)} | ${safe(row.market)} | ${safe(row.side)} | ${safe(row.kind)} | ${safe(row.amount)} | ${safe(row.status)} | ${hash ?? '-'} | ${link} |`,
    )
  }
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
