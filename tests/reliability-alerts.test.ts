import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { ReliabilityAlerts } from '../server/src/infrastructure/reliability/alerts.js'

async function fixture(fetcher: typeof fetch, token: string | undefined = 'fixture-bot-secret') {
  const { db, store } = await databaseFixture()
  const owner = await store.ensureUser('alerts-owner-private-wallet')
  const other = await store.ensureUser('alerts-other-private-wallet')
  const runId = randomUUID()
  await db.query(
    `INSERT INTO reliability_runs(id,owner_user_id,started_at,ends_at,status,automation_paused,next_restart_at,next_chaos_at)
     VALUES($1,$2,now(),now()+interval '7 days','RUNNING',true,now()+interval '1 day',now()+interval '1 day')`,
    [runId, owner],
  )
  await db.query('INSERT INTO telegram_links(user_id,telegram_user_id,chat_id) VALUES($1,$2,$2)', [owner, 'owner-chat'])
  await db.query('INSERT INTO telegram_links(user_id,telegram_user_id,chat_id) VALUES($1,$2,$2)', [other, 'other-chat'])
  const add = async (kind = 'duplicate_action', scope = 'mainnet', status = 'OPEN') => {
    const incidentId = randomUUID()
    await db.query(
      `INSERT INTO reliability_incidents(id,run_id,incident_key,kind,scope,detected_at,status,summary)
       VALUES($1,$2,$3,$4,$5,'2026-10-13T20:00:00Z',$6,$7)`,
      [
        incidentId,
        runId,
        randomUUID(),
        kind,
        scope,
        status,
        'Private secret and wallet 0x1234567890123456789012345678901234567890',
      ],
    )
    return incidentId
  }
  const alerts = new ReliabilityAlerts(
    store.pool,
    { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: 'not-authorized' },
    fetcher,
  )
  return { db, pool: store.pool, owner, other, runId, add, alerts, close: () => db.close() }
}

