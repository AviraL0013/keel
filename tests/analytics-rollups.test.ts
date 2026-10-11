import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { toEventSelector, type AbiEvent } from 'viem'
import { RollupAccumulator, completeRange, newestGap } from '../packages/analytics/src/rollups.js'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.js'
import { HyperSyncRollupSource } from '../server/src/infrastructure/analytics/hypersync-rollups.js'
import { readLast30Days, RollupRepository } from '../server/src/infrastructure/analytics/rollup-repository.js'
import { AnalyticsRollupWorker } from '../server/src/workers/analytics-rollups.js'

const hash = `0x${'a'.repeat(64)}`
const at = new Date('2026-10-10T12:35:00.000Z')

function sample() {
  const rollup = new RollupAccumulator()
  rollup.add({ kind: 'account', accountId: '1', address: '0x1234' }, at)
  rollup.add({ kind: 'account', accountId: '2', address: '0x5678' }, at)
  rollup.add(
    {
      kind: 'fill',
      accountId: '1',
      marketId: 7,
      priceRaw: 1n,
      sizeRaw: 1n,
      notionalMicros: 100n,
      feeMicros: 8n,
      builderFeeMicros: 2n,
    },
    at,
  )
  rollup.add(
    {
      kind: 'fill',
      accountId: '1',
      marketId: 7,
      priceRaw: 1n,
      sizeRaw: 1n,
      notionalMicros: 100n,
      feeMicros: 3n,
      builderFeeMicros: 0n,
    },
    at,
  )
  rollup.add({ kind: 'taker_fee', feeMicros: 5n, builderFeeMicros: 1n }, at)
  rollup.add({ kind: 'flow', accountId: '1', direction: 'deposit', amountMicros: 200n }, at)
  rollup.add({ kind: 'flow', accountId: '1', direction: 'withdrawal', amountMicros: 70n }, at)
  rollup.add(
    {
      kind: 'position',
      accountId: '1',
      marketId: 7,
      side: 'long',
      action: 'open',
      sizeRaw: 1n,
      entryPriceRaw: 1n,
      leverageHundredths: null,
      collateralMicros: null,
      realizedPnlMicros: null,
      protocolFeeMicros: 4n,
    },
    at,
  )
  rollup.add(
    {
      kind: 'position',
      accountId: '1',
      marketId: 7,
      side: 'short',
      action: 'invert',
      sizeRaw: 1n,
      entryPriceRaw: 1n,
      leverageHundredths: null,
      collateralMicros: null,
      realizedPnlMicros: null,
      protocolFeeMicros: 2n,
    },
    at,
  )
  rollup.add(
    {
      kind: 'liquidation',
      accountId: '1',
      marketId: 7,
      side: 'long',
      lotRaw: 1n,
      remainingLotRaw: 0n,
      priceRaw: 1n,
      notionalMicros: 40n,
      realizedPnlMicros: 0n,
    },
    at,
  )
  rollup.add(
    {
      kind: 'position',
      accountId: '2',
      marketId: 7,
      side: 'long',
      action: 'reduce',
      sizeRaw: 1n,
      entryPriceRaw: null,
      leverageHundredths: null,
      collateralMicros: null,
      realizedPnlMicros: 0n,
      protocolFeeMicros: null,
    },
    at,
  )
  return rollup.result()
}

