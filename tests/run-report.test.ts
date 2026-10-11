import { expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { actionOrigin, generateRunReport } from '../scripts/report.js'
import { storedActionEvidence } from '../packages/perpl/src/action-evidence.js'

it('reports heartbeat coverage, decisions, actions, safe mode, retries, and Telegram delivery', async () => {
  const { db, store } = await databaseFixture()
  const from = new Date('2026-09-29T00:00:00Z')
  const to = new Date('2026-09-29T01:00:00Z')
  try {
    const userId = await store.ensureUser('report-owner')
    const book = await store.pool.query(
      "INSERT INTO books(user_id,market,market_id,venue_account_id,venue_position_id,side,stance,liquidation_floor,defense_cap,time_limit_ms) VALUES($1,'BTC-PERP',1,642,7,'LONG','DEFEND',7,5,3600000) RETURNING id",
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
        JSON.stringify({
          requestId: '42',
          requestedLastExecBlock: 130,
          effectiveLastExecBlock: 130,
          confirmedExecutionBlock: 123,
        }),
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
    expect(report).toContain('STORED_RECEIPT_BACKED')
    expect(report).toContain('ORIGIN_NOT_RECORDED')
    expect(report).toContain('Automated stored receipt-backed confirmations: 0')
    expect(report).toContain('Net realized P&L: unavailable')
    const partial = await generateRunReport(
      store.pool,
      new Date('2026-09-29T00:00:10Z'),
      new Date('2026-09-29T00:00:20Z'),
      bookId,
    )
    expect(partial).toContain('between 0 and 59 / 10 expected')
    expect(partial).toContain('exact coverage is unavailable')
    expect(partial).not.toContain('59 / 10 expected (100.00% coverage)')
  } finally {
    await db.close()
  }
}, 20_000)

it('distinguishes explicit origins and does not infer historical consent from current Book state', () => {
  expect(actionOrigin({ reason_codes: ['MANUAL_ACTION'], provenance_events: [] })).toBe('MANUAL')
  expect(actionOrigin({ reason_codes: ['USER_CLOSE'] })).toBe('MANUAL')
  expect(actionOrigin({ provenance_events: [{ origin: 'AUTOMATION' }] })).toBe('AUTOMATION')
  expect(actionOrigin({ automated_retry: true })).toBe('AUTOMATION')
  expect(actionOrigin({ automation_enabled: true })).toBe('ORIGIN_NOT_RECORDED')
  expect(actionOrigin({ reason_codes: ['USER_CLOSE'], provenance_events: [{ origin: 'AUTOMATION' }] })).toBe(
    'ORIGIN_CONFLICT',
  )
})

it('requires exact stored identity and actual execution evidence; an admission deadline proves no execution', () => {
  const input = {
    kind: 'DEFEND',
    status: 'CONFIRMED',
    accountId: 642,
    venueReference: `642:42:0x${'ab'.repeat(32)}`,
    venueProgress: { requestId: '42', effectiveLastExecBlock: 130, confirmedExecutionBlock: 123 },
  }
  expect(storedActionEvidence(input)).toMatchObject({
    level: 'STORED_RECEIPT_BACKED',
    receiptBacked: true,
    executionBlock: 123,
  })
  expect(storedActionEvidence({ ...input, accountId: 777 })).toMatchObject({
    level: 'IDENTITY_UNVERIFIED',
    receiptBacked: false,
    executionBlock: undefined,
  })
  expect(
    storedActionEvidence({ ...input, venueProgress: { ...input.venueProgress, requestId: '43' } }).receiptBacked,
  ).toBe(false)
  expect(
    storedActionEvidence({
      ...input,
      kind: 'EXIT',
      venueReference: '642:42:7',
      venueProgress: { requestId: '42', effectiveLastExecBlock: 130 },
    }),
  ).toMatchObject({ level: 'VENUE_RECONCILED', executionBlock: undefined, receiptBacked: false })
  for (const status of ['UNKNOWN', 'PARTIAL', 'FAILED', 'VERIFYING', 'SUBMITTING']) {
    expect(storedActionEvidence({ ...input, status })).toMatchObject({
      receiptBacked: false,
      executionBlock: undefined,
    })
  }
  for (const value of [0, -1, NaN, 1.5, '123', Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      storedActionEvidence({ ...input, venueProgress: { requestId: '42', confirmedExecutionBlock: value } })
        .receiptBacked,
    ).toBe(false)
  }
})