describe('durable campaign-owner incident alerts', () => {
  it('sends once to only the campaign owner after pause, with no private fields', async () => {
    const bodies: Array<{ chat_id: string; text: string }> = []
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true })
    }) as typeof fetch
    const f = await fixture(fetcher)
    try {
      const incident = await f.add()
      expect(await f.alerts.health()).toEqual({ configured: true, linkedRecipients: 1 })
      await f.alerts.flush(f.runId)
      await f.alerts.flush(f.runId)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(bodies[0].chat_id).toBe('owner-chat')
      expect(bodies[0].text).toContain('Duplicate action detected')
      expect(bodies[0].text).toContain('2026-10-13T20:00:00.000Z')
      expect(bodies[0].text).toContain('Automation is paused')
      expect(bodies[0].text).toContain('https://app.eyeler.xyz/#/status')
      expect(bodies[0].text).not.toMatch(/private|secret|other-chat|not-authorized|0x/i)
      expect(
        (
          await f.db.query('SELECT status,last_error FROM reliability_alert_deliveries WHERE incident_id=$1', [
            incident,
          ])
        ).rows[0],
      ).toMatchObject({ status: 'SENT', last_error: null })
      await f.db.exec(await readFile('database/migrations/042_reliability_alerts.sql', 'utf8'))
      expect(
        (await f.db.query('SELECT status FROM reliability_alert_deliveries WHERE incident_id=$1', [incident])).rows[0],
      ).toMatchObject({ status: 'SENT' })
    } finally {
      await f.close()
    }
  }, 30_000)

  it('does not send before safety pause or for ordinary websocket/sandbox incidents', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
    const f = await fixture(fetcher)
    try {
      await f.add('websocket_disconnect')
      await f.add('duplicate_action', 'sandbox')
      await f.add('duplicate_action', 'mainnet', 'RECOVERED')
      await f.alerts.flush(f.runId)
      expect(fetcher).not.toHaveBeenCalled()
      await f.add()
      await f.db.query('UPDATE reliability_runs SET automation_paused=false WHERE id=$1', [f.runId])
      await f.alerts.flush(f.runId)
      expect(fetcher).not.toHaveBeenCalled()
      expect(
        (await f.db.query('SELECT count(*)::int AS count FROM reliability_alert_deliveries')).rows[0],
      ).toMatchObject({ count: 0 })
      await f.db.query("UPDATE reliability_runs SET status='PAUSED',automation_paused=true WHERE id=$1", [f.runId])
      await f.alerts.flush(f.runId)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('fails closed without owner link and never falls back to other linked users', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
    const f = await fixture(fetcher)
    try {
      await f.add()
      await f.db.query('UPDATE telegram_links SET revoked_at=now() WHERE user_id=$1', [f.owner])
      expect(await f.alerts.health()).toEqual({
        configured: false,
        linkedRecipients: 0,
        reason: 'OWNER_TELEGRAM_NOT_LINKED',
      })
      await f.alerts.flush(f.runId)
      expect(fetcher).not.toHaveBeenCalled()
      await f.db.query('UPDATE reliability_runs SET owner_user_id=NULL WHERE id=$1', [f.runId])
      expect(await f.alerts.health()).toEqual({
        configured: false,
        linkedRecipients: 0,
        reason: 'RUN_OWNER_UNAVAILABLE',
      })
      const withoutToken = new ReliabilityAlerts(f.pool, {}, fetcher)
      expect(await withoutToken.health()).toEqual({
        configured: false,
        linkedRecipients: 0,
        reason: 'BOT_NOT_CONFIGURED',
      })
      await withoutToken.flush(f.runId)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  }, 30_000)

  it('keeps ambiguous outcomes UNKNOWN and does not resend after restart', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('https://api.telegram.org/botfixture-bot-secret/sendMessage')
    }) as typeof fetch
    const f = await fixture(fetcher)
    try {
      const incident = await f.add('unknown_resubmission')
      await f.alerts.flush(f.runId)
      await new ReliabilityAlerts(f.pool, { TELEGRAM_BOT_TOKEN: 'fixture-bot-secret' }, fetcher).flush(f.runId)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(
        (
          await f.db.query('SELECT status,last_error FROM reliability_alert_deliveries WHERE incident_id=$1', [
            incident,
          ])
        ).rows[0],
      ).toMatchObject({ status: 'UNKNOWN', last_error: 'OUTCOME_UNKNOWN' })
      const abandoned = await f.add('partial_resubmission')
      await f.db.query(
        `INSERT INTO reliability_alert_deliveries(incident_id,run_id,recipient_link_id,status,started_at)
         SELECT $1,$2,id,'SENDING',now()-interval '2 minutes' FROM telegram_links WHERE user_id=$3 AND revoked_at IS NULL`,
        [abandoned, f.runId, f.owner],
      )
      await f.alerts.flush(f.runId)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(
        (await f.db.query('SELECT status FROM reliability_alert_deliveries WHERE incident_id=$1', [abandoned])).rows[0],
      ).toMatchObject({ status: 'UNKNOWN' })
    } finally {
      await f.close()
    }
  }, 30_000)

  it('records definite rejection without raw response text or automatic retries', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ok: false, description: 'private-bot-secret' }, { status: 429 }),
    ) as typeof fetch
    const f = await fixture(fetcher)
    try {
      const incident = await f.add('restart_recovery_timeout')
      await f.alerts.flush(f.runId)
      await f.alerts.flush(f.runId)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(
        (
          await f.db.query('SELECT status,last_error FROM reliability_alert_deliveries WHERE incident_id=$1', [
            incident,
          ])
        ).rows[0],
      ).toMatchObject({ status: 'FAILED', last_error: 'TELEGRAM_REJECTED' })
    } finally {
      await f.close()
    }
  }, 30_000)

  it('requires a durable claim, suppresses private database errors, and never sends while database is down', async () => {
    const fetcher = vi.fn() as typeof fetch
    const unavailable = {
      query: async () => {
        throw new Error('postgres://private-password@private-host')
      },
    } as unknown as pg.Pool
    const alerts = new ReliabilityAlerts(unavailable, { TELEGRAM_BOT_TOKEN: 'fixture-bot-secret' }, fetcher)
    expect(await alerts.health()).toEqual({ configured: false, linkedRecipients: 0, reason: 'DATABASE_UNAVAILABLE' })
    await expect(alerts.flush(randomUUID())).rejects.toThrow('RELIABILITY_ALERTS_DATABASE_UNAVAILABLE')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('two alert workers cannot send one incident twice', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
    const f = await fixture(fetcher)
    try {
      await f.add('database_unavailable')
      await Promise.all([
        f.alerts.flush(f.runId),
        new ReliabilityAlerts(f.pool, { TELEGRAM_BOT_TOKEN: 'fixture-bot-secret' }, fetcher).flush(f.runId),
      ])
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('does not resend when Telegram accepts but the outcome cannot be persisted', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
    const f = await fixture(fetcher)
    try {
      const incident = await f.add('invariant_violation')
      const interrupted = {
        query: async (sql: string, values?: unknown[]) => {
          if (sql.includes('delivered_at=CASE')) throw new Error('private-database-password')
          return f.pool.query(sql, values)
        },
      } as unknown as pg.Pool
      await expect(
        new ReliabilityAlerts(interrupted, { TELEGRAM_BOT_TOKEN: 'fixture-bot-secret' }, fetcher).flush(f.runId),
      ).rejects.toThrow('RELIABILITY_ALERTS_DATABASE_UNAVAILABLE')
      await f.alerts.flush(f.runId)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(
        (await f.db.query('SELECT status FROM reliability_alert_deliveries WHERE incident_id=$1', [incident])).rows[0],
      ).toMatchObject({ status: 'SENDING' })
      await f.db.query(
        "UPDATE reliability_alert_deliveries SET started_at=now()-interval '2 minutes' WHERE incident_id=$1",
        [incident],
      )
      await f.alerts.flush(f.runId)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(
        (await f.db.query('SELECT status FROM reliability_alert_deliveries WHERE incident_id=$1', [incident])).rows[0],
      ).toMatchObject({ status: 'UNKNOWN' })
    } finally {
      await f.close()
    }
  }, 30_000)

  it('rechecks owner link after claim and cancels if it was revoked', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
    const f = await fixture(fetcher)
    try {
      const incident = await f.add('configuration_changed')
      const interrupted = {
        query: async (sql: string, values?: unknown[]) => {
          if (sql.includes('SELECT i.kind,i.detected_at,l.chat_id')) {
            await f.db.query('UPDATE telegram_links SET revoked_at=now() WHERE user_id=$1', [f.owner])
          }
          return f.pool.query(sql, values)
        },
      } as unknown as pg.Pool
      await new ReliabilityAlerts(interrupted, { TELEGRAM_BOT_TOKEN: 'fixture-bot-secret' }, fetcher).flush(f.runId)
      expect(fetcher).not.toHaveBeenCalled()
      expect(
        (await f.db.query('SELECT status FROM reliability_alert_deliveries WHERE incident_id=$1', [incident])).rows[0],
      ).toMatchObject({ status: 'CANCELED' })
    } finally {
      await f.close()
    }
  }, 30_000)
})