describe('last 30 days rollups', () => {
  it('keeps fees, revenue, flows, liquidation, unique actors and opening-side skew separate', () => {
    const { buckets, actors } = sample()
    const global = buckets.find((bucket) => bucket.grain === 'hour' && bucket.marketId === -1)!
    const market = buckets.find((bucket) => bucket.grain === 'hour' && bucket.marketId === 7)!
    expect(global.feesMicros).toBe(16n)
    expect(global.revenueMicros).toBe(6n)
    expect(global.depositsMicros - global.withdrawalsMicros).toBe(130n)
    expect(global.liquidationCount).toBe(1n)
    expect(global.liquidationNotionalMicros).toBe(40n)
    expect([market.longOpens, market.shortOpens]).toEqual([1n, 1n])
    expect(actors.filter((actor) => actor.grain === 'hour')).toEqual([
      { grain: 'hour', bucketStart: '2026-10-10T12:00:00.000Z', accountId: '1', ownerAddress: '0x1234' },
      { grain: 'hour', bucketStart: '2026-10-10T12:00:00.000Z', accountId: '2', ownerAddress: '0x5678' },
    ])
  })

  it('finds newest gap and proves only contiguous complete ranges', () => {
    const ranges = [
      { fromBlock: 100n, toBlock: 120n },
      { fromBlock: 140n, toBlock: 160n },
    ]
    expect(newestGap(ranges, 100n, 180n, 15n)).toEqual({ fromBlock: 165n, toBlock: 180n })
    expect(newestGap(ranges, 100n, 160n, 30n)).toEqual({ fromBlock: 120n, toBlock: 140n })
    expect(completeRange(ranges, 100n, 160n)).toBe(false)
    expect(completeRange([{ fromBlock: 100n, toBlock: 140n }, ranges[1]], 100n, 160n)).toBe(true)
    expect(newestGap([{ fromBlock: 20n, toBlock: 90n }], 100n, 120n, 50n)).toEqual({
      fromBlock: 100n,
      toBlock: 120n,
    })
  })

  it('decodes historical account owners without storing account events', async () => {
    const topic0 = toEventSelector(exchangeEvents.find((event) => event.name === 'AccountCreated') as AbiEvent)
    const data = `0x${'1234'.padStart(64, '0')}${'2'.padStart(64, '0')}`
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          next_block: 20,
          data: [{ logs: [{ block_number: 10, topic0, data }] }],
        }),
        { status: 200 },
      )
    const owners = await new HyperSyncRollupSource('test-token', fetcher as typeof fetch).readOwners(10, 20)
    expect(owners.get('2')).toBe('0x0000000000000000000000000000000000001234')
  })

  it('reads newest backfill first and continues the tail while descending', async () => {
    let height = 100_100_012
    const saved: Array<{ fromBlock: bigint; toBlock: bigint; endHash: string }> = []
    const calls: Array<[number, number]> = []
    const source = {
      height: async () => height,
      blockAtOrAfter: async () => 100_000_000,
      block: async (number: number) => ({ number, hash, timestamp: '0x1' }),
      readRange: async (from: number, to: number) => {
        calls.push([from, to])
        return { coverage: { fromBlock: BigInt(from), toBlock: BigInt(to),
          fromTime: at, throughTime: at, endHash: hash, logCount: 0 }, buckets: [], actors: [] }
      },
      readOwners: async () => new Map(),
    } as unknown as HyperSyncRollupSource
    const repo = {
      prune: async () => {},
      coverage: async () => [...saved].sort((a, b) => Number(b.fromBlock - a.fromBlock)),
      saveRange: async (range: { fromBlock: bigint; toBlock: bigint; endHash: string }) => { saved.push(range) },
      applyOwners: async () => {},
    } as unknown as RollupRepository
    const worker = new AnalyticsRollupWorker(source, repo, () => at.getTime())
    expect(await worker.step()).toBe('indexed')
    expect(calls).toEqual([[100_075_001, 100_100_001]])
    height += 100
    expect(await worker.step()).toBe('indexed')
    expect(calls.slice(1)).toEqual([[100_100_001, 100_100_101], [100_050_001, 100_075_001]])
  })

  it('replaces a range without double-counting, gates coverage, and prunes at 35 days', async () => {
    const db = new PGlite()
    try {
      await db.exec(await readFile('database/migrations/020_analytics.sql', 'utf8'))
      await db.exec(await readFile('database/migrations/021_analytics_rollups.sql', 'utf8'))
      const query = async (sql: string, values?: unknown[]) => {
        const result = await db.query<Record<string, unknown>>(sql, values)
        return { ...result, rowCount: result.affectedRows ?? result.rows.length }
      }
      const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
      const repo = new RollupRepository(pool)
      const range = {
        fromBlock: 100_000_000n,
        toBlock: 100_000_020n,
        fromTime: new Date('2026-09-10T13:00:00.000Z'),
        throughTime: new Date('2026-10-10T13:00:00.000Z'),
        endHash: hash,
        logCount: 9,
      }
      const { buckets, actors } = sample()
      await repo.saveRange(
        range,
        buckets,
        actors.map((actor) => ({ ...actor, ownerAddress: null })),
      )
      const bounds = {
        from: new Date('2026-09-10T13:00:00.000Z'),
        to: new Date('2026-10-10T13:00:00.000Z'),
        grain: 'hour' as const,
      }
      expect((await readLast30Days(pool, bounds))?.activeUsers).toBeNull()
      await repo.applyOwners(
        new Map([
          ['1', '0x1234'],
          ['2', '0x5678'],
        ]),
      )
      expect((await readLast30Days(pool, bounds))?.activeUsers).toBe(2n)
      await repo.saveRange(range, buckets, actors)
      await repo.saveRange(range, buckets, actors)
      const value = await readLast30Days(pool, bounds)
      expect(value?.markets.find((market) => market.marketId === -1)?.feesMicros).toBe(16n)
      expect(value?.activeUsers).toBe(2n)
      await repo.deleteRange(range.fromBlock, range.toBlock)
      expect(await readLast30Days(pool, bounds)).toBeNull()
      await repo.saveRange(range, buckets, actors)
      await repo.prune(new Date('2026-10-10T14:00:00.000Z'))
      expect(await repo.coverage()).toEqual([])
      expect((await query('SELECT count(*) AS count FROM analytics_rollup_actor')).rows[0].count).toBe(0)
      expect((await query('SELECT count(*) AS count FROM analytics_rollup_bucket')).rows[0].count).toBe(0)
    } finally {
      await db.close()
    }
  })
})
