import type pg from 'pg'
import { storedActionEvidence } from '../../../../packages/perpl/src/action-evidence.js'
import type { ReliabilityChaosResult } from '../../../../scripts/reliability/chaos.js'
import { readDailyRollupSeries } from '../analytics/daily-rollup-series.js'

export const RUN_ID = '10f69518-c44a-4c2a-9be5-6fd96c3b5d01'
export const RUN_DURATION_MS = 7 * 86_400_000
export const SAMPLE_INTERVAL_MS = 15_000
export type ReliabilityScope = 'mainnet' | 'sandbox'
export type ReliabilityRun = {
  id: string
  owner_user_id: string | null
  started_at: Date
  ends_at: Date
  status: 'RUNNING' | 'COMPLETED' | 'PAUSED'
  next_restart_at: Date
  next_chaos_at: Date
  restarts_claimed: number
  automation_paused: boolean
  trading_states: Record<string, boolean>
}
export type ReliabilityHealth = {
  running: boolean
  lastError?: string
  lastTickAgeMs?: number | null
  lockOwned: boolean
  venueReady: boolean
}

const incidentSummaries = {
  worker_unavailable: 'Worker telemetry does not satisfy the run health requirements.',
  lock_lost: 'Worker lease ownership was lost; transport authority is revoked.',
  websocket_disconnect: 'An unexpected Perpl WebSocket disconnect was observed.',
  duplicate_action: 'Duplicate persisted execution identities were detected.',
  unknown_resubmission: 'A transmit attempt for an UNKNOWN action was blocked.',
  partial_resubmission: 'A transmit attempt for a PARTIAL action was blocked.',
  database_unavailable: 'Database access is unavailable; automation is paused.',
  restart_recovery_timeout: 'Scheduled restart did not prove safe recovery within 180 seconds.',
  invariant_violation: 'An execution safety invariant failed; automation is paused.',
  configuration_changed: 'A recorded trading configuration state changed; automation is paused.',
  scheduled_restart: 'Scheduled process restart injected for lock and recovery verification.',
  chaos_unavailable: 'An isolated synthetic failure test could not complete its verification.',
  book_safe_mode: 'A Book entered safe mode; recovery requires a recorded safe-mode exit or guarded Book recovery.',
  book_action_unknown: 'A Book action has an uncertain venue outcome and requires reconciliation.',
  book_action_partial: 'A Book action has a partial result and requires reconciliation.',
  book_action_failed: 'A Book action failed; no successful recovery is inferred from the failed attempt.',
  book_retry_exhausted: 'A Book exhausted its bounded automatic retries and requires review.',
} as const
const eventKinds = new Set([
  'lock_acquired',
  'lock_released',
  'lock_lost',
  'worker_started',
  'worker_stopped',
  'scheduled_restart',
  'websocket_disconnect',
  'websocket_ready',
  'websocket_reconnect',
  'chaos_started',
  'chaos_completed',
])
const scenarios = new Set([
  'process-kill-mid-action',
  'websocket-disconnect',
  'stale-market-data',
  'rpc-timeout',
  'database-connection-loss',
  'competing-lock-instances',
  'delayed-partial-fills',
])
const flags = new Set([
  'EYELER_EXECUTION_DISABLED',
  'EYELER_OPENING_ENABLED',
  'EYELER_STRATEGIES_ENABLED',
  'EYELER_STRATEGIES_LIVE_ENABLED',
  'EYELER_ANALYTICS_ENABLED',
  'EYELER_ANALYTICS_ROLLUPS_ENABLED',
  'EYELER_ANALYTICS_SNAPSHOTS_ENABLED',
  'EYELER_ANALYTICS_WALLET_ONDEMAND_ENABLED',
  'EYELER_ANALYTICS_WALLET_LEDGER_ENABLED',
])
const reasons = new Set([
  'LIQ_FLOOR',
  'FUNDING_PRESSURE',
  'VOL_SPIKE',
  'DEPTH_BAD',
  'DEPTH_OK',
  'RESERVE_LOW',
  'RESERVE_OK',
  'DEFENSE_INEFFICIENT',
  'DEFENSE_REFUSED',
  'STALE_STATE',
  'AUTOMATION_PAUSED',
  'TIME_LIMIT',
  'WITHIN_LIMITS',
  'BOTH_STALE',
  'MARKET_STALE',
  'MARKET_UNKNOWN',
  'POSITION_STALE',
  'POSITION_UNKNOWN',
  'FUNDING_STALE',
  'FUNDING_UNKNOWN',
  'DEPTH_STALE',
  'DEPTH_UNKNOWN',
  'MANUAL_ACTION',
  'USER_CLOSE',
  'UNRESOLVED_ACTION',
  'RUNTIME_FAILURE',
  'VENUE_UNAVAILABLE',
  'DATA_UNAVAILABLE',
])
const states = new Set([
  'ACTIVE',
  'PAUSED',
  'CLOSED',
  'HOLD',
  'SAFE_MODE',
  'DEFEND',
  'REDUCE',
  'EXIT',
  'QUEUED',
  'VALIDATING',
  'SUBMITTING',
  'SUBMITTED',
  'VERIFYING',
  'CONFIRMED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
  'UNKNOWN',
  'PARTIAL',
])
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const time = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('RELIABILITY_TIME_INVALID')
  return new Date(value)
}
const iso = (value: unknown): string | null => {
  if (value == null) return null
  const parsed = new Date(value as string | Date)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}
