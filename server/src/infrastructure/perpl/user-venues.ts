import type { Book } from '../../../../packages/domain/src/index.js'
import type { RuntimeVenue } from '../../runtime.js'
import type { PostgresStore } from '../database/postgres-store.js'
import { credentialContext, type KeyCustody } from './key-custody.js'
import { logger } from '../../config/index.js'

export type PerplUserCredentials = {
  connectionId: string
  userId: string
  walletAddress: string
  accountId: number
  environment: 'testnet' | 'mainnet'
  apiKey: string
  privateKey: string
}
type Connection = {
  id: string
  user_id: string
  wallet_address: string
  sealed_private_key: string
  sealed_api_token: string
  account_id: string | null
}
type Entry = {
  userId: string
  raw: RuntimeVenue
  guarded: RuntimeVenue
  lastUsedAt: number
  inFlight: number
  use<T>(operation: () => Promise<T>): Promise<T>
}

/** Private venues exist only while this process owns the worker lease. */
export class PerplUserVenues implements RuntimeVenue {
  private active = false
  private generation = 0
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<RuntimeVenue | undefined>>()
  private readonly closing = new Map<string, Promise<void>>()
  private maintenance?: ReturnType<typeof setInterval>
  private readonly idleTimeoutMs: number
  private readonly now: () => number
  constructor(
    private readonly store: PostgresStore,
    private readonly environment: 'testnet' | 'mainnet',
    private readonly custody: KeyCustody,
    private readonly factory: (credentials: PerplUserCredentials) => Promise<RuntimeVenue>,
    private readonly maxConnections = 64,
    private readonly discover?: (
      credentials: Omit<PerplUserCredentials, 'accountId'>,
    ) => Promise<{ accountId: number }>,
    cache: { idleTimeoutMs?: number; now?: () => number } = {},
  ) {
    this.idleTimeoutMs = cache.idleTimeoutMs ?? 120_000
    this.now = cache.now ?? Date.now
    if (
      !Number.isSafeInteger(maxConnections) ||
      maxConnections < 1 ||
      !Number.isSafeInteger(this.idleTimeoutMs) ||
      this.idleTimeoutMs < 1
    )
      throw new Error('PERPL_CONNECTION_CACHE_INVALID')
  }

  async start() {
    this.active = true
    if (!this.maintenance) {
      this.maintenance = setInterval(
        () => {
          void this.sweepIdle().catch(() =>
            logger.warn(
              { error: 'PERPL_CONNECTION_CLOSE_FAILED' },
              'Idle venue cleanup failed; capacity remains reserved',
            ),
          )
        },
        Math.min(this.idleTimeoutMs, 30_000),
      )
      this.maintenance.unref?.()
    }
  }
  ready() {
    return this.active
  }
  async close() {
    this.active = false
    this.generation++
    if (this.maintenance) clearInterval(this.maintenance)
    this.maintenance = undefined
    // Revoke live transport authority now; an unrelated slow decrypt must not delay it.
    const closing = [...this.entries].map(([id, entry]) => this.evict(id, entry))
    await Promise.allSettled([...closing, ...this.closing.values(), ...this.pending.values()])
    // A pending initialization can fail to close after shutdown begins. Keep that failure visible.
    await Promise.all([...this.closing.values()])
  }

  private async lookup(userId: string, connectionId?: string): Promise<Connection | undefined> {
    const result = await this.store.pool.query<Connection>(
      `SELECT c.id,c.user_id,c.wallet_address,c.sealed_private_key,c.sealed_api_token,a.account_id
       FROM perpl_connections c JOIN users u ON u.id=c.user_id
       LEFT JOIN perpl_accounts a ON a.connection_id=c.id
       WHERE c.user_id=$1 AND c.environment=$2 AND ($3::uuid IS NULL OR c.id=$3)
       AND c.status='ACTIVE' AND c.revoked_at IS NULL AND c.expires_at>now()
       AND c.scope_mask=3 AND lower(c.wallet_address)=u.wallet_address
       AND c.sealed_private_key IS NOT NULL AND c.sealed_api_token IS NOT NULL
       AND a.frozen IS NOT TRUE AND a.forwarding IS NOT FALSE ORDER BY c.created_at DESC LIMIT 2`,
      [userId, this.environment, connectionId ?? null],
    )
    if (result.rows.length > 1) throw new Error('PERPL_ACCOUNT_SELECTION_REQUIRED')
    if (result.rows[0]?.account_id != null) {
      const conflicts = await this.store.pool.query(
        `SELECT 1 FROM perpl_accounts a JOIN perpl_connections c ON c.id=a.connection_id
         WHERE a.account_id=$1 AND c.environment=$2 AND c.user_id<>$3
         AND c.status='ACTIVE' AND c.revoked_at IS NULL AND c.expires_at>now() LIMIT 1`,
        [result.rows[0].account_id, this.environment, userId],
      )
      if (conflicts.rows.length) throw new Error('PERPL_ACCOUNT_OWNERSHIP_CONFLICT')
    }
    return result.rows[0]
  }

