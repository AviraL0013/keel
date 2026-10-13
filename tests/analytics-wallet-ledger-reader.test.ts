import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { RollupRepository } from '../server/src/infrastructure/analytics/rollup-repository.js'
import {
  readIndexedGrossSettlement,
  readIndexedTradePage,
} from '../server/src/infrastructure/analytics/wallet-ledger-reader.js'
import type { WalletChainAnalytics } from '../server/src/infrastructure/analytics/wallet-chain.js'

const address = '0x5d8ffa5f7c6a42470b4ec61a8cdabb799fd3765a'
const hash = `0x${'1'.repeat(64)}`
const blockHash = `0x${'2'.repeat(64)}`
const now = Date.UTC(2026, 9, 13, 1)

describe('indexed public-wallet trade path', () => {
  it('migrates additively, writes an idempotent ledger and proves each displayed owner', async () => {
    const db = new PGlite()
    try {
      for (const migration of [
        '020_analytics.sql',
        '021_analytics_rollups.sql',
        '037_analytics_rollup_owners.sql',
        '038_analytics_wallet_ledger.sql',
        '038_analytics_wallet_ledger.sql',
      ])
        await db.exec(await readFile(`database/migrations/${migration}`, 'utf8'))
      const query = async (sql: string, values?: unknown[]) => {
        const result = await db.query<Record<string, unknown>>(sql, values)
        return { ...result, rowCount: result.affectedRows ?? result.rows.length }
      }
      const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
      const repo = new RollupRepository(pool)
      const range = {
        fromBlock: 100000000n,
        toBlock: 100000010n,
        fromTime: new Date('2026-09-13T00:00:00.000Z'),
        throughTime: new Date('2026-10-13T00:00:01.000Z'),
        endHash: blockHash,
        logCount: 2,
      }
      const event = {
        blockNumber: '100000005',
        blockHash,
        transactionHash: hash,
        transactionIndex: 1,
        logIndex: 4,
        occurredAt: new Date('2026-10-10T00:00:00.000Z'),
        accountId: '7',
        marketId: 1,
        side: 'long' as const,
        action: 'close',
        priceRaw: '10000',
        sizeRaw: '10',
        feeMicros: '20',
        realizedPnlMicros: '-300',
        fillVerified: true,
      }
      await repo.saveRange(range, [], [], [event])
      await repo.applyOwners(new Map([['7', address]]), 100000011)
      expect(await repo.nextWalletBackfillRange()).toBeNull()
      const proof: WalletChainAnalytics['ownerAt'] = async (id, block, expectedHash) => ({
        accountId: id.toString(),
        address,
        block: block.toString(),
        blockHash: expectedHash,
        asOf: '2026-10-10T00:00:00.000Z',
        source: 'monad_exchange',
      })
      const market = new Map([[1, { marketId: 1, priceDecimals: 2, sizeDecimals: 3 }]])
      const result = await readIndexedTradePage(pool, address, market, proof, 10, undefined, now)
      expect(result.complete).toBe(true)
      expect(result.unavailableReason).toBeNull()
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        size: '0.010',
        price: '100.00',
        notional: '1.000000',
        realizedPnl: '-0.000300',
      })
      const gross = await readIndexedGrossSettlement(pool, address, proof, now)
      expect(gross.grossRealizedPnl).toBe('-0.000300')
      expect(gross.unavailableReason).toBeNull()
      await query('UPDATE analytics_rollup_coverage SET wallet_indexed_at=NULL')
      const incomplete = await readIndexedGrossSettlement(pool, address, proof, now)
      expect(incomplete.grossRealizedPnl).toBeNull()
      expect(incomplete.unavailableReason).toBe('INCOMPLETE_HISTORY')
      await repo.saveWalletRange(range, [event])
      expect((await query('SELECT count(*)::text AS n FROM analytics_wallet_event')).rows[0].n).toBe('1')
      const wrongOwner: WalletChainAnalytics['ownerAt'] = async (id, block, expectedHash) => ({
        accountId: id.toString(),
        address: '0x0000000000000000000000000000000000000001',
        block: block.toString(),
        blockHash: expectedHash,
        asOf: '2026-10-10T00:00:00.000Z',
        source: 'monad_exchange',
      })
      const mismatched = await readIndexedTradePage(pool, address, market, wrongOwner, 10, undefined, now)
      expect(mismatched.items).toEqual([])
      expect(mismatched.unavailableReason).toBe('OWNERSHIP_UNVERIFIED')
      expect((await readIndexedGrossSettlement(pool, address, wrongOwner, now)).grossRealizedPnl).toBeNull()
      await repo.saveWalletRange(range, [
        {
          ...event,
          logIndex: 5,
          action: 'unsupported',
          priceRaw: null,
          sizeRaw: null,
          realizedPnlMicros: null,
          fillVerified: false,
        },
      ])
      const unsupported = await readIndexedGrossSettlement(pool, address, proof, now)
      expect(unsupported.grossRealizedPnl).toBeNull()
      expect(unsupported.unavailableReason).toBe('SETTLEMENT_FORMULA_UNVERIFIED')
    } finally {
      await db.close()
    }
  }, 30_000)
})