const count = (value: unknown) => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw Error('RELIABILITY_COUNT_INVALID')
  return n
}
const scopeValid = (scope: string): scope is ReliabilityScope => scope === 'mainnet' || scope === 'sandbox'
const mainnetBooks = "(c.environment='mainnet' OR b.perpl_connection_id IS NULL)"
type IncidentRow = {
  id: string
  kind: keyof typeof incidentSummaries
  scope: ReliabilityScope
  detected_at: Date
  recovered_at: Date | null
  status: 'OPEN' | 'RECOVERED'
}
export type PublicReliabilityIncident = {
  id: string
  kind: string
  scope: ReliabilityScope
  detectedAt: string | null
  recoveredAt: string | null
  status: 'open' | 'recovered'
  durationMs: number | null
  summary: string
}
const publicIncident = (row: IncidentRow): PublicReliabilityIncident => ({
  id: row.id,
  kind: row.kind,
  scope: row.scope,
  detectedAt: iso(row.detected_at),
  recoveredAt: iso(row.recovered_at),
  status: row.status === 'RECOVERED' ? 'recovered' : 'open',
  durationMs: row.recovered_at
    ? Math.max(0, new Date(row.recovered_at).getTime() - new Date(row.detected_at).getTime())
    : null,
  summary: incidentSummaries[row.kind],
})

/** Durable observations and pre-send fences. No method submits an order or changes a live trading flag. */
export class ReliabilityStore {
  constructor(readonly pool: pg.Pool) {}

  async ensureRun(now: number, tradingStates: Record<string, boolean> = {}): Promise<ReliabilityRun> {
    const recorded = Object.fromEntries(
      Object.entries(tradingStates).filter(([name, state]) => flags.has(name) && typeof state === 'boolean'),
    )
    await this.pool.query(
      `INSERT INTO reliability_runs(id,owner_user_id,started_at,ends_at,status,next_restart_at,next_chaos_at,trading_states)
       VALUES($1,(SELECT CASE WHEN count(*)=1 THEN (array_agg(user_id))[1] ELSE NULL END FROM
         (SELECT DISTINCT c.user_id FROM perpl_accounts a JOIN perpl_connections c ON c.id=a.connection_id
          WHERE c.environment='mainnet' AND a.account_id=5471) owners),$2,$3,'RUNNING',$4,$2,$5)
       ON CONFLICT(id) DO NOTHING`,
      [RUN_ID, time(now), time(now + RUN_DURATION_MS), time(now + 600_000), JSON.stringify(recorded)],
    )
    await this.complete(now)
    return (await this.run())!
  }

  async run(): Promise<ReliabilityRun | null> {
    const result = await this.pool.query<ReliabilityRun>('SELECT * FROM reliability_runs WHERE id=$1', [RUN_ID])
    return result.rows[0] ?? null
  }

  async complete(now: number): Promise<void> {
    await this.pool.query(
      "UPDATE reliability_runs SET status='COMPLETED' WHERE id=$1 AND ends_at<=$2 AND status<>'COMPLETED'",
      [RUN_ID, time(now)],
    )
  }