  private evict(id: string, entry = this.entries.get(id)): Promise<void> {
    if (!entry || this.entries.get(id) !== entry) return Promise.resolve()
    this.entries.delete(id)
    return this.closeTransport(id, entry.raw)
  }

  private closeTransport(id: string, raw: RuntimeVenue): Promise<void> {
    const existing = this.closing.get(id)
    if (existing) return existing
    let closing: Promise<void>
    try {
      closing = Promise.resolve(raw.close())
    } catch {
      closing = Promise.reject(new Error('PERPL_CONNECTION_CLOSE_FAILED'))
    }
    this.closing.set(id, closing)
    void closing.then(
      () => {
        if (this.closing.get(id) === closing) this.closing.delete(id)
      },
      () => {
        // Retain the slot if transport shutdown cannot be proved. Never open a duplicate socket.
      },
    )
    return closing
  }

  private async sweepIdle() {
    if (!this.active) return
    const idle = [...this.entries].filter(
      ([, entry]) => entry.inFlight === 0 && this.now() - entry.lastUsedAt >= this.idleTimeoutMs,
    )
    await Promise.all(idle.map(([id, entry]) => this.evict(id, entry)))
  }

  private capacityUsed() {
    return this.entries.size + this.pending.size + this.closing.size
  }

  /** A replacement credential may read old evidence, never submit for an old binding. */
  async recoveryForUser(userId: string, connectionId: string): Promise<RuntimeVenue | undefined> {
    if (!this.active) return undefined
    const generation = this.generation
    const historical = async () => {
      const result = await this.store.pool.query<{ account_id: string }>(
        `SELECT a.account_id FROM perpl_connections c JOIN users u ON u.id=c.user_id
         JOIN perpl_accounts a ON a.connection_id=c.id
         JOIN perpl_account_owners o ON o.environment=c.environment AND o.account_id=a.account_id AND o.user_id=c.user_id
         WHERE c.id=$1 AND c.user_id=$2 AND c.environment=$3 AND lower(c.wallet_address)=u.wallet_address
         AND (c.status IN ('EXPIRED','REVOKED') OR c.expires_at<=now()) LIMIT 2`,
        [connectionId, userId, this.environment],
      )
      return result.rows.length === 1 ? Number(result.rows[0].account_id) : undefined
    }
    const accountId = await historical()
    if (!Number.isSafeInteger(accountId) || !accountId || !this.active || generation !== this.generation)
      return undefined
    const current = await this.lookup(userId)
    if (!current || (current.account_id !== null && Number(current.account_id) !== accountId)) return undefined
    const renewed = await this.forUser(userId, current.id)
    const entry = this.entries.get(current.id)
    if (!renewed || renewed.accountId !== accountId || !entry || !this.active || generation !== this.generation)
      return undefined
    const authorize = async () => {
      const active = this.active && generation === this.generation ? await this.lookup(userId, current.id) : undefined
      if (
        !active ||
        Number(active.account_id) !== accountId ||
        (await historical()) !== accountId ||
        !this.active ||
        generation !== this.generation ||
        this.entries.get(current.id) !== entry
      )
        throw new Error('PERPL_CONNECTION_UNAVAILABLE')
    }
    const assertBook = (book: Book) => {
      if (book.userId !== userId || book.perplConnectionId !== connectionId || book.venueAccountId !== accountId)
        throw new Error('PERPL_BOOK_CONNECTION_MISMATCH')
    }
    return {
      accountId,
      connectionId,
      ready: () => this.active && generation === this.generation && renewed.ready(),
      close: async () => {}, // The active connection owns the shared socket's lifecycle.
      submit: async () => {
        throw new Error('PERPL_CONNECTION_RENEWAL_REQUIRES_REVIEW')
      },
      reconcile: (action) =>
        entry.use(async () => {
          await authorize()
          const book = await this.store.getBook(userId, action.bookId)
          if (!book) throw new Error('BOOK_NOT_FOUND')
          assertBook(book)
          await authorize()
          return entry.raw.reconcile(action)
        }),
      refresh: (book) =>
        entry.use(async () => {
          assertBook(book)
          await authorize()
          return entry.raw.refresh(book)
        }),
    }
  }

