import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { OpeningTrades } from '../server/src/application/opening-trades.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { OpeningMarketSnapshot } from '../packages/perpl/src/opening-preview.js'

it('stores a bound, hashed 15-second preview from a fresh account snapshot without sending an order', async () => {
  const { db, store } = await databaseFixture()
  try {
    const userId = await store.ensureUser('0x0000000000000000000000000000000000000001')
    const connectionId = randomUUID(),
      now = Date.now()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,wallet_address,scope_mask,expires_at)
      SELECT $1::uuid,id,'testnet','trade','fixture','ACTIVE',wallet_address,3,now()+interval '1 day' FROM users WHERE id=$2`,
      [connectionId, userId],
    )
    await db.query(
      `INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen)
      VALUES($1,12,true,false)`,
      [connectionId],
    )
    await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',12,$1)", [userId])
    const snapshot: OpeningMarketSnapshot = {
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
      balanceBlock: 100,
      marketBlock: 100,
      headBlock: 101,
      headObservedAt: now,
      orderTtlBlocks: 10,
      freeBalance: '1000.000000',
    }
    const send = vi.fn(async () => {
      throw new Error('ORDER_FORBIDDEN_IN_TEST')
    })
    const scoped: RuntimeVenue = {
      accountId: 12,
      connectionId,
      ready: () => true,
      openingMarketSnapshot: vi.fn(async () => snapshot),
      submit: send,
      reconcile: async (action) => action,
      refresh: async () => {},
      close: async () => {},
    }
    const venue: RuntimeVenue = { ...scoped, forUser: async (user) => (user === userId ? scoped : undefined) }
    const service = new OpeningTrades(store, venue, 'testnet', { enabled: true, executionDisabled: false }, () => now)
    const preview = await service.preview(userId, { marketId: 7, side: 'LONG', size: '0.00100', leverage: '5.00' })
    expect(preview).toMatchObject({
      connectionId,
      accountId: 12,
      expiresAt: now + 15000,
      quote: { marketId: 7, slippageBps: 50, environment: 'testnet', expiresAt: now + 15000 },
    })
    const row = (
      await db.query('SELECT user_id,connection_id,parameter_hash,expires_at FROM opening_previews WHERE id=$1', [
        preview.id,
      ])
    ).rows[0]
    expect(row.user_id).toBe(userId)
    expect(row.connection_id).toBe(connectionId)
    expect(row.parameter_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(send).not.toHaveBeenCalled()
    await expect(
      service.preview('00000000-0000-4000-8000-000000000000', {
        marketId: 7,
        side: 'LONG',
        size: '0.00100',
        leverage: '5.00',
      }),
    ).rejects.toThrow()
  } finally {
    await db.close()
  }
}, 30000)
