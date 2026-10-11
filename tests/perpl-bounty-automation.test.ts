import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { Action, Book } from '../packages/domain/src/index.js'
import type { BookSetup } from '../server/src/application/books.js'
import { EyelerRuntime, type RuntimeVenue } from '../server/src/runtime.js'
import { generateRunReport } from '../scripts/report.js'
import { databaseFixture } from './helpers/database.js'

afterEach(() => vi.unstubAllEnvs())

// All account state, requests, blocks and hashes below are offline fixtures.
// No venue adapter, RPC reader, credential or real transaction is involved.
async function fixture(stance: 'DEFEND' | 'HARVEST', stale = false) {
  const { db, store } = await databaseFixture()
  const userId = await store.ensureUser('offline-bounty-automation-owner')
  const connectionId = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
     VALUES($1,$2,'testnet','trade','offline-fixture-only','ACTIVE',now()+interval '1 day')`,
    [connectionId, userId],
  )
  await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,7,true,false)', [
    connectionId,
  ])
  await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',7,$1)", [userId])
  const at = Date.now()
  const setup: BookSetup = {
    market: 'BTC-PERP',
    reserveAvailable: 50,
    position: {
      side: 'LONG',
      size: 1,
      entryPrice: 100,
      markPrice: 95,
      liquidationPrice: 90,
      leverage: 5,
      unrealizedPnl: -5,
      margin: 20,
      status: 'OPEN',
      timestamp: at,
    },
    telemetry: {
      mark: 95,
      oracle: 95,
      bid: 94.9,
      ask: 95.1,
      mid: 95,
      spreadBps: 20,
      fundingRate: 0,
      depthNotional: 10_000,
      volatility: 0.01,
      volume24h: 10,
      openInterest: 100,
      block: 1,
      timestamp: at,
      source: 'fake-venue',
    },
    capital: { environment: 'testnet', accountId: 7, free: '100.000000', observedAt: at, observedBlock: 1 },
  }
  const book = await store.createBook(
    userId,
    {
      market: setup.market,
      marketId: 1,
      venueAccountId: 7,
      venuePositionId: 9,
      perplConnectionId: connectionId,
      side: 'LONG',
      stance,
      status: 'ACTIVE',
      automationEnabled: true,
      liquidationFloor: 6,
      defenseCap: 50,
      reserveAvailable: 50,
      timeLimitMs: 3_600_000,
    },
    async () => setup,
  )
  const refresh = async (current: Book) => {
    const observedAt = new Date(Date.now() - (stale ? 60_000 : 0)).toISOString()
    await db.query('UPDATE positions SET observed_at=$2 WHERE book_id=$1', [current.id, observedAt])
    await db.query(
      `UPDATE risk_snapshots r SET timestamp=$2,freshness_detail=NULL,
       mark=p.mark_price,oracle=p.mark_price,mid=p.mark_price,bid=p.mark_price-0.1,ask=p.mark_price+0.1,
       liquidation=p.liquidation_price FROM positions p WHERE r.book_id=p.book_id AND r.book_id=$1`,
      [current.id, observedAt],
    )
  }
  const sends: string[] = []
  const submit = vi.fn<RuntimeVenue['submit']>(async (action, verifyBeforeSend) => {
    expect(verifyBeforeSend).toBeTypeOf('function')
    await verifyBeforeSend!()
    sends.push(action.id)
    return {
      status: 'SUBMITTED',
      venueReference: '7:101',
      venueProgress: { requestId: '101', requestedLastExecBlock: 12, effectiveLastExecBlock: 12 },
    }
  })
  let reconciliationCount = 0
  const syntheticHash = `0x${'a'.repeat(64)}`
  const reconcile = vi.fn(async (action: Action): Promise<Action> => {
    reconciliationCount++
    if (reconciliationCount === 1) return { ...action, status: 'VERIFYING' }
    await db.query(
      `UPDATE positions SET size=$2,liquidation_price=80,margin=$3,unrealized_pnl=$4,observed_at=now()
       WHERE book_id=$1`,
      [
        action.bookId,
        action.kind === 'REDUCE' ? 0.5 : 1,
        action.kind === 'DEFEND' ? 20 + action.amount : 10,
        action.kind === 'REDUCE' ? -2.5 : -5,
      ],
    )
    await refresh(book)
    return {
      ...action,
      status: 'CONFIRMED',
      confirmedAt: new Date().toISOString(),
      venueReference: action.kind === 'DEFEND' ? `7:101:${syntheticHash}` : '7:101',
      venueProgress: { ...action.venueProgress, requestId: '101', confirmedExecutionBlock: 10 },
    }
  })
  const scoped: RuntimeVenue = {
    accountId: 7,
    connectionId,
    ready: () => true,
    submit,
    reconcile,
    refresh,
    close: async () => undefined,
  }
  const forUser = vi.fn(async (requestedUser: string, requestedConnection?: string) => {
    if (requestedUser !== userId || requestedConnection !== connectionId) return undefined
    return scoped
  })
  const venue: RuntimeVenue = {
    ...scoped,
    submit: async () => {
      throw Error('OFFLINE_TEST_REQUIRES_BOUND_VENUE')
    },
    reconcile: async () => {
      throw Error('OFFLINE_TEST_REQUIRES_BOUND_VENUE')
    },
    forUser,
  }
  const runtime = () => {
    const value = new EyelerRuntime(store, venue)
    Object.assign(value, { lease: { query: async () => ({ rows: [] }) } })
    return { tick: () => (value as unknown as { tick(): Promise<void> }).tick() }
  }
  return { db, store, book, userId, connectionId, sends, submit, reconcile, forUser, syntheticHash, runtime }
}

it.each([
  ['DEFEND', 'DEFEND'],
  ['HARVEST', 'REDUCE'],
] as const)(
  'mounted offline %s protection confirms %s once across restart and exports linked evidence',
  async (stance, kind) => {
    const f = await fixture(stance)
    try {
      const first = f.runtime()
      vi.stubEnv('EYELER_EXECUTION_DISABLED', 'true')
      await first.tick()
      expect(f.sends).toEqual([])
      expect((await f.db.query('SELECT id FROM actions WHERE book_id=$1', [f.book.id])).rows).toHaveLength(0)

      vi.stubEnv('EYELER_EXECUTION_DISABLED', 'false')
      await first.tick()
      expect(f.submit).toHaveBeenCalledTimes(1)
      const pending = (
        await f.db.query<{ id: string; decision_id: string; status: string; kind: string; amount: string }>(
          'SELECT id,decision_id,status,kind,amount::text FROM actions WHERE book_id=$1',
          [f.book.id],
        )
      ).rows[0]!
      expect(pending).toMatchObject({ kind, status: 'VERIFYING' })
      expect(
        (
          await f.db.query("SELECT id FROM reserve_ledger_entries WHERE book_id=$1 AND type='RESERVE_DEPLOYED'", [
            f.book.id,
          ])
        ).rows,
      ).toHaveLength(0)

      const restarted = f.runtime()
      await restarted.tick()
      await restarted.tick()
      expect(f.sends).toEqual([pending.id])
      expect(f.reconcile).toHaveBeenCalledTimes(2)
      expect(f.forUser).toHaveBeenCalledWith(f.userId, f.connectionId)
      const actions = (await f.db.query('SELECT id,decision_id,status,kind FROM actions WHERE book_id=$1', [f.book.id]))
        .rows
      expect(actions).toEqual([{ id: pending.id, decision_id: pending.decision_id, status: 'CONFIRMED', kind }])
      const origins = (
        await f.db.query<{ id: string; payload: { actionId: string; origin: string } }>(
          'SELECT id,payload FROM autopsy_events WHERE book_id=$1 AND type=$2',
          [f.book.id, `${kind}_QUEUED`],
        )
      ).rows
      expect(origins).toHaveLength(1)
      expect(origins[0]!.payload).toMatchObject({ actionId: pending.id, origin: 'AUTOMATION' })
      const deployments = (
        await f.db.query<{ action_id: string; decision_id: string; amount: string }>(
          "SELECT action_id,decision_id,amount::text FROM reserve_ledger_entries WHERE book_id=$1 AND type='RESERVE_DEPLOYED'",
          [f.book.id],
        )
      ).rows
      const reserve = (
        await f.db.query<{ available: string; reserved: string; deployed: string }>(
          'SELECT available::text,reserved::text,deployed::text FROM reserves WHERE book_id=$1',
          [f.book.id],
        )
      ).rows[0]!
      if (kind === 'DEFEND') {
        expect(Number(pending.amount)).toBeGreaterThan(0)
        expect(deployments).toEqual([
          { action_id: pending.id, decision_id: pending.decision_id, amount: pending.amount },
        ])
        expect(Number(reserve.deployed)).toBe(Number(pending.amount))
        expect(Number(reserve.available)).toBeCloseTo(50 - Number(pending.amount), 6)
      } else {
        expect(deployments).toHaveLength(0)
        expect(Number(reserve.deployed)).toBe(0)
        expect(Number(reserve.available)).toBe(50)
        expect(
          Number((await f.db.query('SELECT size FROM positions WHERE book_id=$1', [f.book.id])).rows[0]!.size),
        ).toBe(0.5)
      }
      expect(Number(reserve.reserved)).toBe(0)

      const report = await generateRunReport(
        f.store.pool,
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 60_000),
        f.book.id,
        'https://offline-explorer.invalid',
        'OFFLINE synthetic PGlite / fake venue',
      )
      expect(report).toContain(`${f.book.id} / ${pending.id} / ${pending.decision_id}`)
      expect(report).toContain('BTC-PERP (1) / 7 / 9')
      expect(report).toContain('| AUTOMATION | CONFIRMED / - |')
      expect(report).toContain('| 101 | 12 / 12 | 10 |')
      expect(report).toContain(origins[0]!.id)
      expect(report).toContain('Automated attempts with explicit origin: 1.')
      expect(report).toContain('Net realized P&L: unavailable')
      expect(report).toContain('simulated transports are not real activity')
      if (kind === 'DEFEND') {
        expect(report).toContain('STORED_RECEIPT_BACKED')
        expect(report).toContain(`https://offline-explorer.invalid/tx/${f.syntheticHash}`)
      } else {
        expect(report).toContain('VENUE_RECONCILED')
        expect(report).toContain('Automated stored receipt-backed confirmations: 0.')
        expect(report).not.toContain(f.syntheticHash)
      }
    } finally {
      await f.db.close()
    }
  },
  30_000,
)

it('mounted offline protection enters SAFE_MODE without a send when required telemetry is stale', async () => {
  vi.stubEnv('EYELER_EXECUTION_DISABLED', 'false')
  const f = await fixture('DEFEND', true)
  try {
    await f.runtime().tick()
    expect(f.sends).toEqual([])
    expect(f.reconcile).not.toHaveBeenCalled()
    expect((await f.store.getBook(f.userId, f.book.id))?.status).toBe('SAFE_MODE')
    expect((await f.db.query('SELECT id FROM actions WHERE book_id=$1', [f.book.id])).rows).toHaveLength(0)
  } finally {
    await f.db.close()
  }
}, 30_000)
