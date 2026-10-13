import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { ReliabilityStore, RUN_DURATION_MS, RUN_ID } from '../server/src/infrastructure/reliability/store.js'

const start = Date.UTC(2026, 9, 14, 0, 0, 0)
async function fixture() {
  const { db, store } = await databaseFixture()
  const user = await store.ensureUser('0x1234567890123456789012345678901234567890')
  const connection = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
     VALUES($1,$2,'mainnet','trade','fixture-private-envelope','ACTIVE',now()+interval '30 days')`,
    [connection, user],
  )
  await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,5471,true,false)', [
    connection,
  ])
  const book = (
    await db.query<{ id: string }>(
      `INSERT INTO books(user_id,market,market_id,venue_account_id,perpl_connection_id,side,stance,
       liquidation_floor,defense_cap,time_limit_ms,status,automation_enabled,created_at)
       VALUES($1,'BTC',1,5471,$2,'LONG','DEFEND',5,1,60000,'ACTIVE',true,$3) RETURNING id`,
      [user, connection, new Date(start - 60_000)],
    )
  ).rows[0].id
  const reliability = new ReliabilityStore(store.pool)
  const action = async (status = 'SUBMITTING', createdAt = start + 1_000) => {
    const decision = (
      await db.query<{ id: string }>(
        `INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features,created_at)
         VALUES($1,'DEFEND','DEFEND','["LIQUIDATION_DISTANCE_LOW"]','["fixture-private-token"]','{}',$2) RETURNING id`,
        [book, new Date(createdAt)],
      )
    ).rows[0].id
    return (
      await db.query<{ id: string }>(
        `INSERT INTO actions(book_id,decision_id,kind,status,idempotency_key)
         VALUES($1,$2,'DEFEND',$3,$4) RETURNING id`,
        [book, decision, status, randomUUID()],
      )
    ).rows[0].id
  }
  const strategy = async (mode: 'PAPER' | 'LIVE', status: string) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO strategies(user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status)
         VALUES($1,$2,'mainnet',5471,1,$3,'GRID',5,'{}','{}',$4) RETURNING id`,
        [user, connection, mode, status],
      )
    ).rows[0].id
  return { db, store, user, book, reliability, action, strategy }
}

