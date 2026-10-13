import { expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { RuntimeVenue } from '../server/src/runtime.js'
import { StrategyFillRecovery } from '../server/src/workers/strategy-fill-recovery.js'
import type { WireFill } from '../packages/perpl/src/decoder.js'
const { ingest } = vi.hoisted(() => ({ ingest: vi.fn(async () => ({ inserted: true })) }))
vi.mock('../server/src/infrastructure/strategies/fill-ledger.js', () => ({
  StrategyFillLedger: class {
    ingest = ingest
  },
}))
it('does not let the first eight credited fills starve later evidence', async () => {
  const hash = `0x${'a'.repeat(64)}`
  const candidates: WireFill[] = Array.from({ length: 9 }, (_, index) => ({
    acc: 642,
    mkt: 16,
    oid: 99,
    t: 1,
    l: 1,
    p: 100,
    s: 10,
    f: '2',
    at: { b: 101, tx: 0, l: index, txid: hash },
  }))
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('FROM strategy_orders')
      ? [
          {
            id: 'order',
            user_id: 'owner',
            connection_id: 'connection',
            market_id: 16,
            venue_order_id: '99',
            created_at: new Date(),
            placement_block: 100,
          },
        ]
      : Array.from({ length: 8 }, (_, index) => ({
          transaction_hash: hash,
          fill: { transactionLogIndex: index, sizeRaw: '10', priceRaw: '100', grossFeeRaw: '2', builderFeeRaw: '0' },
        })),
  }))
  const venue = { forUser: async () => ({ strategyFillCandidates: async () => candidates }) } as unknown as RuntimeVenue
  const recovery = new StrategyFillRecovery({ query } as unknown as Pool, venue, 'testnet', 'https://rpc.invalid')
  await recovery.tick()
  expect(ingest).toHaveBeenCalledTimes(1)
  expect(ingest).toHaveBeenCalledWith('owner', 'order', candidates[8])
})
