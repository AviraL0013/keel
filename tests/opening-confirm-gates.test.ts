import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { OpeningTrades } from '../server/src/application/opening-trades.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { OpeningMarketSnapshot } from '../packages/perpl/src/opening-preview.js'
import type { OpeningMarketDetail } from '../packages/perpl/src/opening-market.js'
import { PerplPreSubmissionError } from '../packages/perpl/src/trading.js'

async function fixture() {
  const { db, store } = await databaseFixture()
  const userId = await store.ensureUser('0x0000000000000000000000000000000000000001')
  const other = await store.ensureUser('0x0000000000000000000000000000000000000002')
  const connectionId = randomUUID(),
    now = Date.now()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,wallet_address,scope_mask,expires_at)
    SELECT $1::uuid,id,'testnet','trade','fixture','ACTIVE',wallet_address,3,now()+interval '1 day' FROM users WHERE id=$2`,
    [connectionId, userId],
  )
  await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,12,true,false)', [
    connectionId,
  ])
  await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',12,$1)", [userId])
  let current: OpeningMarketDetail = {
    environment: 'testnet',
    accountId: 12,
    marketId: 7,
    symbol: 'BTC',
    collateralAsset: 'USD',
    priceDecimals: 1,
    sizeDecimals: 5,
    collateralDecimals: 6,
    bidRaw: 999999,
    askRaw: 1000001,
    markRaw: 1000000,
    priceTick: '0.1',
    sizeStep: '0.00001',
    minimumSize: '0.00001',
    initialMarginBps: 1000,
    takerFeeMicros: 500,
    minimumNotionalRaw: '1000000',
    recycleFeeRaw: '1000',
    marketOpen: true,
    marketObservedAt: now,
    balanceObservedAt: now,
    balanceBlock: 100,
    marketBlock: 100,
    headBlock: 101,
    headObservedAt: now,
    orderTtlBlocks: 10,
    freeBalance: '1000.000000',
  }
  const send = vi.fn(async () => {
    throw new Error('NO_ORDER_IN_TEST')
  })
  let beforeVerify = () => {}
  let duringSnapshot = () => {}
  const fakeWireWrite = vi.fn()
  const sendOpening = vi.fn(
    async (
      _id: string,
      _order: unknown,
      beforeSend: (reference: string, lb: number) => Promise<void>,
      verifyBeforeSend?: () => Promise<void>,
    ) => {
      await beforeSend('12:45', 111)
      beforeVerify()
      try {
        await verifyBeforeSend?.()
      } catch (error) {
        throw new PerplPreSubmissionError(error instanceof Error ? error.message : 'PRE_SEND_FAILED')
      }
      fakeWireWrite()
      return {
        venueReference: '12:45',
        status: 'SUBMITTED' as const,
        venueProgress: {
          requestId: '45',
          clientSequence: 1,
          admitted: true,
          requestedLastExecBlock: 111,
          response: 'ADMITTED' as const,
        },
      }
    },
  )
  const reconcileOpening = vi.fn(async () => ({
    status: 'CONFIRMED' as const,
    filledSize: '0.00100',
    averagePrice: '100000.0',
    positionId: 98,
    txHash: `0x${'a'.repeat(64)}`,
    evidence: { orders: [], fills: [], positions: [], operations: [] },
  }))
  const scoped: RuntimeVenue = {
    accountId: 12,
    connectionId,
    ready: () => true,
    openingMarketSnapshot: async () => {
      duringSnapshot()
      return current
    },
    submit: send,
    submitOpening: sendOpening,
    reconcileOpening,
    reconcile: async (action) => action,
    refresh: async () => {},
    close: async () => {},
  }
  const venue: RuntimeVenue = {
    ...scoped,
    forUser: async (user, id) => (user === userId && (!id || id === connectionId) ? scoped : undefined),
  }
  let clock = now
  const service = new OpeningTrades(store, venue, 'testnet', { enabled: true, executionDisabled: false }, () => clock)
  const input = { marketId: 7, side: 'LONG' as const, size: '0.00100', leverage: '5.00' }
  return {
    db,
    store,
    userId,
    other,
    connectionId,
    now,
    service,
    send,
    sendOpening,
    reconcileOpening,
    fakeWireWrite,
    setBeforeVerify: (work: () => void) => {
      beforeVerify = work
    },
    setDuringSnapshot: (work: () => void) => {
      duringSnapshot = work
    },
    input,
    setSnapshot: (change: Partial<OpeningMarketSnapshot>) => {
      current = { ...current, ...change }
    },
    setTime: (time: number) => {
      clock = time
    },
  }
}

it('compares asynchronous quote timestamps with the clock after the snapshot arrives', async () => {
  const f = await fixture()
  let tick = f.now
  try {
    f.setDuringSnapshot(() => {
      tick++
      f.setTime(tick)
      f.setSnapshot({ marketObservedAt: tick, balanceObservedAt: tick, headObservedAt: tick })
    })
    const preview = await f.service.preview(f.userId, f.input)
    const confirmed = await f.service.confirm(f.userId, preview.id, randomUUID())
    expect(confirmed.status).toBe('VERIFYING')
    expect(f.fakeWireWrite).toHaveBeenCalledOnce()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('refuses expiry during delayed admission or final snapshot with no fake socket write', async () => {
  const f = await fixture()
  try {
    const expiredSnapshot = () => {
      const at = f.now + 15_001
      f.setTime(at)
      f.setSnapshot({ marketObservedAt: at, balanceObservedAt: at, headObservedAt: at })
    }
    const first = await f.service.preview(f.userId, f.input)
    f.setDuringSnapshot(expiredSnapshot)
    await expect(f.service.prepareConfirmation(f.userId, first.id, randomUUID())).rejects.toThrow('PREVIEW_STALE')
    expect(
      (await f.db.query<{ count: number }>('SELECT count(*)::int AS count FROM opening_orders')).rows[0].count,
    ).toBe(0)
    f.setDuringSnapshot(() => {})
    f.setTime(f.now)
    f.setSnapshot({ marketObservedAt: f.now, balanceObservedAt: f.now, headObservedAt: f.now })
    const second = await f.service.preview(f.userId, f.input)
    f.setBeforeVerify(() => f.setDuringSnapshot(expiredSnapshot))
    expect(await f.service.confirm(f.userId, second.id, randomUUID())).toMatchObject({
      status: 'FAILED',
      error: 'PREVIEW_STALE',
    })
    expect(f.fakeWireWrite).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('keeps Book reserve admission scoped to the opening environment', async () => {
  const f = await fixture()
  try {
    const mainnet = randomUUID(),
      book = randomUUID()
    await f.db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
      VALUES($1,$2,'mainnet','trade','fake','ACTIVE',now()+interval '1 day')`,
      [mainnet, f.userId],
    )
    await f.db.query(
      `INSERT INTO books(id,user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms,venue_account_id,perpl_connection_id)
      VALUES($1,$2,'BTC','LONG','DEFEND',5,10,1000,12,$3)`,
      [book, f.userId, mainnet],
    )
    await f.db.query('INSERT INTO reserves(book_id,available,reserved,deployed,cap) VALUES($1,10000,0,0,10)', [book])
    const preview = await f.service.preview(f.userId, f.input)
    expect((await f.service.confirm(f.userId, preview.id, randomUUID())).status).toBe('VERIFYING')
    expect(f.fakeWireWrite).toHaveBeenCalledOnce()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('recovers a durable opening after restart and never sends it again', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    const first = await f.service.confirm(f.userId, preview.id, randomUUID())
    expect(first.status).toBe('VERIFYING')
    const recovered = await f.service.reconcile(f.userId, first.id)
    expect(recovered).toMatchObject({
      status: 'CONFIRMED',
      position_id: 98,
      filled_size: '0.001000000000000000',
      tx_hash: `0x${'a'.repeat(64)}`,
    })
    expect(f.sendOpening).toHaveBeenCalledOnce()
    expect(f.reconcileOpening).toHaveBeenCalledOnce()
  } finally {
    await f.db.close()
  }
}, 30000)

