import type pg from 'pg'
import type { RollupActor, RollupBucket, RollupGrain } from '../../../../packages/analytics/src/rollups.js'
import { completeRange } from '../../../../packages/analytics/src/rollups.js'
import type { WalletLedgerRow } from './wallet-ledger.js'

export interface RollupCoverage {
  fromBlock: bigint
  toBlock: bigint
  fromTime: Date
  throughTime: Date
  endHash: string
  logCount: number
}

export class RollupRepository {
  constructor(readonly pool: pg.Pool) {}

  async coverage(): Promise<RollupCoverage[]> {
    const result = await this.pool.query(
      'SELECT from_block,to_block,from_time,through_time,end_hash,log_count FROM analytics_rollup_coverage ORDER BY from_block DESC',
    )
    return result.rows.map((row: Record<string, unknown>) => ({
      fromBlock: BigInt(String(row.from_block)),
      toBlock: BigInt(String(row.to_block)),
      fromTime: new Date(String(row.from_time)),
      throughTime: new Date(String(row.through_time)),
      endHash: String(row.end_hash),
      logCount: Number(row.log_count),
    }))
  }

  /** Replace an exact block range atomically. Wallet ledger is optional for older callers. */
  async saveRange(
    range: RollupCoverage,
    buckets: RollupBucket[],
    actors: RollupActor[],
    walletEvents?: WalletLedgerRow[],
  ): Promise<void> {
    if (
      range.fromBlock >= range.toBlock ||
      range.logCount < 0 ||
      range.fromTime > range.throughTime ||
      !/^0x[0-9a-f]{64}$/i.test(range.endHash)
    )
      throw new Error('ROLLUP_RANGE_INVALID')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const overlap = await client.query(
        `SELECT 1 FROM analytics_rollup_coverage WHERE from_block < $2 AND to_block > $1
         AND (from_block <> $1 OR to_block <> $2) LIMIT 1`,
        [range.fromBlock.toString(), range.toBlock.toString()],
      )
      if (overlap.rows.length) throw new Error('ROLLUP_COVERAGE_OVERLAP')
      await client.query('DELETE FROM analytics_rollup_coverage WHERE from_block=$1 AND to_block=$2', [
        range.fromBlock.toString(),
        range.toBlock.toString(),
      ])
      await client.query(
        `INSERT INTO analytics_rollup_coverage(from_block,to_block,from_time,through_time,end_hash,log_count)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          range.fromBlock.toString(),
          range.toBlock.toString(),
          range.fromTime,
          range.throughTime,
          range.endHash,
          range.logCount,
        ],
      )
      for (let start = 0; start < buckets.length; start += 500) {
        const rows = buckets.slice(start, start + 500).map((bucket) => ({
          grain: bucket.grain,
          bucket_start: bucket.bucketStart,
          market_id: bucket.marketId,
          fees_micros: bucket.feesMicros.toString(),
          revenue_micros: bucket.revenueMicros.toString(),
          deposits_micros: bucket.depositsMicros.toString(),
          withdrawals_micros: bucket.withdrawalsMicros.toString(),
          liquidation_count: bucket.liquidationCount.toString(),
          liquidation_notional_micros: bucket.liquidationNotionalMicros.toString(),
          long_opens: bucket.longOpens.toString(),
          short_opens: bucket.shortOpens.toString(),
        }))
        await client.query(
          `INSERT INTO analytics_rollup_bucket
           (from_block,to_block,grain,bucket_start,market_id,fees_micros,revenue_micros,deposits_micros,
            withdrawals_micros,liquidation_count,liquidation_notional_micros,long_opens,short_opens)
           SELECT $1,$2,x.grain,x.bucket_start,x.market_id,x.fees_micros,x.revenue_micros,x.deposits_micros,
             x.withdrawals_micros,x.liquidation_count,x.liquidation_notional_micros,x.long_opens,x.short_opens
           FROM jsonb_to_recordset($3::jsonb) AS x(grain text,bucket_start timestamptz,market_id integer,
             fees_micros numeric,revenue_micros numeric,deposits_micros numeric,withdrawals_micros numeric,
             liquidation_count bigint,liquidation_notional_micros numeric,long_opens bigint,short_opens bigint)`,
          [range.fromBlock.toString(), range.toBlock.toString(), JSON.stringify(rows)],
        )
      }
      for (let start = 0; start < actors.length; start += 500) {
        const rows = actors.slice(start, start + 500).map((actor) => ({
          grain: actor.grain,
          bucket_start: actor.bucketStart,
          account_id: actor.accountId,
          owner_address: actor.ownerAddress,
        }))
        await client.query(
          `INSERT INTO analytics_rollup_actor(from_block,to_block,grain,bucket_start,account_id,owner_address)
           SELECT $1,$2,x.grain,x.bucket_start,x.account_id,coalesce(x.owner_address,a.address,o.owner_address)
           FROM jsonb_to_recordset($3::jsonb) AS x(grain text,bucket_start timestamptz,
             account_id numeric,owner_address text)
           LEFT JOIN analytics_accounts a ON a.account_id=x.account_id
           LEFT JOIN analytics_rollup_owner o ON o.account_id=x.account_id`,
          [range.fromBlock.toString(), range.toBlock.toString(), JSON.stringify(rows)],
        )
      }
      if (walletEvents) {
        await this.insertWalletEvents(client, range, walletEvents)
        await client.query(
          'UPDATE analytics_rollup_coverage SET wallet_indexed_at=now() WHERE from_block=$1 AND to_block=$2',
          [range.fromBlock.toString(), range.toBlock.toString()],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async nextWalletBackfillRange(): Promise<RollupCoverage | null> {
    const result = await this.pool.query(
      `SELECT from_block,to_block,from_time,through_time,end_hash,log_count FROM analytics_rollup_coverage
       WHERE wallet_indexed_at IS NULL ORDER BY from_block DESC LIMIT 1`,
    )
    const row = result.rows[0]
    return row
      ? {
          fromBlock: BigInt(String(row.from_block)),
          toBlock: BigInt(String(row.to_block)),
          fromTime: new Date(String(row.from_time)),
          throughTime: new Date(String(row.through_time)),
          endHash: String(row.end_hash),
          logCount: Number(row.log_count),
        }
      : null
  }

  async saveWalletRange(range: RollupCoverage, walletEvents: WalletLedgerRow[]): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `SELECT end_hash FROM analytics_rollup_coverage WHERE from_block=$1 AND to_block=$2 FOR UPDATE`,
        [range.fromBlock.toString(), range.toBlock.toString()],
      )
      if (result.rows[0]?.end_hash?.toLowerCase() !== range.endHash.toLowerCase())
        throw new Error('WALLET_LEDGER_RANGE_CHANGED')
      await client.query('DELETE FROM analytics_wallet_event WHERE from_block=$1 AND to_block=$2', [
        range.fromBlock.toString(),
        range.toBlock.toString(),
      ])
      await this.insertWalletEvents(client, range, walletEvents)
      await client.query(
        'UPDATE analytics_rollup_coverage SET wallet_indexed_at=now() WHERE from_block=$1 AND to_block=$2',
        [range.fromBlock.toString(), range.toBlock.toString()],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async insertWalletEvents(
    client: pg.PoolClient,
    range: RollupCoverage,
    events: WalletLedgerRow[],
  ): Promise<void> {
    for (let start = 0; start < events.length; start += 500) {
      const rows = events.slice(start, start + 500).map((event) => ({
        block_number: event.blockNumber,
        block_hash: event.blockHash,
        transaction_hash: event.transactionHash,
        transaction_index: event.transactionIndex,
        log_index: event.logIndex,
        occurred_at: event.occurredAt,
        account_id: event.accountId,
        market_id: event.marketId,
        side: event.side,
        action: event.action,
        price_raw: event.priceRaw,
        size_raw: event.sizeRaw,
        fee_micros: event.feeMicros,
        realized_pnl_micros: event.realizedPnlMicros,
        fill_verified: event.fillVerified,
      }))
      await client.query(
        `INSERT INTO analytics_wallet_event
         (from_block,to_block,block_number,block_hash,transaction_hash,transaction_index,log_index,
          occurred_at,account_id,market_id,side,action,price_raw,size_raw,fee_micros,realized_pnl_micros,fill_verified)
         SELECT $1,$2,x.block_number,x.block_hash,x.transaction_hash,x.transaction_index,x.log_index,
          x.occurred_at,x.account_id,x.market_id,x.side,x.action,x.price_raw,x.size_raw,x.fee_micros,
          x.realized_pnl_micros,x.fill_verified
         FROM jsonb_to_recordset($3::jsonb) AS x(block_number bigint,block_hash text,transaction_hash text,
          transaction_index integer,log_index integer,occurred_at timestamptz,account_id numeric,
          market_id integer,side text,action text,price_raw numeric,size_raw numeric,fee_micros numeric,
          realized_pnl_micros numeric,fill_verified boolean)`,
        [range.fromBlock.toString(), range.toBlock.toString(), JSON.stringify(rows)],
      )
    }
  }

  async prune(cutoff: Date): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM analytics_rollup_bucket WHERE bucket_start < $1', [cutoff])
      await client.query('DELETE FROM analytics_rollup_actor WHERE bucket_start < $1', [cutoff])
      await client.query('DELETE FROM analytics_rollup_coverage WHERE through_time < $1', [cutoff])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async deleteRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    await this.pool.query('DELETE FROM analytics_rollup_coverage WHERE from_block=$1 AND to_block=$2', [
      fromBlock.toString(),
      toBlock.toString(),
    ])
  }

  async ownerCursor(): Promise<number> {
    const result = await this.pool.query('SELECT next_block FROM analytics_rollup_owner_scan WHERE id=1')
    const cursor = Number(result.rows[0]?.next_block)
    if (!Number.isSafeInteger(cursor) || cursor < 54_773_010) throw new Error('ROLLUP_OWNER_CURSOR_INVALID')
    return cursor
  }

  async applyOwners(owners: Map<string, string>, nextBlock: number): Promise<void> {
    if (!Number.isSafeInteger(nextBlock) || nextBlock < 54_773_010) throw new Error('ROLLUP_OWNER_CURSOR_INVALID')
    const entries = [...owners].map(([account_id, owner_address]) => ({ account_id, owner_address }))
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const progress = await client.query('SELECT next_block FROM analytics_rollup_owner_scan WHERE id=1 FOR UPDATE')
      const previous = Number(progress.rows[0]?.next_block)
      if (!Number.isSafeInteger(previous) || nextBlock < previous) throw new Error('ROLLUP_OWNER_CURSOR_INVALID')
      for (let start = 0; start < entries.length; start += 500) {
        const batch = JSON.stringify(entries.slice(start, start + 500))
        const saved = await client.query(
          `INSERT INTO analytics_rollup_owner(account_id,owner_address)
           SELECT x.account_id,x.owner_address FROM jsonb_to_recordset($1::jsonb)
           AS x(account_id numeric,owner_address text)
           ON CONFLICT (account_id) DO UPDATE SET owner_address=EXCLUDED.owner_address
           WHERE analytics_rollup_owner.owner_address=EXCLUDED.owner_address RETURNING account_id`,
          [batch],
        )
        if (saved.rows.length !== entries.slice(start, start + 500).length) throw new Error('ROLLUP_OWNER_CONFLICT')
        await client.query(
          `UPDATE analytics_rollup_actor r SET owner_address=x.owner_address
           FROM jsonb_to_recordset($1::jsonb) AS x(account_id numeric,owner_address text)
           WHERE r.account_id=x.account_id AND r.owner_address IS NULL`,
          [batch],
        )
      }
      await client.query('UPDATE analytics_rollup_owner_scan SET next_block=$1 WHERE id=1', [nextBlock])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

/** Read complete, aligned 24h, 7d, or 30d UTC buckets from one database snapshot. */
export async function readCoveredRollups(pool: pg.Pool, bounds: { from: Date; to: Date; grain: RollupGrain }) {
  const width = bounds.grain === 'hour' ? 3_600_000 : 86_400_000
  const span = bounds.to.getTime() - bounds.from.getTime()
  if (
    ![1, 7, 30].some((days) => span === days * 86_400_000) ||
    bounds.from.getTime() % width !== 0 ||
    bounds.to.getTime() % width !== 0 ||
    !Number.isFinite(bounds.from.getTime()) ||
    !Number.isFinite(bounds.to.getTime())
  )
    throw new Error('ROLLUP_WINDOW_BOUNDS_INVALID')
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const rows = await client.query(
      'SELECT from_block,to_block,from_time,through_time FROM analytics_rollup_coverage ORDER BY from_block',
    )
    const coverage = rows.rows.map(
      (row: { from_block: string; to_block: string; from_time: Date; through_time: Date }) => ({
        fromBlock: BigInt(row.from_block),
        toBlock: BigInt(row.to_block),
        fromTime: new Date(row.from_time),
        throughTime: new Date(row.through_time),
      }),
    )
    const first = coverage.findLast((range) => range.fromTime <= bounds.from)
    const last = coverage.find((range) => range.throughTime >= bounds.to)
    if (!first || !last || !completeRange(coverage, first.fromBlock, last.toBlock)) {
      await client.query('COMMIT')
      return null
    }
    const result = await client.query(
      `SELECT market_id,coalesce(sum(fees_micros),0) AS fees_micros,
      coalesce(sum(revenue_micros),0) AS revenue_micros,
      coalesce(sum(deposits_micros),0) AS deposits_micros,
      coalesce(sum(withdrawals_micros),0) AS withdrawals_micros,
      coalesce(sum(liquidation_count),0) AS liquidation_count,
      coalesce(sum(liquidation_notional_micros),0) AS liquidation_notional_micros,
      coalesce(sum(long_opens),0) AS long_opens,coalesce(sum(short_opens),0) AS short_opens
     FROM analytics_rollup_bucket WHERE grain=$1 AND bucket_start >= $2 AND bucket_start < $3
     GROUP BY market_id ORDER BY market_id`,
      [bounds.grain, bounds.from, bounds.to],
    )
    const users = await client.query(
      `SELECT count(DISTINCT owner_address) AS users,
      count(DISTINCT account_id) AS accounts,
      count(*) FILTER (WHERE owner_address IS NULL) AS unresolved
     FROM analytics_rollup_actor WHERE grain=$1 AND bucket_start >= $2 AND bucket_start < $3`,
      [bounds.grain, bounds.from, bounds.to],
    )
    const flowRows = await client.query(
      `SELECT bucket_start,sum(deposits_micros)::text AS deposits_micros,
        sum(withdrawals_micros)::text AS withdrawals_micros FROM analytics_rollup_bucket
       WHERE grain=$1 AND market_id=-1 AND bucket_start >= $2 AND bucket_start < $3
       GROUP BY bucket_start ORDER BY bucket_start`,
      [bounds.grain, bounds.from, bounds.to],
    )
    const actor = users.rows[0] as { users: string; accounts: string; unresolved: string }
    const markets = result.rows.map((row: Record<string, unknown>) => ({
      marketId: Number(row.market_id),
      feesMicros: BigInt(String(row.fees_micros)),
      revenueMicros: BigInt(String(row.revenue_micros)),
      depositsMicros: BigInt(String(row.deposits_micros)),
      withdrawalsMicros: BigInt(String(row.withdrawals_micros)),
      netFlowsMicros: BigInt(String(row.deposits_micros)) - BigInt(String(row.withdrawals_micros)),
      liquidationCount: BigInt(String(row.liquidation_count)),
      liquidationNotionalMicros: BigInt(String(row.liquidation_notional_micros)),
      longOpens: BigInt(String(row.long_opens)),
      shortOpens: BigInt(String(row.short_opens)),
      openingLongSharePct: (() => {
        const long = BigInt(String(row.long_opens))
        const total = long + BigInt(String(row.short_opens))
        if (total === 0n) return null
        const hundredths = (long * 10_000n + total / 2n) / total
        return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`
      })(),
    }))
    if (!markets.some((market) => market.marketId === -1))
      markets.unshift({
        marketId: -1,
        feesMicros: 0n,
        revenueMicros: 0n,
        depositsMicros: 0n,
        withdrawalsMicros: 0n,
        netFlowsMicros: 0n,
        liquidationCount: 0n,
        liquidationNotionalMicros: 0n,
        longOpens: 0n,
        shortOpens: 0n,
        openingLongSharePct: null,
      })
    await client.query('COMMIT')
    return {
      label: span === 86_400_000 ? 'Last 24 hours' : span === 7 * 86_400_000 ? 'Last 7 days' : 'Last 30 days',
      from: bounds.from.toISOString(),
      to: bounds.to.toISOString(),
      fromBlock: first.fromBlock.toString(),
      throughBlock: (last.toBlock - 1n).toString(),
      activeUsers: BigInt(actor.unresolved) === 0n ? BigInt(actor.users) : null,
      activeAccounts: BigInt(actor.accounts),
      flowBuckets: flowRows.rows.map(
        (row: { bucket_start: Date; deposits_micros: string; withdrawals_micros: string }) => ({
          time: new Date(row.bucket_start).toISOString(),
          depositsMicros: BigInt(row.deposits_micros),
          withdrawalsMicros: BigInt(row.withdrawals_micros),
        }),
      ),
      markets,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** Kept for callers that specifically require 30 full days. */
export function readLast30Days(pool: pg.Pool, bounds: { from: Date; to: Date; grain: RollupGrain }) {
  if (bounds.to.getTime() - bounds.from.getTime() !== 30 * 86_400_000)
    throw new Error('ROLLUP_LAST_30_DAYS_BOUNDS_INVALID')
  return readCoveredRollups(pool, bounds)
}