  async forUser(userId: string, connectionId?: string): Promise<RuntimeVenue | undefined> {
    if (!this.active) return undefined
    const generation = this.generation
    const row = await this.lookup(userId, connectionId)
    if (!row) {
      for (const [id, entry] of this.entries) {
        if (entry.userId === userId && (!connectionId || id === connectionId)) await this.evict(id)
      }
      return undefined
    }
    if (!this.active || generation !== this.generation) return undefined
    if (this.closing.has(row.id)) throw new Error('PERPL_CONNECTION_CLOSING')
    const existing = this.entries.get(row.id)
    if (existing) {
      existing.lastUsedAt = this.now()
      return existing.guarded
    }
    const pending = this.pending.get(row.id)
    if (pending) return pending
    if (this.capacityUsed() >= this.maxConnections) {
      await this.sweepIdle()
      // Another request may have acquired this account or the worker may have stopped during cleanup.
      if (!this.active || generation !== this.generation) return undefined
      if (this.closing.has(row.id)) throw new Error('PERPL_CONNECTION_CLOSING')
      const acquired = this.entries.get(row.id)
      if (acquired) {
        acquired.lastUsedAt = this.now()
        return acquired.guarded
      }
      const opening = this.pending.get(row.id)
      if (opening) return opening
      if (this.capacityUsed() >= this.maxConnections) throw new Error('PERPL_CONNECTION_LIMIT')
    }
    const opening = this.open(row, generation)
    this.pending.set(row.id, opening)
    try {
      return await opening
    } finally {
      this.pending.delete(row.id)
    }
  }

