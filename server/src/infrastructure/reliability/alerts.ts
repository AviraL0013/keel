import type pg from 'pg'

export type ReliabilityAlertHealth = {
  configured: boolean
  linkedRecipients: number
  reason?: 'BOT_NOT_CONFIGURED' | 'RUN_OWNER_UNAVAILABLE' | 'OWNER_TELEGRAM_NOT_LINKED' | 'DATABASE_UNAVAILABLE'
}

const incidentLabels = {
  duplicate_action: 'Duplicate action detected',
  unknown_resubmission: 'UNKNOWN action resubmission detected',
  partial_resubmission: 'PARTIAL action resubmission detected',
  database_unavailable: 'Database connection unavailable',
  restart_recovery_timeout: 'Restart recovery exceeded its deadline',
  invariant_violation: 'Safety invariant violated',
  configuration_changed: 'Recorded trading configuration changed',
  INVARIANT_VIOLATION: 'Safety invariant violated',
  DATABASE: 'Database connection unavailable',
  RESTART_RECOVERY_TIMEOUT: 'Restart recovery exceeded its deadline',
} as const

type ClaimedAlert = { incident_id: string; recipient_link_id: string }
type ActiveAlert = {
  kind: keyof typeof incidentLabels
  detected_at: Date | string
  chat_id: string
}

/**
 * Incident alerts target only the owner of this reliability campaign. Claims
 * commit before any network call. UNKNOWN and every other claimed outcome are
 * terminal here; manual operator review is required before any resend.
 */
export class ReliabilityAlerts {
  private readonly botToken: string | undefined

  constructor(
    private readonly pool: pg.Pool,
    env: Record<string, string | undefined>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.botToken = env.TELEGRAM_BOT_TOKEN?.trim() || undefined
  }

  async health(): Promise<ReliabilityAlertHealth> {
    if (!this.botToken) return { configured: false, linkedRecipients: 0, reason: 'BOT_NOT_CONFIGURED' }
    try {
      const result = await this.pool.query<{ owner_user_id: string | null; linked: number }>(
        `SELECT r.owner_user_id,
          (SELECT count(*)::int FROM telegram_links l WHERE l.user_id=r.owner_user_id AND l.revoked_at IS NULL) AS linked
         FROM reliability_runs r ORDER BY r.started_at DESC,r.id DESC LIMIT 1`,
      )
      const row = result.rows[0]
      if (!row?.owner_user_id) return { configured: false, linkedRecipients: 0, reason: 'RUN_OWNER_UNAVAILABLE' }
      if (Number(row.linked) !== 1)
        return { configured: false, linkedRecipients: 0, reason: 'OWNER_TELEGRAM_NOT_LINKED' }
      return { configured: true, linkedRecipients: 1 }
    } catch {
      return { configured: false, linkedRecipients: 0, reason: 'DATABASE_UNAVAILABLE' }
    }
  }

  /** At most one message per poll; this also respects Telegram's per-chat rate. */
  async flush(runId: string): Promise<void> {
    if (!this.botToken) return
    try {
      await this.pool.query(
        `UPDATE reliability_alert_deliveries SET status='UNKNOWN',last_error='OUTCOME_UNKNOWN'
         WHERE run_id=$1 AND status='SENDING' AND started_at<=now()-interval '60 seconds'`,
        [runId],
      )
      // A single SQL statement atomically selects and durably claims. If the
      // database outcome is unknown, no network call occurs on this invocation.
      const result = await this.pool.query<ClaimedAlert>(
        `WITH candidate AS (
          SELECT i.id AS incident_id,i.run_id,l.id AS recipient_link_id
          FROM reliability_incidents i JOIN reliability_runs r ON r.id=i.run_id
          JOIN telegram_links l ON l.user_id=r.owner_user_id AND l.revoked_at IS NULL
          LEFT JOIN reliability_alert_deliveries d ON d.incident_id=i.id
          WHERE r.id=$1 AND r.status IN ('RUNNING','PAUSED') AND r.ends_at>now() AND r.automation_paused=true
            AND i.scope='mainnet' AND i.status='OPEN' AND i.kind=ANY($2::text[]) AND d.incident_id IS NULL
          ORDER BY i.detected_at,i.id LIMIT 1
        )
        INSERT INTO reliability_alert_deliveries(incident_id,run_id,recipient_link_id,status)
        SELECT incident_id,run_id,recipient_link_id,'SENDING' FROM candidate
        ON CONFLICT(incident_id) DO NOTHING RETURNING incident_id,recipient_link_id`,
        [runId, Object.keys(incidentLabels)],
      )
      const claimed = result.rows[0]
      if (!claimed) return
      const active = await this.pool.query<ActiveAlert>(
        `SELECT i.kind,i.detected_at,l.chat_id
         FROM reliability_incidents i JOIN reliability_runs r ON r.id=i.run_id
         JOIN reliability_alert_deliveries d ON d.incident_id=i.id
         JOIN telegram_links l ON l.id=d.recipient_link_id AND l.user_id=r.owner_user_id AND l.revoked_at IS NULL
         WHERE r.id=$1 AND i.id=$2 AND l.id=$3 AND r.status IN ('RUNNING','PAUSED') AND r.ends_at>now()
           AND r.automation_paused=true AND i.status='OPEN' AND i.scope='mainnet' AND i.kind=ANY($4::text[])
           AND d.status='SENDING'`,
        [runId, claimed.incident_id, claimed.recipient_link_id, Object.keys(incidentLabels)],
      )
      const alert = active.rows[0]
      if (!alert) {
        await this.finish(claimed.incident_id, 'CANCELED', 'INCIDENT_NO_LONGER_ACTIVE')
        return
      }
      const detected = new Date(alert.detected_at)
      if (!Number.isFinite(detected.getTime()) || !(alert.kind in incidentLabels)) {
        await this.finish(claimed.incident_id, 'CANCELED', 'INCIDENT_NO_LONGER_ACTIVE')
        return
      }
      let outcome: 'SENT' | 'FAILED' | 'UNKNOWN' = 'UNKNOWN'
      try {
        const response = await this.fetcher(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: alert.chat_id,
            text: `EYELER reliability: ${incidentLabels[alert.kind]}.\nDetected: ${detected.toISOString()}\nAutomation is paused.\nhttps://app.eyeler.xyz/#/status`,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) outcome = 'FAILED'
        else {
          const body: unknown = await response.json()
          outcome = body !== null && typeof body === 'object' && 'ok' in body && body.ok === true ? 'SENT' : 'FAILED'
        }
      } catch {
        // Never expose the token-bearing URL, response body or raw error.
      }
      await this.finish(
        claimed.incident_id,
        outcome,
        outcome === 'SENT' ? null : outcome === 'FAILED' ? 'TELEGRAM_REJECTED' : 'OUTCOME_UNKNOWN',
      )
    } catch {
      // No raw PostgreSQL or Telegram error escapes this public-safe boundary.
      throw new Error('RELIABILITY_ALERTS_DATABASE_UNAVAILABLE')
    }
  }

  private async finish(
    incidentId: string,
    status: 'SENT' | 'FAILED' | 'UNKNOWN' | 'CANCELED',
    error: 'OUTCOME_UNKNOWN' | 'TELEGRAM_REJECTED' | 'INCIDENT_NO_LONGER_ACTIVE' | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE reliability_alert_deliveries SET status=$2,last_error=$3,
       delivered_at=CASE WHEN $2='SENT' THEN now() ELSE delivered_at END
       WHERE incident_id=$1 AND status='SENDING'`,
      [incidentId, status, error],
    )
  }
}