it('rejects a changed market precision immediately before fake socket write', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    f.setBeforeVerify(() => f.setSnapshot({ priceDecimals: 2 }))
    const result = await f.service.confirm(f.userId, preview.id, randomUUID())
    expect(result).toMatchObject({ status: 'FAILED', error: 'PREVIEW_STALE' })
    expect(f.fakeWireWrite).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('does not fail an in-flight queued confirmation before its send callback', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    const queued = await f.service.prepareConfirmation(f.userId, preview.id, randomUUID())
    expect((await f.service.reconcile(f.userId, queued.id)).status).toBe('QUEUED')
    f.setTime(f.now + 181_000)
    expect((await f.service.reconcile(f.userId, queued.id)).status).toBe('FAILED')
    expect(f.fakeWireWrite).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('settles an old unknown opening only when no durable venue reference exists', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    const queued = await f.service.prepareConfirmation(f.userId, preview.id, randomUUID())
    await f.db.query("UPDATE opening_orders SET status='UNKNOWN' WHERE id=$1", [queued.id])
    expect((await f.service.reconcile(f.userId, queued.id)).status).toBe('UNKNOWN')
    f.setTime(f.now + 181_000)
    expect(await f.service.reconcile(f.userId, queued.id)).toMatchObject({
      status: 'FAILED',
      error: 'MISSING_DURABLE_VENUE_REFERENCE',
    })
    expect(f.fakeWireWrite).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('confirms once, persists request ID and lb before fake submission, and never resends duplicate key', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    const key = randomUUID()
    const first = await f.service.confirm(f.userId, preview.id, key)
    expect(first).toMatchObject({ status: 'VERIFYING', request_id: '45', lb: 111 })
    const again = await f.service.confirm(f.userId, preview.id, key)
    expect(again.id).toBe(first.id)
    expect(f.sendOpening).toHaveBeenCalledOnce()
    expect(f.sendOpening.mock.calls[0][1]).toMatchObject({ mkt: 7, acc: 12, t: 1, s: 100, lv: 500 })
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('binds confirmation to the owner and UUID key, returns duplicate intent, and never sends in preparation', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    const key = randomUUID()
    await expect(f.service.prepareConfirmation(f.other, preview.id, randomUUID())).rejects.toThrow(
      'OPENING_PREVIEW_NOT_FOUND',
    )
    await expect(f.service.prepareConfirmation(f.userId, randomUUID(), randomUUID())).rejects.toThrow(
      'OPENING_PREVIEW_NOT_FOUND',
    )
    const first = await f.service.prepareConfirmation(f.userId, preview.id, key)
    const again = await f.service.prepareConfirmation(f.userId, preview.id, key)
    expect(again.id).toBe(first.id)
    expect(first).toMatchObject({ status: 'QUEUED', account_id: 12 })
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('refuses expired and moved-price previews before intent persistence', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    f.setSnapshot({ askRaw: 1_005_002 })
    await expect(f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).rejects.toThrow('PREVIEW_STALE')
    f.setSnapshot({ askRaw: 1_000_001 })
    f.setTime(f.now + 15001)
    await expect(f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).rejects.toThrow('PREVIEW_STALE')
    expect(
      (await f.db.query<{ count: number }>('SELECT count(*)::int AS count FROM opening_orders')).rows[0].count,
    ).toBe(0)
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('refuses a better short fill when its larger notional exceeds the confirmed collateral quote', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, { ...f.input, side: 'SHORT' })
    f.setSnapshot({ bidRaw: 1_100_000, askRaw: 1_100_001 })
    await expect(f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).rejects.toThrow('PREVIEW_STALE')
    expect(
      (await f.db.query<{ count: number }>('SELECT count(*)::int AS count FROM opening_orders')).rows[0].count,
    ).toBe(0)
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('rejects a preview whose separately stored quote differs from its hashed parameters', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    await f.db.query(
      "UPDATE opening_previews SET quote=jsonb_set(quote,'{builderFeePer100K}','1'::jsonb) WHERE id=$1",
      [preview.id],
    )
    await expect(f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).rejects.toThrow('PREVIEW_STALE')
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('refuses stale balance, insufficient balance, and underfunded Book reserves at one micro', async () => {
  const f = await fixture()
  try {
    const preview = await f.service.preview(f.userId, f.input)
    f.setSnapshot({ balanceObservedAt: f.now - 5001 })
    await expect(f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).rejects.toThrow(
      'PERPL_FREE_BALANCE_UNAVAILABLE',
    )
    f.setSnapshot({ balanceObservedAt: f.now, freeBalance: '20.151270' })
    await expect(f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).rejects.toThrow(
      'PERPL_FREE_BALANCE_INSUFFICIENT',
    )
    const book = randomUUID()
    await f.db.query(
      `INSERT INTO books(id,user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms,venue_account_id,perpl_connection_id)
      VALUES($1,$2,'BTC','LONG','DEFEND',5,10,1000,12,$3)`,
      [book, f.userId, f.connectionId],
    )
    await f.db.query('INSERT INTO reserves(book_id,available,reserved,deployed,cap) VALUES($1,10,0,0,10)', [book])
    f.setSnapshot({ freeBalance: '30.151270' })
    await expect(f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).rejects.toThrow(
      'OPENING_WOULD_UNDERFUND_BOOK_RESERVES',
    )
    await f.db.query("UPDATE books SET status='PAUSED' WHERE id=$1", [book])
    await expect(f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).rejects.toThrow(
      'OPENING_WOULD_UNDERFUND_BOOK_RESERVES',
    )
    f.setSnapshot({ freeBalance: '30.151271' })
    expect((await f.service.prepareConfirmation(f.userId, preview.id, randomUUID())).status).toBe('QUEUED')
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)
