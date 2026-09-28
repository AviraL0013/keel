import type pg from 'pg'
import { brandEnv, logger } from '../../config/index.js'

export type SnapshotRetentionConfig = {
  fullMs: number
  archiveMs: number
  batchSize: number
  intervalMs: number
}

export function snapshotRetentionConfig(env: Record<string, string | undefined>): SnapshotRetentionConfig {
  const setting = (name: string, fallback: number) => {
    const raw = brandEnv(env, name)
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`INVALID_EYELER_${name}`)
    return value
  }
  const fullMs = setting('SNAPSHOT_FULL_HOURS', 48) * 3_600_000
  const archiveMs = setting('SNAPSHOT_ARCHIVE_DAYS', 30) * 86_400_000
  if (!Number.isSafeInteger(fullMs) || !Number.isSafeInteger(archiveMs) || archiveMs <= fullMs)
    throw new Error('INVALID_EYELER_SNAPSHOT_RETENTION_WINDOWS')
  return {
    fullMs,
    archiveMs,
    batchSize: setting('SNAPSHOT_RETENTION_BATCH_SIZE', 1000),
    intervalMs: setting('SNAPSHOT_RETENTION_INTERVAL_MS', 60_000),
  }
}

export class SnapshotRetention {
  private timer?: ReturnType<typeof setInterval>
  private inFlight?: Promise<number>
  constructor(
    private readonly pool: Pick<pg.Pool, 'query'>,
    private readonly config: SnapshotRetentionConfig,
    private readonly now: () => number = Date.now,
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce().catch(() =>
        logger.warn({ error: 'SNAPSHOT_RETENTION_FAILED' }, 'Snapshot retention deferred'),
      )
    }, this.config.intervalMs)
    this.timer.unref()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  runOnce(): Promise<number> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.deleteBatch().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async deleteBatch(): Promise<number> {
    const now = this.now()
    const result = await this.pool.query(
      `WITH eligible AS (
        SELECT rs.id, rs.timestamp,
          row_number() OVER (
            PARTITION BY rs.book_id, date_trunc('minute', rs.timestamp)
            ORDER BY rs.timestamp DESC, rs.id DESC
          ) AS minute_rank
        FROM risk_snapshots rs
        WHERE rs.timestamp < $1::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM actions a
            WHERE a.book_id=rs.book_id
              AND a.status IN ('QUEUED','VALIDATING','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN','PARTIAL')
          )
      ), batch AS (
        SELECT id FROM eligible
        WHERE timestamp < $2::timestamptz OR minute_rank > 1
        ORDER BY timestamp, id LIMIT $3
      )
      DELETE FROM risk_snapshots WHERE id IN (SELECT id FROM batch)`,
      [
        new Date(now - this.config.fullMs).toISOString(),
        new Date(now - this.config.archiveMs).toISOString(),
        this.config.batchSize,
      ],
    )
    return result.rowCount ?? 0
  }
}
