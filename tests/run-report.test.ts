import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { generateRunReport } from '../scripts/report.js'

it('reports heartbeat coverage, decisions, actions, safe mode, retries, and Telegram delivery', async () => {
  const { db, store } = await databaseFixture()
  const from = new Date('2026-09-29T00:00:00Z')
  const to = new Date('2026-09-29T01:00:00Z')
  try {
    const userId = await store.ensureUser('report-owner')
    const book = await store.pool.query(
      "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC-PERP','LONG','DEFEND',7,5,3600000) RETURNING id",
      [userId],
    )
    const bookId = book.rows[0].id
    await store.pool.query(
      "INSERT INTO monitor_heartbeat_minutes(minute,first_tick,last_tick,tick_count) VALUES('2026-09-29T00:00:00Z','2026-09-29T00:00:01Z','2026-09-29T00:00:59Z',59)",
    )
    const decision = await store.pool.query(
      "INSERT INTO decisions(book_id,state,action,amount,reason_codes,human_readable_reasons,risk_features,created_at) VALUES($1,'DEFEND','DEFEND',1,'[]','[]','{}',$2) RETURNING id",
      [bookId, '2026-09-29T00:01:00Z'],
    )
    const hash = `0x${'ab'.repeat(32)}`
    await store.pool.query(
      "INSERT INTO actions(book_id,decision_id,kind,amount,status,idempotency_key,venue_reference,submitted_at,venue_progress) VALUES($1,$2,'DEFEND',1,'CONFIRMED','report-action',$3,$4,$5)",
      [
        bookId,
        decision.rows[0].id,
        `642:42:${hash}`,
        '2026-09-29T00:01:01Z',
        JSON.stringify({ effectiveLastExecBlock: 123 }),
      ],
    )
    await store.pool.query(
      "INSERT INTO autopsy_events(book_id,type,payload,timestamp) VALUES($1,'SAFE_MODE_ENTERED',$2,$3),($1,'SAFE_MODE_EXITED',$4,$5),($1,'AUTOMATION_RETRY',$6,$7)",
      [
        bookId,
        JSON.stringify({ reasonCodes: ['MARKET_STALE'] }),
        '2026-09-29T00:02:00Z',
        JSON.stringify({ reason: 'DATA_UNAVAILABLE' }),
        '2026-09-29T00:03:00Z',
        JSON.stringify({ attempt: 2 }),
        '2026-09-29T00:04:00Z',
      ],
    )
    const notice = await store.pool.query(
      "INSERT INTO notifications(user_id,book_id,kind,title,body,dedupe_key) VALUES($1,$2,'DEFEND','test','test','report-notice') RETURNING id",
      [userId, bookId],
    )
    await store.pool.query(
      "INSERT INTO telegram_deliveries(notification_id,status,attempts,delivered_at) VALUES($1,'SENT',1,$2)",
      [notice.rows[0].id, '2026-09-29T00:05:00Z'],
    )
    const report = await generateRunReport(store.pool, from, to, bookId, 'https://explorer.example')
    expect(report).toContain('59 / 3600')
    expect(report).toContain('DEFEND')
    expect(report).toContain(hash)
    expect(report).toContain(`https://explorer.example/tx/${hash}`)
    expect(report).toContain('MARKET_STALE')
    expect(report).toContain('60s')
    expect(report).toContain('Automatic retries: 1')
    expect(report).toContain('SENT: 1')
    expect(report).not.toContain('report-owner')
  } finally {
    await db.close()
  }
}, 20_000)
