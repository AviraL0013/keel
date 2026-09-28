import { expect, it, vi } from 'vitest'
import type { Action } from '../packages/domain/src/index.js'
import { PerplAdapter } from '../packages/perpl/src/index.js'
import { PerplTradingClient, type PerplOrder } from '../packages/perpl/src/trading.js'
import { createPerplRuntime } from '../server/src/infrastructure/perpl/runtime.js'
import { databaseFixture } from './helpers/database.js'

it('uses the persisted Book side when constructing a live LONG REDUCE', async () => {
  vi.stubEnv('PERPL_API_KEY', 'test-read-only')
  vi.stubEnv('PERPL_API_KEY_SECRET', '11'.repeat(32))
  vi.stubEnv('PERPL_ACCOUNT_ID', '642')
  const { db, store } = await databaseFixture()
  let venue: ReturnType<typeof createPerplRuntime>
  try {
    const user = await store.ensureUser('owner')
    const now = Date.now()
    const position = {
      side: 'LONG' as const,
      size: 0.02,
      entryPrice: 2683.9,
      markPrice: 2706.54,
      liquidationPrice: 2594.44,
      leverage: 12,
      unrealizedPnl: 0.45,
      margin: 4.843693,
      status: 'OPEN' as const,
      timestamp: now,
    }
    const book = await store.createBook(user, {
      market: 'ETH',
      marketId: 32,
      venueAccountId: 642,
      venuePositionId: 4320379535360,
      side: 'LONG',
      stance: 'DEFEND',
      liquidationFloor: 5,
      defenseCap: 5,
      reserveAvailable: 5,
      timeLimitMs: 86_400_000,
      automationEnabled: false,
      status: 'ACTIVE',
      initialPosition: position,
      initialTelemetry: {
        mark: 2706.54,
        oracle: 2706.54,
        bid: 2704.5,
        ask: 2707.6,
        mid: 2706.05,
        spreadBps: 11,
        fundingRate: 0,
        depthNotional: 861766,
        volatility: 0.01,
        volume24h: 1,
        openInterest: 1,
        block: 1,
        timestamp: now,
        source: 'perpl-ws',
      },
    })
    vi.spyOn(PerplAdapter.prototype, 'getMarket').mockResolvedValue({
      id: 32,
      instance_id: 1,
      order_ttl_blocks: 20,
      config: { size_decimals: 3, price_decimals: 2 },
    })
    vi.spyOn(PerplAdapter.prototype, 'getProtocolContext').mockResolvedValue({
      chain: {},
      instances: [{ id: 1, collateral_token_id: 1 }],
      tokens: [{ id: 1, decimals: 6 }],
      markets: [],
    })
    let submitted: PerplOrder | undefined
    vi.spyOn(PerplTradingClient.prototype, 'submit').mockImplementation(async (_action, order) => {
      submitted = order
      return { venueReference: '642:1', status: 'SUBMITTED' }
    })
    venue = createPerplRuntime(store)
    const action = {
      id: crypto.randomUUID(),
      bookId: book.id,
      decisionId: crypto.randomUUID(),
      kind: 'REDUCE',
      amount: 0,
      status: 'QUEUED',
      idempotencyKey: 'test',
      beforeState: { position: { ...position, bookId: book.id }, reserve: {} as never, telemetry: {} as never },
    } as Action
    await venue!.submit(action)
    expect(submitted).toMatchObject({ acc: 642, mkt: 32, t: 3, s: 10, lp: 4320379535360, lv: 0 })
  } finally {
    await venue?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await db.close()
  }
}, 20_000)