describe('durable seven-day reliability campaign', () => {
  it('starts once, preserves exact start and chooses owner privately without arming anything', async () => {
    const f = await fixture()
    try {
      const run = await f.reliability.ensureRun(start, { EYELER_EXECUTION_DISABLED: false })
      const again = await f.reliability.ensureRun(start + 500_000, { EYELER_EXECUTION_DISABLED: true })
      expect(run.id).toBe(RUN_ID)
      expect(new Date(again.started_at).getTime()).toBe(start)
      expect(new Date(run.ends_at).getTime()).toBe(start + RUN_DURATION_MS)
      expect(new Date(run.next_restart_at).getTime()).toBe(start + 600_000)
      expect(run.owner_user_id).toBe(f.user)
      expect(again.trading_states).toEqual({ EYELER_EXECUTION_DISABLED: false })
      expect((await f.db.query('SELECT automation_enabled FROM books WHERE id=$1', [f.book])).rows[0]).toEqual({
        automation_enabled: true,
      })
      const report = await f.reliability.report(start)
      expect(report.run).toMatchObject({ status: 'running', environment: 'mainnet', durationDays: 7 })
      expect(JSON.stringify(report)).not.toContain(f.user)
      expect(JSON.stringify(report)).not.toContain('0x1234567890123456789012345678901234567890')
      expect(JSON.stringify(report)).not.toContain('fixture-private-envelope')
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('measures sampled availability with missing intervals unavailable and failed ticks unhealthy', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      const healthy = { running: true, lockOwned: true, venueReady: true, lastTickAgeMs: 100 }
      const process = randomUUID()
      await f.reliability.sample(process, healthy, start)
      await f.reliability.sample(process, healthy, start + 1_000)
      await f.reliability.sample(process, healthy, start + 15_000)
      await f.reliability.sample(process, { ...healthy, lastError: 'fixture-private-error' }, start + 45_000)
      const report = await f.reliability.report(start + 60_000)
      expect(report.availability.observedSeconds).toBe(45)
      expect(report.availability.unobservedSeconds).toBe(15)
      expect(report.availability.uptimePercent).toBe(50)
      expect(JSON.stringify(report)).not.toContain('fixture-private-error')
      await f.reliability.sample(process, { ...healthy, lastError: '' }, start + 60_000)
      expect((await f.reliability.report(start + 75_000)).availability.uptimePercent).toBe(40)
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('atomically claims one scheduled restart and chaos batch, bounded by seven-day duration', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      expect(await f.reliability.claimRestart(start + 599_999)).toBeNull()
      expect(await f.reliability.claimRestart(start + 600_000)).toEqual({ index: 1 })
      expect(await f.reliability.claimRestart(start + 600_000)).toBeNull()
      expect(await f.reliability.claimChaos(start)).toBe(true)
      expect(await f.reliability.claimChaos(start)).toBe(false)
      for (let index = 2; index <= 7; index++)
        expect(await f.reliability.claimRestart(start + 600_000 + (index - 1) * 86_400_000)).toEqual({ index })
      expect(await f.reliability.claimRestart(start + RUN_DURATION_MS)).toBeNull()
      expect(await f.reliability.claimChaos(start + RUN_DURATION_MS)).toBe(false)
      await f.reliability.ensureRun(start + RUN_DURATION_MS)
      expect((await f.reliability.run())?.status).toBe('COMPLETED')
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('pauses armed mainnet Books and running Paper, preserves LIVE state and history', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      const paper = await f.strategy('PAPER', 'RUNNING')
      const live = await f.strategy('LIVE', 'RUNNING')
      await f.reliability.pause(start + 10_000)
      expect(
        (await f.db.query('SELECT status,automation_enabled,safe_mode_reason FROM books WHERE id=$1', [f.book]))
          .rows[0],
      ).toEqual({ status: 'SAFE_MODE', automation_enabled: false, safe_mode_reason: 'RUNTIME_FAILURE' })
      expect((await f.db.query('SELECT status FROM strategies WHERE id=$1', [paper])).rows[0]).toEqual({
        status: 'PAUSED',
      })
      expect((await f.db.query('SELECT status FROM strategies WHERE id=$1', [live])).rows[0]).toEqual({
        status: 'RUNNING',
      })
      expect((await f.reliability.run())?.automation_paused).toBe(true)
      expect(await f.reliability.claimRestart(start + 600_000)).toBeNull()
      expect(await f.reliability.claimChaos(start + 600_000)).toBe(false)
      const action = await f.action()
      await expect(f.reliability.recordBookSend(action, start + 11_000)).rejects.toThrow(
        'RELIABILITY_AUTOMATION_PAUSED',
      )
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('blocks repeated, UNKNOWN and PARTIAL transmit attempts; leaves finished runs unguarded', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      const action = await f.action()
      await f.reliability.recordBookSend(action, start + 1_000)
      await expect(f.reliability.recordBookSend(action, start + 2_000)).rejects.toThrow('RELIABILITY_DUPLICATE_SEND')
      await f.db.query("UPDATE actions SET status='UNKNOWN' WHERE id=$1", [action])
      await expect(f.reliability.recordBookSend(action, start + 3_000)).rejects.toThrow(
        'RELIABILITY_UNKNOWN_RESUBMISSION',
      )
      await f.db.query("UPDATE actions SET status='PARTIAL' WHERE id=$1", [action])
      await expect(f.reliability.recordBookSend(action, start + 4_000)).rejects.toThrow(
        'RELIABILITY_PARTIAL_RESUBMISSION',
      )
      expect((await f.reliability.report(start + 5_000)).books.sendCount).toBe(1)
      await f.reliability.recordBookSend(action, start + RUN_DURATION_MS)
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('records sanitized incidents, actual handovers and synthetic chaos results idempotently', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      const first = randomUUID(),
        second = randomUUID()
      await f.reliability.event('lock_acquired', first, start)
      await f.reliability.event('lock_released', first, start + 10_000, { clean: true })
      await f.reliability.event('lock_acquired', second, start + 11_000)
      await f.reliability.incident('private-stream-key', 'websocket_disconnect', 'mainnet', start + 12_000)
      await f.reliability.incident('private-stream-key', 'websocket_disconnect', 'mainnet', start + 13_000)
      await f.reliability.recover('private-stream-key', start + 15_000)
      const chaos = {
        scenario: 'rpc-timeout',
        at: new Date(start + 16_000).toISOString(),
        status: 'passed' as const,
        recoveryMs: 12,
        invariants: {
          noDuplicateOrders: true,
          noUnknownResubmission: true,
          noPartialResubmission: true,
          failClosed: true,
        },
        summary: 'fixture-private-token 0x1234567890123456789012345678901234567890',
      }
      await f.reliability.saveChaos([chaos], start + 16_000)
      await f.reliability.saveChaos([chaos], start + 16_000)
      const report = await f.reliability.report(start + 20_000)
      expect(report.availability.handovers).toBe(1)
      expect(report.incidents).toHaveLength(1)
      expect(report.incidents[0]).toMatchObject({ status: 'recovered', durationMs: 3_000 })
      await f.reliability.incident('private-stream-key', 'websocket_disconnect', 'mainnet', start + 21_000)
      expect((await f.reliability.report(start + 22_000)).incidents).toHaveLength(2)
      expect(report.chaos).toHaveLength(1)
      expect(JSON.stringify(report)).not.toContain('private-stream-key')
      expect(JSON.stringify(report)).not.toContain('fixture-private-token')
      expect(JSON.stringify(report)).not.toContain('0x1234567890123456789012345678901234567890')
      expect(JSON.stringify(report)).not.toContain(first)
      expect(JSON.stringify(report)).not.toContain(second)
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('requires actual clean release and new lock acquisition before declaring restart recovery', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      const oldProcess = randomUUID(),
        newProcess = randomUUID()
      const injectedAt = start + 600_000
      await f.reliability.event('scheduled_restart', oldProcess, injectedAt, { restartIndex: 1 })
      await f.reliability.incident('restart:1', 'scheduled_restart', 'mainnet', injectedAt)
      expect(await f.reliability.restartRecovery(1, newProcess, injectedAt + 1_000, true)).toBe('pending')
      await f.reliability.event('lock_released', oldProcess, injectedAt + 2_000, { clean: true })
      await f.reliability.event('lock_acquired', newProcess, injectedAt + 3_000)
      expect(await f.reliability.restartRecovery(1, newProcess, injectedAt + 4_000, false)).toBe('pending')
      expect(await f.reliability.restartRecovery(1, newProcess, injectedAt + 5_000, true)).toBe('recovered')
      await f.reliability.incident('restart:2', 'scheduled_restart', 'mainnet', injectedAt + 6_000)
      expect(await f.reliability.restartRecovery(2, newProcess, injectedAt + 186_001, true)).toBe('violated')
      expect(
        (await f.reliability.report(injectedAt + 187_000)).incidents.some(
          (row) => row.kind === 'restart_recovery_timeout',
        ),
      ).toBe(true)
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('records restart intent atomically with its claim and rolls back every row on evidence-write failure', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      const oldProcess = randomUUID()
      const newProcess = randomUUID()
      const failing = new ReliabilityStore({
        ...f.store.pool,
        connect: async () => {
          const client = await f.store.pool.connect()
          return {
            query: async (sql: string, values?: unknown[]) => {
              if (sql.includes('INSERT INTO reliability_incidents')) throw Error('FIXTURE_EVIDENCE_WRITE_FAILED')
              return client.query(sql, values)
            },
            release: () => client.release(),
          }
        },
      } as typeof f.store.pool)
      await expect(failing.claimRestart(start + 600_000, oldProcess)).rejects.toThrow('FIXTURE_EVIDENCE_WRITE_FAILED')
      expect((await f.reliability.run())?.restarts_claimed).toBe(0)
      expect(new Date((await f.reliability.run())!.next_restart_at).getTime()).toBe(start + 600_000)
      expect((await f.db.query('SELECT id FROM reliability_events')).rows).toHaveLength(0)
      expect((await f.db.query('SELECT id FROM reliability_incidents')).rows).toHaveLength(0)
      expect(await f.reliability.restartRecovery(1, newProcess, start + 601_000, true)).toBe('pending')
      expect(await f.reliability.claimRestart(start + 600_000, oldProcess)).toEqual({ index: 1 })
      expect((await f.db.query('SELECT kind,restart_index FROM reliability_events')).rows).toEqual([
        { kind: 'scheduled_restart', restart_index: 1 },
      ])
      expect((await f.db.query('SELECT incident_key,status FROM reliability_incidents')).rows).toEqual([
        { incident_key: 'restart:1', status: 'OPEN' },
      ])
      expect(await f.reliability.claimRestart(start + 600_000, oldProcess)).toBeNull()
      await f.reliability.event('lock_released', oldProcess, start + 601_000, { clean: true })
      await f.reliability.event('lock_acquired', newProcess, start + 602_000)
      expect(await f.reliability.restartRecovery(1, newProcess, start + 603_000, true)).toBe('recovered')
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('reruns additive migration without changing campaign start or existing business rows', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      await f.db.exec(await readFile('database/migrations/041_reliability_run.sql', 'utf8'))
      expect(new Date((await f.reliability.run())!.started_at).getTime()).toBe(start)
      expect((await f.db.query('SELECT id FROM books')).rows).toEqual([{ id: f.book }])
      expect((await f.db.query('SELECT id FROM perpl_connections')).rows).toHaveLength(1)
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('publishes measured chaos failures but does not label failed attempts or unavailable tests as verified recovery', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      const invariants = {
        noDuplicateOrders: true,
        noUnknownResubmission: true,
        noPartialResubmission: true,
        failClosed: false,
      }
      await f.reliability.saveChaos(
        [
          {
            scenario: 'rpc-timeout',
            at: new Date(start + 1_000).toISOString(),
            status: 'failed',
            recoveryMs: 123,
            invariants,
            summary: 'private fixture details',
          },
        ],
        start + 1_000,
      )
      await f.reliability.saveChaos(
        [
          {
            scenario: 'database-connection-loss',
            at: new Date(start + 2_000).toISOString(),
            status: 'unavailable',
            recoveryMs: 456,
            invariants,
            summary: 'private fixture details',
          },
        ],
        start + 2_000,
      )
      const report = await f.reliability.report(start + 3_000)
      expect(report.chaos.find((row) => row.status === 'failed')).toMatchObject({ recoveryMs: null, invariants })
      expect(report.chaos.find((row) => row.status === 'unavailable')).toMatchObject({
        recoveryMs: null,
        invariants: null,
      })
      expect((await f.db.query('SELECT recovery_ms::text FROM reliability_chaos ORDER BY batch_at')).rows).toEqual([
        { recovery_ms: '123' },
        { recovery_ms: '456' },
      ])
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('reports completed UTC days from contiguous stored coverage rather than minimum and maximum bounds', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start, { EYELER_ANALYTICS_ROLLUPS_ENABLED: true })
      const day = 86_400_000
      await f.db.query(
        `INSERT INTO analytics_rollup_coverage(from_block,to_block,from_time,through_time,end_hash,log_count)
        VALUES(54773010,54773100,$1,$2,$3,0),(54773200,54773300,$4,$5,$3,0)`,
        [
          new Date(start - 30 * day),
          new Date(start - 16 * day),
          '0x' + 'a'.repeat(64),
          new Date(start - 15 * day),
          new Date(start),
        ],
      )
      const report = await f.reliability.report(start + 3_000)
      expect(report.analytics).toMatchObject({
        verifiedDays: 29,
        indexedBlock: 54773299,
        historyVerified: false,
        confirmedHead: null,
        lagBlocks: null,
      })
      expect(report.analytics.label).toContain('29/30 completed UTC days')
      expect(report.analytics.from).toBe(new Date(start - 30 * day).toISOString())
      expect(report.analytics.through).toBe(new Date(start).toISOString())
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('pages every incident with stable timestamp/id cursors, rejects malformed cursors and discloses preview truncation', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      await f.db.query(
        `INSERT INTO reliability_incidents(run_id,incident_key,kind,scope,detected_at,status,summary)
        SELECT $1,'private-key-'||n,'worker_unavailable','mainnet',$2,'OPEN','fixture-private-token'
        FROM generate_series(1,1001) n`,
        [RUN_ID, new Date(start + 1_000)],
      )
      const report = await f.reliability.report(start + 2_000)
      expect(report.totalIncidents).toBe(1001)
      expect(report.incidentPreviewTruncated).toBe(true)
      expect(report.incidents).toHaveLength(1000)
      const ids = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await f.reliability.incidentPage(cursor, 100)
        expect(page.total).toBe(1001)
        expect(page.incidents.length).toBeLessThanOrEqual(100)
        expect(JSON.stringify(page)).not.toContain('private-key-')
        expect(JSON.stringify(page)).not.toContain('fixture-private-token')
        for (const incident of page.incidents) {
          expect(ids.has(incident.id)).toBe(false)
          ids.add(incident.id)
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      expect(ids.size).toBe(1001)
      for (const malformed of [
        '',
        'x'.repeat(513),
        'invalid+padding=',
        Buffer.from('["2026-10-14","not-a-uuid"]').toString('base64url'),
        Buffer.from('["2026-10-14T00:00:01.000Z","' + randomUUID() + '","extra"]').toString('base64url'),
      ])
        await expect(f.reliability.incidentPage(malformed)).rejects.toThrow('RELIABILITY_CURSOR_INVALID')
      await expect(f.reliability.incidentPage(undefined, 101)).rejects.toThrow('RELIABILITY_LIMIT_INVALID')
    } finally {
      await f.db.close()
    }
  }, 30_000)

  it('ingests only in-window Book incident types, keeps source IDs private and recovers repeated safe-mode episodes once', async () => {
    const f = await fixture()
    try {
      await f.reliability.ensureRun(start)
      const sourceIds: string[] = []
      for (const [type, offset] of [
        ['SAFE_MODE_ENTERED', -1_000],
        ['UNRELATED_PRIVATE_EVENT', 500],
        ['SAFE_MODE_ENTERED', 1_000],
        ['DEFEND_UNKNOWN', 2_000],
        ['SAFE_MODE_EXITED', 3_000],
        ['SAFE_MODE_ENTERED', 4_000],
        ['BOOK_RECOVERED_MANUAL_ONLY', 5_000],
        ['REDUCE_PARTIAL', 6_000],
        ['EXIT_FAILED', 7_000],
        ['AUTOMATION_RETRY_EXHAUSTED', 8_000],
      ] as const) {
        const id = randomUUID()
        sourceIds.push(id)
        await f.db.query('INSERT INTO autopsy_events(id,book_id,type,payload,timestamp) VALUES($1,$2,$3,$4,$5)', [
          id,
          f.book,
          type,
          JSON.stringify({ private: 'fixture-private-token', wallet: '0x1234567890123456789012345678901234567890' }),
          new Date(start + offset),
        ])
      }
      await f.reliability.ingestBookIncidents(start + 9_000)
      await f.reliability.ingestBookIncidents(start + 10_000)
      const report = await f.reliability.report(start + 11_000)
      expect(report.totalIncidents).toBe(6)
      expect(report.incidents.filter((row) => row.kind === 'book_safe_mode')).toEqual([
        expect.objectContaining({
          status: 'recovered',
          detectedAt: new Date(start + 1_000).toISOString(),
          recoveredAt: new Date(start + 3_000).toISOString(),
          durationMs: 2_000,
        }),
        expect.objectContaining({
          status: 'recovered',
          detectedAt: new Date(start + 4_000).toISOString(),
          recoveredAt: new Date(start + 5_000).toISOString(),
          durationMs: 1_000,
        }),
      ])
      expect(
        report.incidents.filter((row) => row.kind !== 'book_safe_mode').every((row) => row.status === 'open'),
      ).toBe(true)
      for (const id of sourceIds) expect(JSON.stringify(report)).not.toContain(id)
      expect(JSON.stringify(report)).not.toContain('fixture-private-token')
      expect(JSON.stringify(report)).not.toContain('0x1234567890123456789012345678901234567890')
      expect((await f.db.query('SELECT automation_enabled,status FROM books WHERE id=$1', [f.book])).rows[0]).toEqual({
        automation_enabled: true,
        status: 'ACTIVE',
      })
    } finally {
      await f.db.close()
    }
  }, 30_000)
})
