import pg from 'pg'
import { defaultFreshnessThresholds, type Book, type BookPositionSeed, type BookTelemetrySeed } from '../../../../packages/domain/src/index.js'
import { validateBookControls } from '../../bookControls.js'
export type CreateBookInput = Omit<Book, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { reserveAvailable?: number; initialPosition?: BookPositionSeed; initialTelemetry?: BookTelemetrySeed }
export type StoredSession = { userId: string; walletAddress: string; expiresAt: number }
export type Store = { ensureUser(walletAddress: string): Promise<string>; createSession(token: string, session: StoredSession): Promise<void>; getSession(token: string): Promise<StoredSession | null>; revokeSession(token: string): Promise<void>; updateBookControls(userId: string, bookId: string, patch: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] }): Promise<Book | null>; createBook(userId: string, input: CreateBookInput): Promise<Book>; getBook(userId: string, bookId: string): Promise<Book | null>; listBooks(userId: string): Promise<Book[]>; getPositionRow(userId: string, bookId: string): Promise<Record<string, unknown> | null>; getTelemetryRow(userId: string, bookId: string): Promise<Record<string, unknown> | null>; getRiskRow(userId: string, bookId: string): Promise<Record<string, unknown> | null>; revokeConnection(userId: string): Promise<void>; registerDevice(userId: string, pushToken: string, platform: string): Promise<void>; listAutopsy(userId: string, bookId: string): Promise<unknown[]>; listDecisions(userId: string, bookId: string): Promise<unknown[]>; listActions(userId: string, bookId: string): Promise<unknown[]>; getReserve(userId: string, bookId: string): Promise<unknown | null>; createChallenge(address: string, nonce: string, expiresAt: number, message: string): Promise<void>; consumeChallenge(address: string, nonce: string, message: string): Promise<boolean> }
export class PostgresStore implements Store {
  readonly pool: pg.Pool
  constructor(connectionString: string, pool?: pg.Pool) { this.pool = pool ?? new pg.Pool({ connectionString, max: 10, ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined }) }
  async ensureUser(walletAddress: string) { const result = await this.pool.query('INSERT INTO users(wallet_address) VALUES($1) ON CONFLICT(wallet_address) DO UPDATE SET updated_at=now() RETURNING id', [walletAddress.toLowerCase()]); return String(result.rows[0].id) }
  async createSession(token: string, session: StoredSession) { await this.pool.query('INSERT INTO sessions(id,user_id,wallet_address,expires_at) VALUES($1,$2,$3,to_timestamp($4 / 1000.0))', [token, session.userId, session.walletAddress, session.expiresAt]) }
  async getSession(token: string) { const result = await this.pool.query('SELECT user_id,wallet_address,extract(epoch from expires_at)*1000 AS expires_at FROM sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()', [token]); const row = result.rows[0]; return row ? { userId: String(row.user_id), walletAddress: String(row.wallet_address), expiresAt: Number(row.expires_at) } : null }
  async revokeSession(token: string) { await this.pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [token]) }
  async createBook(userId: string, input: CreateBookInput) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const hasPosition = Boolean(input.initialPosition && input.initialTelemetry && input.marketId && input.venueAccountId && input.venuePositionId)
      if (input.automationEnabled && !hasPosition) throw new Error('BOOK_POSITION_BINDING_REQUIRED')
      const status = hasPosition ? input.status : 'PAUSED'
      const result = await client.query('INSERT INTO books(user_id,market,market_id,venue_account_id,venue_position_id,side,stance,liquidation_floor,defense_cap,time_limit_ms,automation_enabled,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [userId, input.market, input.marketId ?? null, input.venueAccountId ?? null, input.venuePositionId ?? null, input.side, input.stance, input.liquidationFloor, input.defenseCap, input.timeLimitMs, hasPosition && input.automationEnabled, status])
      const book = mapBook(result.rows[0])
      const reserveAvailable = input.reserveAvailable ?? 0
      if (!Number.isFinite(reserveAvailable) || reserveAvailable < 0) throw new Error('INVALID_BOOK_RESERVE')
      if (!Number.isFinite(input.defenseCap) || input.defenseCap <= 0 || input.defenseCap > reserveAvailable) throw new Error('Defense cap cannot exceed reserve.')
      await client.query('INSERT INTO reserves(book_id,available,reserved,deployed,cap) VALUES($1,$2,0,0,$3)', [book.id, reserveAvailable, reserveAvailable])
      if (input.initialPosition) {
        const p = input.initialPosition
        await client.query('INSERT INTO positions(book_id,size,entry_price,mark_price,liquidation_price,leverage,unrealized_pnl,margin,status,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())', [book.id,p.size,p.entryPrice,p.markPrice,p.liquidationPrice,p.leverage,p.unrealizedPnl,p.margin,p.status])
        if (input.initialTelemetry) {
          const t = input.initialTelemetry
          await client.query('INSERT INTO risk_snapshots(book_id,block,timestamp,mark,oracle,liquidation,funding,spread,depth,volatility,reserve,freshness,source,bid,ask,mid) VALUES($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)', [book.id,t.block,t.marketTimestamp ?? t.timestamp,t.mark,t.oracle,p.liquidationPrice,t.fundingRate,t.spreadBps,t.depthNotional,t.volatility,reserveAvailable,t.freshnessMs ?? 0,t.source ?? 'replay',t.bid,t.ask,t.mid])
        }
      }
      await client.query("INSERT INTO reserve_ledger_entries(book_id,type,amount,external_reference) VALUES($1,'RESERVE_CREATED',$2,'book-creation')", [book.id, reserveAvailable])
      await client.query('COMMIT')
      return book
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async getBook(userId: string, bookId: string) { const result = await this.pool.query('SELECT * FROM books WHERE id=$1 AND user_id=$2', [bookId, userId]); return result.rows[0] ? mapBook(result.rows[0]) : null }
  async listBooks(userId: string) { const result = await this.pool.query('SELECT * FROM books WHERE user_id=$1 ORDER BY created_at DESC', [userId]); return result.rows.map(mapBook) }
  async getPositionRow(userId: string, bookId: string) { const result = await this.pool.query('SELECT p.* FROM positions p JOIN books b ON b.id=p.book_id WHERE b.user_id=$1 AND p.book_id=$2', [userId, bookId]); return result.rows[0] ?? null }
  async getTelemetryRow(userId: string, bookId: string) { const result = await this.pool.query('SELECT rs.* FROM risk_snapshots rs JOIN books b ON b.id=rs.book_id WHERE b.user_id=$1 AND rs.book_id=$2 ORDER BY rs.timestamp DESC LIMIT 1', [userId, bookId]); return result.rows[0] ?? null }
  async getRiskRow(userId: string, bookId: string) { const result = await this.pool.query('SELECT d.state,d.action,d.amount,d.reason_codes,d.human_readable_reasons,d.risk_features,d.created_at FROM decisions d JOIN books b ON b.id=d.book_id WHERE b.user_id=$1 AND d.book_id=$2 ORDER BY d.created_at DESC LIMIT 1', [userId, bookId]); return result.rows[0] ?? null }
  async updateBookControls(userId: string, bookId: string, patch: { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query('SELECT * FROM books WHERE id=$1 AND user_id=$2 FOR UPDATE', [bookId, userId])
      if (!locked.rows.length) { await client.query('COMMIT'); return null }
      const current = mapBook(locked.rows[0])
      validateBookControls(current, patch)
      const enabling = patch.automationEnabled === true || patch.status === 'ACTIVE'
      if (enabling) {
        const bound = await client.query(`SELECT p.book_id FROM positions p JOIN reserves r ON r.book_id=p.book_id
          JOIN LATERAL (SELECT timestamp FROM risk_snapshots WHERE book_id=p.book_id ORDER BY timestamp DESC LIMIT 1) rs ON true
          WHERE p.book_id=$1 AND p.status='OPEN' AND p.observed_at>now()-($2 * interval '1 millisecond')
          AND rs.timestamp<=now() AND rs.timestamp>now()-($2 * interval '1 millisecond')`, [bookId, defaultFreshnessThresholds.marketMs])
        if (!current.marketId || !current.venueAccountId || !current.venuePositionId || !bound.rows.length) throw new Error('BOOK_NOT_ARMABLE')
      }
      const paused = patch.automationEnabled === false || patch.status === 'PAUSED'
      const status = current.status === 'CLOSED' ? 'CLOSED' : current.status === 'SAFE_MODE' ? 'SAFE_MODE' : paused ? 'PAUSED' : enabling ? 'ACTIVE' : current.status
      const automation = paused ? false : enabling ? true : current.automationEnabled
      const result = await client.query('UPDATE books SET automation_enabled=$3,status=$4,stance=COALESCE($5,stance),updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *', [bookId,userId,automation,status,patch.stance ?? null])
      await client.query('INSERT INTO autopsy_events(book_id,type,payload) VALUES($1,$2,$3)', [bookId,patch.stance === 'KILL' ? 'USER_KILL' : enabling ? 'BOOK_ARMED' : paused ? 'USER_PAUSED' : 'BOOK_UPDATED',JSON.stringify(patch)])
      await client.query('COMMIT')
      return mapBook(result.rows[0])
    } catch(error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async listAutopsy(userId: string, bookId: string) { const result = await this.pool.query('SELECT e.* FROM autopsy_events e JOIN books b ON b.id=e.book_id WHERE b.user_id=$1 AND e.book_id=$2 ORDER BY e.timestamp DESC LIMIT 500', [userId, bookId]); return result.rows }
  async listDecisions(userId: string, bookId: string) { const result = await this.pool.query('SELECT d.* FROM decisions d JOIN books b ON b.id=d.book_id WHERE b.user_id=$1 AND d.book_id=$2 ORDER BY d.created_at DESC LIMIT 100', [userId, bookId]); return result.rows }
  async listActions(userId: string, bookId: string) { const result = await this.pool.query('SELECT a.* FROM actions a JOIN books b ON b.id=a.book_id WHERE b.user_id=$1 AND a.book_id=$2 ORDER BY a.id DESC LIMIT 100', [userId, bookId]); return result.rows }
  async getReserve(userId: string, bookId: string) { const result = await this.pool.query('SELECT r.* FROM reserves r JOIN books b ON b.id=r.book_id WHERE b.user_id=$1 AND r.book_id=$2', [userId, bookId]); return result.rows[0] ?? null }
  async registerDevice(userId: string, pushToken: string, platform: string) { await this.pool.query('INSERT INTO devices(user_id,push_token,platform) VALUES($1,$2,$3)', [userId, pushToken, platform]) }
  async revokeConnection(userId: string) { await this.pool.query("UPDATE perpl_connections SET status='REVOKED', revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]) }
  async createChallenge(address: string, nonce: string, expiresAt: number, message: string) { await this.pool.query('INSERT INTO auth_challenges(address,nonce,expires_at,message) VALUES($1,$2,$3,$4)', [address.toLowerCase(), nonce, expiresAt, message]) }
  async consumeChallenge(address: string, nonce: string, message: string) { const result = await this.pool.query('UPDATE auth_challenges SET consumed_at=now() WHERE address=$1 AND nonce=$2 AND expires_at>$3 AND consumed_at IS NULL AND message=$4 RETURNING nonce', [address.toLowerCase(), nonce, Date.now(), message]); return result.rowCount === 1 }
}
export class UnconfiguredStore implements Store { async ensureUser(): Promise<string> { throw new Error('DATABASE_NOT_CONFIGURED') } async createSession(): Promise<void> { throw new Error('DATABASE_NOT_CONFIGURED') } async getSession(): Promise<StoredSession | null> { throw new Error('DATABASE_NOT_CONFIGURED') } async revokeSession(): Promise<void> { throw new Error('DATABASE_NOT_CONFIGURED') } async updateBookControls(): Promise<Book | null> { throw new Error('DATABASE_NOT_CONFIGURED') } async createBook(): Promise<Book> { throw new Error('DATABASE_NOT_CONFIGURED') } async getBook(): Promise<Book | null> { throw new Error('DATABASE_NOT_CONFIGURED') } async listBooks(): Promise<Book[]> { throw new Error('DATABASE_NOT_CONFIGURED') } async getPositionRow(): Promise<Record<string, unknown> | null> { throw new Error('DATABASE_NOT_CONFIGURED') } async getTelemetryRow(): Promise<Record<string, unknown> | null> { throw new Error('DATABASE_NOT_CONFIGURED') } async getRiskRow(): Promise<Record<string, unknown> | null> { throw new Error('DATABASE_NOT_CONFIGURED') } async revokeConnection() { throw new Error('DATABASE_NOT_CONFIGURED') } async registerDevice() { throw new Error('DATABASE_NOT_CONFIGURED') } async listAutopsy(): Promise<unknown[]> { throw new Error('DATABASE_NOT_CONFIGURED') } async listDecisions(): Promise<unknown[]> { throw new Error('DATABASE_NOT_CONFIGURED') } async listActions(): Promise<unknown[]> { throw new Error('DATABASE_NOT_CONFIGURED') } async getReserve(): Promise<unknown | null> { throw new Error('DATABASE_NOT_CONFIGURED') } async createChallenge(): Promise<void> { throw new Error('DATABASE_NOT_CONFIGURED') } async consumeChallenge(): Promise<boolean> { throw new Error('DATABASE_NOT_CONFIGURED') } }
function mapBook(row: Record<string, unknown>): Book { return { id: String(row.id), userId: String(row.user_id), market: String(row.market), marketId: row.market_id == null ? undefined : Number(row.market_id), venueAccountId: row.venue_account_id == null ? undefined : Number(row.venue_account_id), venuePositionId: row.venue_position_id == null ? undefined : Number(row.venue_position_id), side: row.side as Book['side'], stance: row.stance as Book['stance'], liquidationFloor: Number(row.liquidation_floor), defenseCap: Number(row.defense_cap), timeLimitMs: Number(row.time_limit_ms), automationEnabled: Boolean(row.automation_enabled), status: row.status as Book['status'], createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() } }



