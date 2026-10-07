import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import { AuthorizationError, ConflictError } from '../../application/errors.js'
import type { StrategyTelegramCommand, StrategyTelegramCommands } from '../strategies/telegram-commands.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class TelegramLinks {
  constructor(
    private readonly pool: pg.Pool,
    private readonly username: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
    private readonly strategyCommands?: StrategyTelegramCommands,
  ) {
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username) || !username.toLowerCase().endsWith('bot'))
      throw new Error('INVALID_TELEGRAM_BOT_USERNAME')
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('INVALID_TELEGRAM_WEBHOOK_SECRET')
  }

  async status(userId: string) {
    const result = await this.pool.query(
      'SELECT linked_at FROM telegram_links WHERE user_id=$1 AND revoked_at IS NULL',
      [userId],
    )
    return result.rows[0]
      ? { status: 'LINKED', linkedAt: new Date(result.rows[0].linked_at).toISOString() }
      : { status: 'NOT_LINKED' }
  }

  async start(userId: string) {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(this.now() + 600000).toISOString()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId])
      if (
        (await client.query('SELECT id FROM telegram_links WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows
          .length
      )
        throw new ConflictError('TELEGRAM_ALREADY_LINKED')
      await client.query('DELETE FROM telegram_link_tokens WHERE user_id=$1 OR expires_at<$2', [
        userId,
        new Date(this.now()).toISOString(),
      ])
      await client.query('INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [
        hash(token),
        userId,
        expiresAt,
      ])
      await client.query('COMMIT')
      return { url: `https://t.me/${this.username}?start=${token}`, expiresAt }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async unlink(userId: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId])
      await client.query('UPDATE telegram_links SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [
        userId,
        new Date(this.now()).toISOString(),
      ])
      await client.query('DELETE FROM telegram_link_tokens WHERE user_id=$1', [userId])
      await client.query(
        "UPDATE telegram_deliveries d SET status='CANCELED',last_error='TELEGRAM_UNLINKED' FROM telegram_links l WHERE d.recipient_link_id=l.id AND l.user_id=$1 AND d.status='PENDING'",
        [userId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async handle(suppliedSecret: unknown, body: unknown) {
    const supplied = Buffer.from(typeof suppliedSecret === 'string' ? suppliedSecret : '')
    const expected = Buffer.from(this.secret)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new AuthorizationError('TELEGRAM_WEBHOOK_UNAUTHORIZED')
    const update = body as {
      update_id?: number
      message?: {
        date?: number
        text?: string
        chat?: { id?: number; type?: string }
        from?: { id?: number; is_bot?: boolean }
      }
    } | null
    const message = update?.message
    const token =
      typeof message?.text === 'string' ? /^\/start ([A-Za-z0-9_-]{43})$/.exec(message.text)?.[1] : undefined
    const parsedCommand =
      typeof message?.text === 'string'
        ? /^\/(status|pnl|pause|resume|killswitch)(?:@([A-Za-z0-9_]{5,32}))?$/i.exec(message.text)
        : null
    const command =
      parsedCommand && (!parsedCommand[2] || parsedCommand[2].toLowerCase() === this.username.toLowerCase())
        ? (parsedCommand[1].toLowerCase() as StrategyTelegramCommand)
        : undefined
    if (
      !Number.isSafeInteger(update?.update_id) ||
      update!.update_id! < 0 ||
      (!token && !command) ||
      message?.chat?.type !== 'private' ||
      !Number.isSafeInteger(message.chat.id) ||
      message.chat.id! <= 0 ||
      message.from?.id !== message.chat.id ||
      message.from?.is_bot !== false ||
      !Number.isSafeInteger(message.date) ||
      Math.abs(this.now() - message.date! * 1000) > 600000
    )
      return { ok: true }
    const client = await this.pool.connect()
    let commandOwner: { userId: string; linkId: string; chatId: string; text: string } | undefined
    try {
      await client.query('BEGIN')
      const duplicate = await client.query(
        'INSERT INTO telegram_webhook_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id',
        [update!.update_id],
      )
      if (duplicate.rows.length) {
        if (token) {
          const found = await client.query(
            'SELECT user_id FROM telegram_link_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>$2',
            [hash(token), new Date(this.now()).toISOString()],
          )
          const userId = found.rows[0]?.user_id
          if (userId) {
            await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId])
            const consumed = await client.query(
              'UPDATE telegram_link_tokens SET consumed_at=$2 WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING user_id',
              [hash(token), new Date(this.now()).toISOString()],
            )
            if (consumed.rows.length)
              await client.query(
                'INSERT INTO telegram_links(user_id,telegram_user_id,chat_id,linked_at) VALUES($1,$2,$2,$3) ON CONFLICT DO NOTHING',
                [userId, String(message.chat.id), new Date(this.now()).toISOString()],
              )
          }
        } else if (command && this.strategyCommands) {
          const linked = await client.query(
            'SELECT id,user_id,chat_id FROM telegram_links WHERE chat_id=$1 AND telegram_user_id=$1 AND revoked_at IS NULL',
            [String(message.chat.id)],
          )
          if (linked.rows[0]) {
            const owner = linked.rows[0]
            await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.user_id])
            const active = await client.query(
              'SELECT id FROM telegram_links WHERE id=$1 AND user_id=$2 AND chat_id=$3 AND telegram_user_id=$3 AND revoked_at IS NULL FOR UPDATE',
              [owner.id, owner.user_id, owner.chat_id],
            )
            if (active.rows.length) {
              const text = await this.strategyCommands.execute(owner.user_id, command, client)
              commandOwner = { userId: owner.user_id, linkId: owner.id, chatId: owner.chat_id, text }
            }
          }
        }
      }
      await client.query('DELETE FROM telegram_webhook_updates WHERE received_at < $1', [
        new Date(this.now() - 7 * 86400000).toISOString(),
      ])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    // Reply failure must not roll back or replay an already committed control.
    if (commandOwner && this.strategyCommands) {
      const active = await this.pool.query(
        'SELECT 1 FROM telegram_links WHERE id=$1 AND user_id=$2 AND chat_id=$3 AND revoked_at IS NULL',
        [commandOwner.linkId, commandOwner.userId, commandOwner.chatId],
      )
      if (active.rows.length) await this.strategyCommands.send(commandOwner.chatId, commandOwner.text)
    }
    return { ok: true }
  }
}
