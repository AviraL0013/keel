import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { OpeningTrades } from '../server/src/application/opening-trades.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { OpeningMarketSnapshot } from '../packages/perpl/src/opening-preview.js'

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
  let current: OpeningMarketSnapshot = {
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
    initialMarginBps: 1000,
    takerFeeMicros: 500,
    minimumNotionalRaw: '1000000',
    recycleFeeRaw: '1000',
    marketOpen: true,
    marketObservedAt: now,
    balanceObservedAt: now,
    marketBlock: 100,
    headBlock: 101,
    headObservedAt: now,
    orderTtlBlocks: 10,
    freeBalance: '1000.000000',
  }
  const send = vi.fn(async () => {
    throw new Error('NO_ORDER_IN_TEST')
  })
  const scoped: RuntimeVenue = {
    accountId: 12,
    connectionId,
    ready: () => true,
    openingMarketSnapshot: async () => current,
    submit: send,
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
    input,
    setSnapshot: (change: Partial<OpeningMarketSnapshot>) => {
      current = { ...current, ...change }
    },
    setTime: (time: number) => {
      clock = time
    },
  }
}

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
    expect((await f.db.query('SELECT count(*)::int AS count FROM opening_orders')).rows[0].count).toBe(0)
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
    expect((await f.db.query('SELECT count(*)::int AS count FROM opening_orders')).rows[0].count).toBe(0)
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
