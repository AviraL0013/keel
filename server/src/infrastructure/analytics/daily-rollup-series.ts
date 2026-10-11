import type pg from 'pg'
import { signedMoney } from '../../../../packages/analytics/src/aggregate.js'
import type { TimePoint } from '../../../../packages/analytics/src/contract.js'
import { completeRange } from '../../../../packages/analytics/src/rollups.js'

export type DailyRollupMetric = 'revenue' | 'liquidation_notional'
export interface DailyRollupSeries {
  points: TimePoint[]
  completeDays: number
  asOf: string | null
  block: number | null
  coverageFrom: string | null
  coverageThrough: string | null
}

const day = 86_400_000

/** Uncovered days stay null, even when no event row exists for them. */
export async function readDailyRollupSeries(
  pool: Pick<pg.Pool, 'connect'>,
  metric: DailyRollupMetric,
  from: Date,
  to: Date,
  marketId = -1,
): Promise<DailyRollupSeries> {
  if (
    (metric !== 'revenue' && metric !== 'liquidation_notional') ||
    !Number.isSafeInteger(marketId) ||
    marketId < -1 ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > 90 * day
  )
    throw Error('ANALYTICS_DAILY_RANGE_INVALID')
  const column = metric === 'revenue' ? 'revenue_micros' : 'liquidation_notional_micros'
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const ranges = await client.query(
      'SELECT from_block::text,to_block::text,from_time,through_time FROM analytics_rollup_coverage ORDER BY from_block',
    )
    const buckets = await client.query(
      `SELECT bucket_start,coalesce(sum(${column}),0)::text AS value
       FROM analytics_rollup_bucket WHERE grain='day' AND market_id=$1
         AND bucket_start >= $2 AND bucket_start < $3
       GROUP BY bucket_start ORDER BY bucket_start`,
      [marketId, from, to],
    )
    await client.query('COMMIT')
    const coverage = ranges.rows.map((row: Record<string, unknown>) => ({
      fromBlock: BigInt(String(row.from_block)),
      toBlock: BigInt(String(row.to_block)),
      fromTime: new Date(String(row.from_time)),
      throughTime: new Date(String(row.through_time)),
    }))
    const values = new Map<number, bigint>(
      buckets.rows.map((row: { bucket_start: Date; value: string }) => [
        new Date(row.bucket_start).getTime(),
        BigInt(row.value),
      ]),
    )
    const points: TimePoint[] = []
    let completeDays = 0
    for (let at = Math.ceil(from.getTime() / day) * day; at < to.getTime(); at += day) {
      const first = coverage.findLast((range) => range.fromTime.getTime() <= at)
      const last = coverage.find((range) => range.throughTime.getTime() >= at + day)
      const complete = !!first && !!last && completeRange(coverage, first.fromBlock, last.toBlock)
      if (complete) completeDays++
      points.push({ time: new Date(at).toISOString(), value: complete ? signedMoney(values.get(at) ?? 0n) : null })
    }
    const latest = coverage.at(-1)
    return {
      points,
      completeDays,
      asOf: latest?.throughTime.toISOString() ?? null,
      block: latest ? Number(latest.toBlock - 1n) : null,
      coverageFrom: coverage[0]?.fromTime.toISOString() ?? null,
      coverageThrough: latest?.throughTime.toISOString() ?? null,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