  async sample(processId: string, health: ReliabilityHealth, now: number): Promise<void> {
    if (!uuid(processId)) throw Error('RELIABILITY_PROCESS_INVALID')
    const age = health.lastTickAgeMs
    const validAge = Number.isSafeInteger(age) && Number(age) >= 0 ? Number(age) : null
    const healthy =
      health.running &&
      health.lockOwned &&
      health.venueReady &&
      health.lastError === undefined &&
      validAge !== null &&
      validAge <= 15_000
    await this.pool.query(
      `INSERT INTO reliability_samples(run_id,slot_at,observed_at,process_id,healthy,running,lock_owned,venue_ready,tick_age_ms)
       SELECT id,$2,$3,$4,$5,$6,$7,$8,$9 FROM reliability_runs
       WHERE id=$1 AND started_at<=$3 AND ends_at>$3 AND status<>'COMPLETED'
       ON CONFLICT(run_id,slot_at) DO UPDATE SET observed_at=EXCLUDED.observed_at,process_id=EXCLUDED.process_id,
       healthy=EXCLUDED.healthy,running=EXCLUDED.running,lock_owned=EXCLUDED.lock_owned,
       venue_ready=EXCLUDED.venue_ready,tick_age_ms=EXCLUDED.tick_age_ms
       WHERE NOT reliability_samples.lock_owned AND EXCLUDED.lock_owned`,
      [
        RUN_ID,
        time(Math.floor(now / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS),
        time(now),
        processId,
        healthy,
        health.running === true,
        health.lockOwned === true,
        health.venueReady === true,
        validAge,
      ],
    )
    await this.complete(now)
  }

  async event(
    kind: string,
    processId: string,
    now: number,
    detail?: { restartIndex?: number; clean?: boolean },
    scope: ReliabilityScope = 'mainnet',
  ): Promise<void> {
    if (!eventKinds.has(kind) || !uuid(processId) || !scopeValid(scope)) throw Error('RELIABILITY_EVENT_INVALID')
    const index = detail?.restartIndex
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 1 || index > 7))
      throw Error('RELIABILITY_EVENT_INVALID')
    await this.pool.query(
      `INSERT INTO reliability_events(run_id,kind,scope,process_id,observed_at,restart_index,clean)
       SELECT id,$2,$3,$4,$5,$6,$7 FROM reliability_runs WHERE id=$1 AND started_at<=$5 AND ends_at>$5
       ON CONFLICT(run_id,kind,process_id,observed_at) DO NOTHING`,
      [
        RUN_ID,
        kind,
        scope,
        processId,
        time(now),
        index ?? null,
        typeof detail?.clean === 'boolean' ? detail.clean : null,
      ],
    )
  }

  async incident(key: string, kind: string, scope: ReliabilityScope, now: number): Promise<void> {
    if (!Object.hasOwn(incidentSummaries, kind) || !/^[a-z0-9:_-]{1,160}$/i.test(key) || !scopeValid(scope))
      throw Error('RELIABILITY_INCIDENT_INVALID')
    await this.pool.query(
      `INSERT INTO reliability_incidents(run_id,incident_key,kind,scope,detected_at,status,summary)
       SELECT id,$2,$3,$4,$5,'OPEN',$6 FROM reliability_runs WHERE id=$1 AND started_at<=$5 AND ends_at>$5
       ON CONFLICT(run_id,incident_key) WHERE status='OPEN' DO NOTHING`,
      [RUN_ID, key, kind, scope, time(now), incidentSummaries[kind as keyof typeof incidentSummaries]],
    )
  }

  async recover(key: string, now: number): Promise<void> {
    await this.pool.query(
      "UPDATE reliability_incidents SET recovered_at=$3,status='RECOVERED' WHERE run_id=$1 AND incident_key=$2 AND status='OPEN' AND detected_at<=$3",
      [RUN_ID, key, time(now)],
    )
  }

  async incidentPage(
    cursor?: string,
    limit = 100,
  ): Promise<{ incidents: PublicReliabilityIncident[]; nextCursor: string | null; total: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('RELIABILITY_LIMIT_INVALID')
    let boundary: [string, string] | null = null
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error()
        const decoded = Buffer.from(cursor, 'base64url')
        if (decoded.toString('base64url') !== cursor) throw Error()
        const value: unknown = JSON.parse(decoded.toString('utf8'))
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          typeof value[0] !== 'string' ||
          typeof value[1] !== 'string' ||
          !uuid(value[1]) ||
          iso(value[0]) !== value[0]
        )
          throw Error()
        boundary = [value[0], value[1]]
      } catch {
        throw Error('RELIABILITY_CURSOR_INVALID')
      }
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const rows = await client.query<IncidentRow>(
        `SELECT id,kind,scope,detected_at,recovered_at,status FROM reliability_incidents
         WHERE run_id=$1 AND kind=ANY($2::text[]) AND
           ($3::timestamptz IS NULL OR (detected_at,id)>($3::timestamptz,$4::uuid))
         ORDER BY detected_at,id LIMIT $5`,
        [RUN_ID, Object.keys(incidentSummaries), boundary?.[0] ?? null, boundary?.[1] ?? null, limit + 1],
      )
      const totals = await client.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM reliability_incidents WHERE run_id=$1 AND kind=ANY($2::text[])',
        [RUN_ID, Object.keys(incidentSummaries)],
      )
      await client.query('COMMIT')
      const page = rows.rows.slice(0, limit)
      const last = page.at(-1)
      return {
        incidents: page.map(publicIncident),
        nextCursor:
          rows.rows.length > limit && last
            ? Buffer.from(JSON.stringify([iso(last.detected_at), last.id])).toString('base64url')
            : null,
        total: count(totals.rows[0]?.total ?? 0),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /** Observe durable Book transitions in bounded batches, without reading payloads or changing business state. */
  async ingestBookIncidents(now: number): Promise<void> {
    const client = await this.pool.connect()
    const at = time(now)
    try {
      await client.query('BEGIN')
      await client.query(
        `WITH pending AS (
          SELECT r.id AS run_id,e.id AS source_id,e.timestamp,
            CASE WHEN e.type='SAFE_MODE_ENTERED' THEN 'book_safe_mode'
              WHEN e.type='AUTOMATION_RETRY_EXHAUSTED' THEN 'book_retry_exhausted'
              WHEN right(e.type,8)='_UNKNOWN' THEN 'book_action_unknown'
              WHEN right(e.type,8)='_PARTIAL' THEN 'book_action_partial'
              ELSE 'book_action_failed' END AS kind
          FROM autopsy_events e JOIN books b ON b.id=e.book_id
          LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id
          JOIN reliability_runs r ON r.id=$1
          WHERE e.timestamp>=r.started_at AND e.timestamp<r.ends_at AND e.timestamp<$2
            AND ${mainnetBooks} AND e.type=ANY($3::text[])
            AND NOT EXISTS(SELECT 1 FROM reliability_incidents i WHERE i.run_id=r.id AND i.source_event_id=e.id)
          ORDER BY e.timestamp,e.id LIMIT 1000
        )
        INSERT INTO reliability_incidents(run_id,source_event_id,incident_key,kind,scope,detected_at,status,summary)
        SELECT run_id,source_id,'book-event:'||source_id::text,kind,'mainnet',timestamp,'OPEN',($4::jsonb)->>kind FROM pending
        ON CONFLICT(run_id,source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING`,
        [
          RUN_ID,
          at,
          [
            'SAFE_MODE_ENTERED',
            'AUTOMATION_RETRY_EXHAUSTED',
            'DEFEND_UNKNOWN',
            'REDUCE_UNKNOWN',
            'EXIT_UNKNOWN',
            'DEFEND_PARTIAL',
            'REDUCE_PARTIAL',
            'EXIT_PARTIAL',
            'DEFEND_FAILED',
            'REDUCE_FAILED',
            'EXIT_FAILED',
          ],
          JSON.stringify(incidentSummaries),
        ],
      )
      await client.query(
        `UPDATE reliability_incidents i SET status='RECOVERED',recovered_at=recovery.at
         FROM (
           SELECT incident.id,min(exited.timestamp) AS at
           FROM reliability_incidents incident JOIN autopsy_events entered ON entered.id=incident.source_event_id
           JOIN autopsy_events exited ON exited.book_id=entered.book_id
             AND exited.type IN ('SAFE_MODE_EXITED','BOOK_RECOVERED_MANUAL_ONLY','BOOK_RECOVERED_AFTER_VERIFIED_ACTION')
             AND exited.timestamp>=entered.timestamp
           JOIN reliability_runs r ON r.id=incident.run_id
           WHERE incident.run_id=$1 AND incident.kind='book_safe_mode' AND incident.status='OPEN'
             AND exited.timestamp>=r.started_at AND exited.timestamp<r.ends_at AND exited.timestamp<$2
           GROUP BY incident.id
         ) recovery WHERE i.id=recovery.id`,
        [RUN_ID, at],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async saveChaos(results: ReliabilityChaosResult[], batchAt: number): Promise<void> {
    for (const result of results) {
      if (
        !scenarios.has(result.scenario) ||
        !['passed', 'failed', 'unavailable'].includes(result.status) ||
        !iso(result.at) ||
        !Number.isFinite(result.recoveryMs) ||
        result.recoveryMs < 0 ||
        !['noDuplicateOrders', 'noUnknownResubmission', 'noPartialResubmission', 'failClosed'].every(
          (key) => typeof result.invariants[key as keyof typeof result.invariants] === 'boolean',
        )
      )
        throw Error('RELIABILITY_CHAOS_INVALID')
      const proven = Object.values(result.invariants).every(Boolean)
      const status = result.status === 'passed' && !proven ? 'failed' : result.status
      await this.pool.query(
        `INSERT INTO reliability_chaos(run_id,batch_at,scenario,injected_at,status,recovery_ms,
         no_duplicate_orders,no_unknown_resubmission,no_partial_resubmission,fail_closed)
         SELECT id,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM reliability_runs WHERE id=$1 AND started_at<=$2 AND ends_at>$2
         ON CONFLICT(run_id,batch_at,scenario) DO NOTHING`,
        [
          RUN_ID,
          time(batchAt),
          result.scenario,
          new Date(result.at),
          status,
          result.recoveryMs,
          result.invariants.noDuplicateOrders,
          result.invariants.noUnknownResubmission,
          result.invariants.noPartialResubmission,
          result.invariants.failClosed,
        ],
      )
    }
  }

  async claimRestart(now: number, processId?: string): Promise<{ index: number } | null> {
    if (processId !== undefined && !uuid(processId)) throw Error('RELIABILITY_PROCESS_INVALID')
    const at = time(now)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<{ restarts_claimed: number }>(
        `UPDATE reliability_runs SET restarts_claimed=restarts_claimed+1,next_restart_at=$3
         WHERE id=$1 AND status='RUNNING' AND NOT automation_paused AND next_restart_at<=$2
         AND ends_at>$2 AND restarts_claimed<7 RETURNING restarts_claimed`,
        [RUN_ID, at, time(now + 86_400_000)],
      )
      const claimed = result.rows.length ? { index: result.rows[0].restarts_claimed } : null
      if (claimed && processId !== undefined) {
        await client.query(
          `INSERT INTO reliability_events(run_id,kind,scope,process_id,observed_at,restart_index)
           VALUES($1,'scheduled_restart','mainnet',$2,$3,$4)`,
          [RUN_ID, processId, at, claimed.index],
        )
        await client.query(
          `INSERT INTO reliability_incidents(run_id,incident_key,kind,scope,detected_at,status,summary)
           VALUES($1,$2,'scheduled_restart','mainnet',$3,'OPEN',$4)`,
          [RUN_ID, `restart:${claimed.index}`, at, incidentSummaries.scheduled_restart],
        )
      }
      await client.query('COMMIT')
      return claimed
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async claimChaos(now: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE reliability_runs SET next_chaos_at=$3 WHERE id=$1 AND status='RUNNING'
       AND NOT automation_paused AND next_chaos_at<=$2 AND ends_at>$2 RETURNING id`,
      [RUN_ID, time(now), time(now + 6 * 3_600_000)],
    )
    return result.rows.length === 1
  }

  async pause(now: number): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const run = await client.query(
        "UPDATE reliability_runs SET status='PAUSED',automation_paused=true WHERE id=$1 AND ends_at>$2 AND status<>'COMPLETED' RETURNING id",
        [RUN_ID, time(now)],
      )
      if (run.rows.length) {
        await client.query(
          `UPDATE books b SET status='SAFE_MODE',automation_enabled=false,safe_mode_reason='RUNTIME_FAILURE',
           safe_mode_since=COALESCE(safe_mode_since,$1),updated_at=$1 WHERE automation_enabled AND status<>'CLOSED'
           AND (perpl_connection_id IS NULL OR EXISTS(SELECT 1 FROM perpl_connections c WHERE c.id=b.perpl_connection_id AND c.environment='mainnet'))`,
          [time(now)],
        )
        await client.query(
          "UPDATE strategies SET status='PAUSED',updated_at=$1 WHERE environment='mainnet' AND mode='PAPER' AND status='RUNNING'",
          [time(now)],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async recordBookSend(actionId: string, now: number): Promise<void> {
    if (!uuid(actionId)) throw Error('RELIABILITY_ACTION_INVALID')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const run = await client.query<ReliabilityRun>(
        "SELECT * FROM reliability_runs WHERE id=$1 AND started_at<=$2 AND ends_at>$2 AND status<>'COMPLETED' FOR UPDATE",
        [RUN_ID, time(now)],
      )
      if (run.rows.length) {
        if (run.rows[0].automation_paused || run.rows[0].status === 'PAUSED')
          throw Error('RELIABILITY_AUTOMATION_PAUSED')
        const action = await client.query<{ status: string; created_at: Date }>(
          'SELECT a.status,d.created_at FROM actions a JOIN decisions d ON d.id=a.decision_id WHERE a.id=$1 FOR UPDATE OF a',
          [actionId],
        )
        const row = action.rows[0]
        if (row?.status === 'UNKNOWN') throw Error('RELIABILITY_UNKNOWN_RESUBMISSION')
        if (row?.status === 'PARTIAL') throw Error('RELIABILITY_PARTIAL_RESUBMISSION')
        if (
          !row ||
          row.status !== 'SUBMITTING' ||
          new Date(row.created_at).getTime() < new Date(run.rows[0].started_at).getTime()
        )
          throw Error('RELIABILITY_SEND_STATE_INVALID')
        const sent = await client.query(
          'INSERT INTO reliability_book_sends(run_id,action_id,attempted_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING action_id',
          [RUN_ID, actionId, time(now)],
        )
        if (!sent.rows.length) throw Error('RELIABILITY_DUPLICATE_SEND')
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async duplicateActions(from: Date, to: Date): Promise<number> {
    const result = await this.pool.query<{ duplicates: string }>(
      `SELECT (SELECT COALESCE(sum(n-1),0) FROM (SELECT count(*) n FROM actions a JOIN decisions d ON d.id=a.decision_id
         JOIN books b ON b.id=a.book_id LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id
         WHERE d.created_at>=$1 AND d.created_at<$2 AND ${mainnetBooks} GROUP BY a.book_id,a.decision_id HAVING count(*)>1) x)
       +(SELECT COALESCE(sum(n-1),0) FROM (SELECT count(*) n FROM actions a JOIN decisions d ON d.id=a.decision_id
         JOIN books b ON b.id=a.book_id LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id
         WHERE d.created_at>=$1 AND d.created_at<$2 AND ${mainnetBooks} AND a.request_id IS NOT NULL
         GROUP BY b.venue_account_id,a.request_id HAVING count(*)>1) x)
       +(SELECT COALESCE(sum(n-1),0) FROM (SELECT count(*) n FROM reserve_ledger_entries
         WHERE type='RESERVE_DEPLOYED' AND created_at>=$1 AND created_at<$2 GROUP BY action_id HAVING count(*)>1) x) AS duplicates`,
      [from, to],
    )
    return count(result.rows[0]?.duplicates ?? 0)
  }

  async restartRecovery(
    index: number,
    processId: string,
    now: number,
    healthy: boolean,
  ): Promise<'pending' | 'recovered' | 'violated'> {
    const key = `restart:${index}`
    const incident = await this.pool.query<{ detected_at: Date; status: string }>(
      'SELECT detected_at,status FROM reliability_incidents WHERE run_id=$1 AND incident_key=$2',
      [RUN_ID, key],
    )
    const row = incident.rows[0]
    if (!row) return 'pending'
    if (row.status === 'RECOVERED') return 'recovered'
    const run = await this.run()
    if (!run) return 'pending'
    const events = await this.pool.query<{ clean: boolean }>(
      `SELECT true AS clean FROM reliability_events request
       JOIN reliability_events released ON released.run_id=request.run_id AND released.process_id=request.process_id
         AND released.kind='lock_released' AND released.clean=true AND released.observed_at>=request.observed_at
       JOIN reliability_events acquired ON acquired.run_id=request.run_id AND acquired.process_id=$3
         AND acquired.kind='lock_acquired' AND acquired.observed_at>=released.observed_at
       WHERE request.run_id=$1 AND request.kind='scheduled_restart' AND request.restart_index=$2
         AND request.process_id<>$3 AND request.observed_at>=$4 AND acquired.observed_at<=$5 LIMIT 1`,
      [RUN_ID, index, processId, row.detected_at, time(now)],
    )
    const elapsed = now - new Date(row.detected_at).getTime()
    if (
      healthy &&
      elapsed <= 180_000 &&
      events.rows.length &&
      !(await this.duplicateActions(run.started_at, time(now)))
    ) {
      await this.recover(key, now)
      return 'recovered'
    }
    if (elapsed > 180_000) {
      await this.incident(`restart-timeout:${index}`, 'restart_recovery_timeout', 'mainnet', now)
      return 'violated'
    }
    return 'pending'
  }

  async report(now: number) {
    const run = await this.run()
    if (!run) throw Error('RELIABILITY_RUN_NOT_STARTED')
    const from = new Date(run.started_at),
      to = time(Math.min(now, new Date(run.ends_at).getTime()))
    const params = [from, to]
    const completedDayEnd = Math.floor(now / 86_400_000) * 86_400_000
    const [
      samples,
      events,
      armed,
      decisions,
      actions,
      sends,
      paper,
      paperOrders,
      paperFills,
      paperFees,
      coverage,
      incidents,
      incidentTotals,
      chaos,
      duplicates,
    ] = await Promise.all([
      this.pool.query(
        'SELECT slot_at,observed_at,healthy,lock_owned,tick_age_ms FROM reliability_samples WHERE run_id=$1 AND slot_at<$2 ORDER BY slot_at',
        [RUN_ID, to],
      ),
      this.pool.query(
        'SELECT kind,process_id,observed_at,clean,scope FROM reliability_events WHERE run_id=$1 AND observed_at<=$2 ORDER BY observed_at,id',
        [RUN_ID, to],
      ),
      this.pool.query(
        `SELECT count(*) n FROM books b LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id WHERE b.automation_enabled AND b.status<>'CLOSED' AND ${mainnetBooks}`,
      ),
      this.pool.query(
        `SELECT d.action,d.state,d.reason_codes,d.created_at FROM decisions d JOIN books b ON b.id=d.book_id LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id WHERE d.created_at>=$1 AND d.created_at<$2 AND ${mainnetBooks} ORDER BY d.created_at DESC LIMIT 200`,
        params,
      ),
      this.pool.query(
        `SELECT a.kind,a.status,a.venue_reference,a.venue_progress,a.submitted_at,a.confirmed_at,d.created_at,b.venue_account_id FROM actions a JOIN decisions d ON d.id=a.decision_id JOIN books b ON b.id=a.book_id LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id WHERE d.created_at>=$1 AND d.created_at<$2 AND ${mainnetBooks} ORDER BY d.created_at DESC LIMIT 200`,
        params,
      ),
      this.pool.query('SELECT count(*) n FROM reliability_book_sends WHERE run_id=$1', [RUN_ID]),
      this.pool.query(
        "SELECT count(*) n FROM strategies WHERE environment='mainnet' AND mode='PAPER' AND status='RUNNING'",
      ),
      this.pool.query(
        "SELECT count(*) n FROM strategy_orders o JOIN strategies s ON s.id=o.strategy_id WHERE s.environment='mainnet' AND s.mode='PAPER' AND o.simulated AND o.created_at>=$1 AND o.created_at<$2",
        params,
      ),
      this.pool.query(
        "SELECT count(*) n FROM strategy_fills f JOIN strategies s ON s.id=f.strategy_id WHERE s.environment='mainnet' AND s.mode='PAPER' AND f.simulated AND f.filled_at>=$1 AND f.filled_at<$2",
        params,
      ),
      this.pool.query(
        "SELECT COALESCE(sum(f.fee),0)::text fees FROM strategy_fills f JOIN strategies s ON s.id=f.strategy_id WHERE s.environment='mainnet' AND s.mode='PAPER' AND f.simulated AND f.filled_at>=$1 AND f.filled_at<$2",
        params,
      ),
      readDailyRollupSeries(this.pool, 'fees', new Date(completedDayEnd - 30 * 86_400_000), new Date(completedDayEnd)),
      this.pool.query<IncidentRow>(
        'SELECT id,kind,scope,detected_at,recovered_at,status FROM reliability_incidents WHERE run_id=$1 AND kind=ANY($2::text[]) ORDER BY detected_at,id LIMIT 1000',
        [RUN_ID, Object.keys(incidentSummaries)],
      ),
      this.pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM reliability_incidents WHERE run_id=$1 AND kind=ANY($2::text[])',
        [RUN_ID, Object.keys(incidentSummaries)],
      ),
      this.pool.query(
        'SELECT scenario,injected_at,status,recovery_ms,no_duplicate_orders,no_unknown_resubmission,no_partial_resubmission,fail_closed FROM reliability_chaos WHERE run_id=$1 ORDER BY batch_at,scenario LIMIT 2000',
        [RUN_ID],
      ),
      this.duplicateActions(from, to),
    ])
    let observedMs = 0,
      healthyMs = 0
    for (const sample of samples.rows) {
      const slot = new Date(sample.slot_at).getTime()
      const span = Math.max(0, Math.min(slot + SAMPLE_INTERVAL_MS, to.getTime()) - Math.max(slot, from.getTime()))
      observedMs += span
      if (sample.healthy) healthyMs += span
    }
    const elapsedMs = Math.max(0, to.getTime() - from.getTime())
    const last = samples.rows.at(-1)
    const fresh = !!last && now - new Date(last.observed_at).getTime() <= 30_000
    let priorOwner: string | null = null,
      cleanRelease = false,
      handovers = 0
    for (const event of events.rows.filter((row) => row.scope === 'mainnet')) {
      if (event.kind === 'lock_released' && event.process_id === priorOwner) cleanRelease = event.clean === true
      if (event.kind === 'lock_acquired') {
        if (priorOwner && priorOwner !== event.process_id && cleanRelease) handovers++
        priorOwner = event.process_id
        cleanRelease = false
      }
    }
    const wsEvents = events.rows.filter((row) => row.scope === 'mainnet' && row.kind.startsWith('websocket_'))
    const tickAge =
      fresh && last.tick_age_ms != null
        ? count(last.tick_age_ms) + Math.max(0, now - new Date(last.observed_at).getTime())
        : null
    return {
      version: 1,
      observedAt: time(now).toISOString(),
      run: {
        id: run.id,
        startedAt: from.toISOString(),
        endsAt: new Date(run.ends_at).toISOString(),
        status: now >= new Date(run.ends_at).getTime() ? 'completed' : run.status.toLowerCase(),
        environment: 'mainnet',
        durationDays: 7,
      },
      availability: {
        uptimePercent: elapsedMs ? Math.round((10000 * healthyMs) / elapsedMs) / 100 : null,
        observedSeconds: Math.floor(observedMs / 1000),
        unobservedSeconds: Math.floor((elapsedMs - observedMs) / 1000),
        lastHeartbeatAt: iso(last?.observed_at),
        workerTickAgeMs: tickAge,
        lockOwned: fresh ? last.lock_owned === true : null,
        handovers,
        websocket: {
          disconnects: wsEvents.filter((row) => row.kind === 'websocket_disconnect').length,
          reconnects: wsEvents.filter((row) => row.kind === 'websocket_reconnect').length,
          available: wsEvents.length > 0,
        },
      },
      books: {
        armedCount: count(armed.rows[0]?.n ?? 0),
        decisions: decisions.rows.map((row) => ({
          at: iso(row.created_at),
          kind: states.has(row.action) ? row.action : 'UNAVAILABLE',
          status: states.has(row.state) ? row.state : 'UNAVAILABLE',
          reasonCodes: Array.isArray(row.reason_codes)
            ? row.reason_codes.filter((value: unknown) => typeof value === 'string' && reasons.has(value))
            : [],
        })),
        actions: actions.rows.map((row) => {
          const proof = storedActionEvidence({
            kind: row.kind,
            status: row.status,
            accountId: row.venue_account_id,
            venueReference: row.venue_reference,
            venueProgress: row.venue_progress,
          })
          const explorerUrl = proof.receiptBacked
            ? `https://monadvision.com/tx/${proof.transactionHash}`
            : proof.executionBlock
              ? `https://monadvision.com/block/${proof.executionBlock}`
              : null
          return {
            at: iso(row.submitted_at ?? row.created_at),
            kind: states.has(row.kind) ? row.kind : 'UNAVAILABLE',
            status: states.has(row.status) ? row.status : 'UNAVAILABLE',
            explorerUrl,
          }
        }),
        duplicateActions: duplicates,
        sendCount: count(sends.rows[0]?.n ?? 0),
      },
      paper: {
        runningCount: count(paper.rows[0]?.n ?? 0),
        simulatedOrders: count(paperOrders.rows[0]?.n ?? 0),
        simulatedFills: count(paperFills.rows[0]?.n ?? 0),
        stats: [{ label: 'Simulated fill fees (AUSD)', value: String(paperFees.rows[0]?.fees ?? '0') }],
      },
      analytics: {
        label: `${coverage.completeDays}/30 completed UTC days covered by contiguous stored rollups.`,
        from: coverage.coverageFrom,
        through: coverage.coverageThrough,
        asOf: coverage.asOf,
        indexedBlock: coverage.block,
        confirmedHead: null,
        lagBlocks: null,
        verifiedDays: coverage.completeDays,
        requestedDays: 30,
        historyVerified: false,
        rollupsEnabled: run.trading_states.EYELER_ANALYTICS_ROLLUPS_ENABLED ?? null,
      },
      incidents: incidents.rows.map(publicIncident),
      totalIncidents: count(incidentTotals.rows[0]?.total ?? 0),
      incidentPreviewTruncated: count(incidentTotals.rows[0]?.total ?? 0) > incidents.rows.length,
      chaos: chaos.rows
        .filter((row) => scenarios.has(row.scenario))
        .map((row) => ({
          scenario: row.scenario,
          at: iso(row.injected_at),
          status: row.status,
          recoveryMs: row.status === 'passed' ? Number(row.recovery_ms) : null,
          invariants:
            row.status === 'unavailable'
              ? null
              : {
                  noDuplicateOrders: row.no_duplicate_orders,
                  noUnknownResubmission: row.no_unknown_resubmission,
                  noPartialResubmission: row.no_partial_resubmission,
                  failClosed: row.fail_closed,
                },
        })),
      limitations: [
        'Availability is sampled worker health at 15-second intervals, not continuous API or exchange uptime; missing intervals remain unobserved.',
        'WebSocket counts cover observed private and market transports in this process; inactive wallets create no transport evidence.',
        'No armed Book or running Paper strategy is started by this report. Paper statistics are simulated and do not prove profitability.',
        'Book send counts are durable pre-send admission attempts. Stored explorer evidence is not independently reverified by this report.',
        'Synthetic chaos tests use isolated fixtures without real venue funds. Unavailable tests indicate missing proof, not a measured invariant failure.',
        'Analytics coverage counts complete UTC days within contiguous stored ranges. Current canonicality and confirmed-head lag are not independently reverified by this report.',
        'Decision and action feeds show the latest 200 rows and chaos results the first 2000. The incident preview shows up to 1000; the public incident-history endpoint pages every incident.',
        'Book incidents follow recorded durable transitions, ingested up to 1000 per poll. Unrecorded intermediate action states cannot be reconstructed; UNKNOWN and PARTIAL outcomes are not treated as duplicate-order proof.',
      ],
    }
  }
}