  private async open(row: Connection, generation: number): Promise<RuntimeVenue | undefined> {
    const credentials = {
      connectionId: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      environment: this.environment,
      privateKey: await this.custody.open(
        row.sealed_private_key,
        credentialContext(row.user_id, row.id, 'private_key'),
      ),
      apiKey: await this.custody.open(row.sealed_api_token, credentialContext(row.user_id, row.id, 'api_token')),
    }
    let accountId = Number(row.account_id)
    if (!this.active || generation !== this.generation || !(await this.lookup(row.user_id, row.id))) return undefined
    if (this.discover || row.account_id == null) {
      if (!this.discover) throw new Error('PERPL_ACCOUNT_NOT_VERIFIED')
      if (!this.active || generation !== this.generation) return undefined
      const discovered = await this.discover(credentials)
      if (row.account_id != null && Number(row.account_id) !== discovered.accountId)
        throw new Error('PERPL_ACCOUNT_MISMATCH')
      accountId = discovered.accountId
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('PERPL_ACCOUNT_INVALID')
      if (!this.active || generation !== this.generation || !(await this.lookup(row.user_id, row.id))) return undefined
      await this.store.pool.query(
        `INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen,last_seen_at) VALUES($1,$2,true,false,now())
         ON CONFLICT(connection_id,account_id) DO UPDATE SET forwarding=true,frozen=false,last_seen_at=now()`,
        [row.id, accountId],
      )
      await this.lookup(row.user_id, row.id)
    }
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('PERPL_ACCOUNT_INVALID')
    await this.store.pool.query(
      'INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [this.environment, accountId, row.user_id],
    )
    const owner = await this.store.pool.query(
      'SELECT user_id FROM perpl_account_owners WHERE environment=$1 AND account_id=$2',
      [this.environment, accountId],
    )
    if (owner.rows[0]?.user_id !== row.user_id) throw new Error('PERPL_ACCOUNT_OWNERSHIP_CONFLICT')
    const raw = await this.factory({
      ...credentials,
      accountId,
    })
    try {
      if (!this.active || generation !== this.generation) {
        await this.closeTransport(row.id, raw)
        return undefined
      }
      if (raw.accountId !== accountId) throw new Error('PERPL_ACCOUNT_MISMATCH')
      await raw.start?.()
      if (!this.active || generation !== this.generation) {
        await this.closeTransport(row.id, raw)
        return undefined
      }
      const isCurrent = () => this.active && generation === this.generation && this.entries.get(row.id) === entry
      const authorize = async () => {
        const current = isCurrent() ? await this.lookup(row.user_id, row.id) : undefined
        if (!isCurrent() || !current || Number(current.account_id) !== accountId) {
          await this.evict(row.id, entry)
          throw new Error('PERPL_CONNECTION_UNAVAILABLE')
        }
      }
      const use = async <T>(operation: () => Promise<T>): Promise<T> => {
        if (!isCurrent()) throw new Error('PERPL_CONNECTION_UNAVAILABLE')
        entry.inFlight++
        entry.lastUsedAt = this.now()
        try {
          await authorize()
          return await operation()
        } finally {
          entry.inFlight--
          entry.lastUsedAt = this.now()
        }
      }
      const assertBook = (book: Book) => {
        if (book.userId !== row.user_id || book.perplConnectionId !== row.id || book.venueAccountId !== accountId)
          throw new Error('PERPL_BOOK_CONNECTION_MISMATCH')
      }
      const actionBook = async (bookId: string) => {
        const book = await this.store.getBook(row.user_id, bookId)
        if (!book) throw new Error('BOOK_NOT_FOUND')
        assertBook(book)
        if (!isCurrent()) throw new Error('PERPL_CONNECTION_UNAVAILABLE')
      }
      const guarded: RuntimeVenue = {
        accountId,
        connectionId: row.id,
        ready: () => isCurrent() && raw.ready(),
        close: () => this.evict(row.id, entry),
        ...(raw.listOpeningMarkets ? { listOpeningMarkets: () => use(async () => raw.listOpeningMarkets!()) } : {}),
        ...(raw.openingMarketSnapshot
          ? { openingMarketSnapshot: (marketId: number) => use(async () => raw.openingMarketSnapshot!(marketId)) }
          : {}),
        submit: (action) =>
          use(async () => {
            await actionBook(action.bookId)
            return raw.submit(action)
          }),
        reconcile: (action) =>
          use(async () => {
            await actionBook(action.bookId)
            return raw.reconcile(action)
          }),
        refresh: (book) =>
          use(async () => {
            assertBook(book)
            return raw.refresh(book)
          }),
        ...(raw.validate
          ? {
              validate: () =>
                use(async () => {
                  return raw.validate!()
                }),
            }
          : {}),
        ...(raw.listPositions
          ? {
              listPositions: () =>
                use(async () => {
                  return raw.listPositions!()
                }),
            }
          : {}),
        ...(raw.loadBookSetup
          ? {
              loadBookSetup: (marketId: number, requestedAccount: number, positionId: number) =>
                use(async () => {
                  if (requestedAccount !== accountId) throw new Error('PERPL_ACCOUNT_MISMATCH')
                  return raw.loadBookSetup!(marketId, requestedAccount, positionId)
                }),
            }
          : {}),
        ...(raw.capital
          ? {
              capital: (wallet?: string, userId?: string) =>
                use(async () => {
                  if (userId !== row.user_id || wallet?.toLowerCase() !== row.wallet_address.toLowerCase())
                    throw new Error('PERPL_WALLET_MISMATCH')
                  return raw.capital!(wallet, userId)
                }),
            }
          : {}),
        ...(raw.agoraActivity
          ? {
              agoraActivity: (wallet?: string, cursor?: string) =>
                use(async () => {
                  if (wallet?.toLowerCase() !== row.wallet_address.toLowerCase())
                    throw new Error('PERPL_WALLET_MISMATCH')
                  return raw.agoraActivity!(wallet, cursor)
                }),
            }
          : {}),
        ...(raw.syncClosedBooks
          ? {
              syncClosedBooks: (books: Book[]) =>
                use(async () => {
                  books.forEach(assertBook)
                  return raw.syncClosedBooks!(books)
                }),
            }
          : {}),
      }
      const entry: Entry = { userId: row.user_id, raw, guarded, use, lastUsedAt: this.now(), inFlight: 0 }
      this.entries.set(row.id, entry)
      return guarded
    } catch (error) {
      await this.closeTransport(row.id, raw)
      throw error
    }
  }

  // Callers must resolve an authenticated owner before touching a private venue.
  async submit(): Promise<never> {
    throw new Error('PERPL_CONNECTION_REQUIRED')
  }
  async reconcile(): Promise<never> {
    throw new Error('PERPL_CONNECTION_REQUIRED')
  }
  async refresh(): Promise<never> {
    throw new Error('PERPL_CONNECTION_REQUIRED')
  }
}
