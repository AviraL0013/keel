import type pg from 'pg'
import { brandEnv, logger } from '../../config/index.js'

export type TelegramConfig = { botToken: string; chatId: string; appUrl: string }
type Alert = { id: string; kind: string; title: string; book_id: string; attempts: number }

export class TelegramNotifier {
  private timer?: ReturnType<typeof setInterval>
  private inFlight?: Promise<void>
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: TelegramConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() =>
        logger.warn({ error: 'TELEGRAM_DELIVERY_WORKER_FAILED' }, 'Telegram delivery deferred'),
      )
    }, 5000)
    this.timer.unref()
    void this.pollOnce().catch(() =>
      logger.warn({ error: 'TELEGRAM_DELIVERY_WORKER_FAILED' }, 'Telegram delivery deferred'),
    )
  }
  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  pollOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.deliverOne().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async claim(): Promise<Alert | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "UPDATE telegram_deliveries SET status='UNKNOWN',last_error='OUTCOME_UNKNOWN' WHERE status='SENDING' AND started_at<=$1",
        [new Date(this.now() - 60_000).toISOString()],
      )
      const result = await client.query(
        `SELECT n.id,n.kind,n.title,n.book_id,d.attempts FROM notifications n LEFT JOIN telegram_deliveries d ON d.notification_id=n.id
        WHERE n.book_id IS NOT NULL AND (n.kind IN ('SAFE_MODE','SAFE_MODE_EXITED','DEFEND','REDUCE','EXIT','AUTOMATION_RETRY_EXHAUSTED') OR n.kind LIKE 'ACTION_%')
        AND (d.notification_id IS NULL OR (d.status='PENDING' AND d.next_attempt_at<=$1))
        ORDER BY n.created_at,n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`,
        [new Date(this.now()).toISOString()],
      )
      const row = result.rows[0] as Alert | undefined
      if (!row) {
        await client.query('COMMIT')
        return null
      }
      await client.query(
        `INSERT INTO telegram_deliveries(notification_id,status,attempts,started_at) VALUES($1,'SENDING',1,$2)
        ON CONFLICT(notification_id) DO UPDATE SET status='SENDING',attempts=telegram_deliveries.attempts+1,started_at=$2,last_error=NULL`,
        [row.id, new Date(this.now()).toISOString()],
      )
      await client.query('COMMIT')
      return { ...row, attempts: Number(row.attempts ?? 0) + 1 }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private message(alert: Alert): string {
    const actionTitle =
      /^(DEFEND|REDUCE|EXIT): (QUEUED|VALIDATING|SUBMITTING|SUBMITTED|VERIFYING|CONFIRMED|FAILED|CANCELED|EXPIRED|UNKNOWN|PARTIAL)$/.exec(
        alert.title,
      )
    const label =
      alert.kind === 'SAFE_MODE'
        ? 'Safety paused'
        : alert.kind === 'SAFE_MODE_EXITED'
          ? 'Automation resumed'
          : alert.kind === 'AUTOMATION_RETRY_EXHAUSTED'
            ? 'Automatic action stopped'
            : actionTitle
              ? `${actionTitle[1]} ${actionTitle[2]}`
              : 'Book action update'
    return `EYELER: ${label}\nOpen Book: ${this.config.appUrl}/?book=${encodeURIComponent(alert.book_id)}`
  }

  private async deliverOne() {
    const alert = await this.claim()
    if (!alert) return
    let definiteFailure = false
    let failureCode = 'TELEGRAM_REJECTED'
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text: this.message(alert),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        definiteFailure = true
        failureCode = `TELEGRAM_HTTP_${response.status}`
      } else {
        const body = (await response.json()) as { ok?: boolean }
        if (body.ok === true) {
          await this.pool.query(
            "UPDATE telegram_deliveries SET status='SENT',delivered_at=$2,last_error=NULL WHERE notification_id=$1 AND status='SENDING'",
            [alert.id, new Date(this.now()).toISOString()],
          )
          return
        }
        definiteFailure = true
      }
    } catch {
      /* Transport outcome is ambiguous; never resend automatically. */
    }
    if (definiteFailure) {
      const delay = Math.min(300_000, 30_000 * 2 ** Math.min(alert.attempts - 1, 4))
      await this.pool.query(
        "UPDATE telegram_deliveries SET status='PENDING',next_attempt_at=$2,last_error=$3 WHERE notification_id=$1 AND status='SENDING'",
        [alert.id, new Date(this.now() + delay).toISOString(), failureCode],
      )
    } else
      await this.pool.query(
        "UPDATE telegram_deliveries SET status='UNKNOWN',last_error='OUTCOME_UNKNOWN' WHERE notification_id=$1 AND status='SENDING'",
        [alert.id],
      )
  }
}

export function createTelegramNotifier(
  pool: pg.Pool,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): TelegramNotifier | undefined {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = env.TELEGRAM_CHAT_ID?.trim()
  if (!botToken || !chatId) return undefined
  const appUrl = brandEnv(env, 'APP_URL')?.trim().replace(/\/$/, '')
  try {
    if (!appUrl || new URL(appUrl).origin !== appUrl || !appUrl.startsWith('https://')) throw new Error()
  } catch {
    throw new Error('INVALID_EYELER_APP_URL')
  }
  return new TelegramNotifier(pool, { botToken, chatId, appUrl }, fetcher)
}
