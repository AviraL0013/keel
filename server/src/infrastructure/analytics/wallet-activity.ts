import type pg from 'pg'
import { completeRange } from '../../../../packages/analytics/src/rollups.js'

const day = 86_400_000

export interface WalletActivity {
  activeDays: number | null
  verifiedDays: number
  points: Array<{ time: string; value: string | null }>
  asOf: string | null
  block: number | null
  from: string
  through: string
}

/** Activity of accounts linked to this address now; historical ownership is not inferred. */
export async function readWalletActivity(
  pool: Pick<pg.Pool, 'connect'>,
  accountIds: string[],
  now = Date.now(),
): Promise<WalletActivity> {
  if (accountIds.some((id) => !/^[1-9]\d*$/.test(id)) || !Number.isFinite(now))
    throw Error('ANALYTICS_WALLET_ACTIVITY_INVALID')
  const to = Math.floor(now / day) * day
  const from = to - 30 * day
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const ranges = await client.query(
      'SELECT from_block::text,to_block::text,from_time,through_time FROM analytics_rollup_coverage ORDER BY from_block',
    )
    const observed = accountIds.length
      ? await client.query(
          `SELECT bucket_start,count(DISTINCT account_id)::text AS accounts
           FROM analytics_rollup_actor WHERE grain='day' AND bucket_start >= $1 AND bucket_start < $2
             AND account_id = ANY($3::numeric[])
           GROUP BY bucket_start`,
          [new Date(from), new Date(to), accountIds],
        )
      : { rows: [] }
    await client.query('COMMIT')
    const coverage = ranges.rows.map((row: Record<string, unknown>) => ({
      fromBlock: BigInt(String(row.from_block)),
      toBlock: BigInt(String(row.to_block)),
      fromTime: new Date(String(row.from_time)),
      throughTime: new Date(String(row.through_time)),
    }))
    const accounts = new Map<number, string>(
      observed.rows.map((row: { bucket_start: Date; accounts: string }) => [
        new Date(row.bucket_start).getTime(),
        row.accounts,
      ]),
    )
    const points: WalletActivity['points'] = []
    for (let at = from; at < to; at += day) {
      const first = coverage.findLast((range) => range.fromTime.getTime() <= at)
      const last = coverage.find((range) => range.throughTime.getTime() >= at + day)
      const complete = !!first && !!last && completeRange(coverage, first.fromBlock, last.toBlock)
      points.push({ time: new Date(at).toISOString(), value: complete ? (accounts.get(at) ?? '0') : null })
    }
    const verifiedDays = points.filter((point) => point.value !== null).length
    const latest = coverage.at(-1)
    return {
      activeDays: verifiedDays === 30 ? points.filter((point) => point.value !== '0').length : null,
      verifiedDays,
      points,
      asOf: latest?.throughTime.toISOString() ?? null,
      block: latest ? Number(latest.toBlock - 1n) : null,
      from: new Date(from).toISOString(),
      through: new Date(to).toISOString(),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
