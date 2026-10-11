import type pg from 'pg'
import { createPublicClient, http } from 'viem'
import { monad } from 'viem/chains'
import { formatMoney } from '../../../../packages/ausd/src/money.js'
import type { Interval, TimePoint } from '../../../../packages/analytics/src/contract.js'
import { EXCHANGE } from '../../../../packages/analytics/src/decoder.js'
import { chainConfigs, erc20Abi } from '../../../../packages/chain/src/index.js'
import { PerplPublicAnalytics, publicProtocolTotals } from './perpl-public.js'

export type SnapshotMetric = 'oi' | 'tvl'
export interface SnapshotObservation {
  metric: SnapshotMetric
  micros: bigint
  observedAt: Date
  block: number | null
}
export interface SnapshotSeries {
  points: TimePoint[]
  historyStartedAt: string | null
  lastObservedAt: string | null
  block: number | null
}

const hour = 3_600_000
const day = 86_400_000
const rpcClient = (url: string) =>
  createPublicClient({ chain: monad, transport: http(url, { timeout: 8_000, retryCount: 0 }) })
type SnapshotClient = Pick<ReturnType<typeof rpcClient>, 'getChainId' | 'getBlock' | 'readContract'>

export class PublicSnapshotSource {
  constructor(
    private readonly perpl: Pick<PerplPublicAnalytics, 'context'>,
    private readonly chain: SnapshotClient,
    private readonly now: () => number = Date.now,
  ) {}

  async read(metric: SnapshotMetric): Promise<SnapshotObservation> {
    if (metric === 'oi') {
      const context = await this.perpl.context()
      const total = publicProtocolTotals(context.value.markets).openInterest
      const observedAt = new Date(context.asOf)
      if (
        context.stale ||
        total.micros === null ||
        !Number.isFinite(observedAt.getTime()) ||
        this.now() - observedAt.getTime() > 300_000
      )
        throw Error(total.reason ?? 'PERPL_OI_SNAPSHOT_UNAVAILABLE')
      return { metric, micros: total.micros, observedAt, block: context.block }
    }
    if (metric !== 'tvl') throw Error('ANALYTICS_SNAPSHOT_METRIC_INVALID')
    if ((await this.chain.getChainId()) !== 143) throw Error('MONAD_CHAIN_MISMATCH')
    const block = await this.chain.getBlock({ blockTag: 'finalized' })
    if (block.number === null || block.number <= 0n) throw Error('ANALYTICS_FINALIZED_BLOCK_MISSING')
    const [balance, decimals, symbol] = await Promise.all([
      this.chain.readContract({
        address: chainConfigs.mainnet.ausdToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [EXCHANGE],
        blockNumber: block.number,
      }),
      this.chain.readContract({
        address: chainConfigs.mainnet.ausdToken,
        abi: erc20Abi,
        functionName: 'decimals',
        blockNumber: block.number,
      }),
      this.chain.readContract({
        address: chainConfigs.mainnet.ausdToken,
        abi: erc20Abi,
        functionName: 'symbol',
        blockNumber: block.number,
      }),
    ])
    const observedAt = new Date(Number(block.timestamp) * 1_000)
    if (
      typeof balance !== 'bigint' ||
      balance < 0n ||
      decimals !== 6 ||
      symbol !== 'AUSD' ||
      block.number > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Number.isFinite(observedAt.getTime()) ||
      this.now() - observedAt.getTime() > 300_000 ||
      observedAt.getTime() > this.now() + 30_000
    )
      throw Error('ANALYTICS_TVL_SNAPSHOT_UNVERIFIED')
    return { metric, micros: balance, observedAt, block: Number(block.number) }
  }
}

export function snapshotSourceFromEnv(env: NodeJS.ProcessEnv = process.env): PublicSnapshotSource {
  return new PublicSnapshotSource(
    new PerplPublicAnalytics(env.ANALYTICS_PERPL_API_URL),
    rpcClient(env.EYELER_ANALYTICS_RPC_URL || chainConfigs.mainnet.rpcUrl),
  )
}

export class AnalyticsSnapshotRepository {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async latest(metric: SnapshotMetric): Promise<Omit<SnapshotObservation, 'metric'> | null> {
    if (metric !== 'oi' && metric !== 'tvl') throw Error('ANALYTICS_SNAPSHOT_METRIC_INVALID')
    const result = await this.pool.query(
      `SELECT value_micros::text,observed_at,block_number::text
       FROM analytics_protocol_snapshots WHERE metric=$1 ORDER BY bucket_start DESC LIMIT 1`,
      [metric],
    )
    const row = result.rows[0] as { value_micros: string; observed_at: Date; block_number: string | null } | undefined
    return row
      ? {
          micros: BigInt(row.value_micros),
          observedAt: new Date(row.observed_at),
          block: row.block_number ? Number(row.block_number) : null,
        }
      : null
  }

  async save(value: SnapshotObservation): Promise<void> {
    if (
      !['oi', 'tvl'].includes(value.metric) ||
      value.micros < 0n ||
      !Number.isFinite(value.observedAt.getTime()) ||
      (value.block !== null && (!Number.isSafeInteger(value.block) || value.block <= 0))
    )
      throw Error('ANALYTICS_SNAPSHOT_INVALID')
    const bucket = new Date(Math.floor(value.observedAt.getTime() / hour) * hour)
    await this.pool.query(
      `INSERT INTO analytics_protocol_snapshots(metric,bucket_start,value_micros,observed_at,block_number)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(metric,bucket_start) DO UPDATE SET
         value_micros=EXCLUDED.value_micros,
         observed_at=EXCLUDED.observed_at,
         block_number=EXCLUDED.block_number
       WHERE analytics_protocol_snapshots.observed_at < EXCLUDED.observed_at`,
      [value.metric, bucket, value.micros.toString(), value.observedAt, value.block],
    )
  }

  async series(metric: SnapshotMetric, interval: Interval, from: Date, to: Date): Promise<SnapshotSeries> {
    if (
      !['oi', 'tvl'].includes(metric) ||
      !['1h', '1d'].includes(interval) ||
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      from >= to
    )
      throw Error('ANALYTICS_SNAPSHOT_RANGE_INVALID')
    const rows = await this.pool.query(
      `SELECT bucket_start,value_micros::text,observed_at,block_number::text
       FROM analytics_protocol_snapshots
       WHERE metric=$1 AND bucket_start >= $2 AND bucket_start < $3 ORDER BY bucket_start`,
      [metric, from, to],
    )
    const latest = await this.pool.query(
      `SELECT observed_at,block_number::text FROM analytics_protocol_snapshots
       WHERE metric=$1 ORDER BY bucket_start DESC LIMIT 1`,
      [metric],
    )
    const earliest = await this.pool.query(
      `SELECT observed_at FROM analytics_protocol_snapshots
       WHERE metric=$1 ORDER BY bucket_start LIMIT 1`,
      [metric],
    )
    const step = interval === '1h' ? hour : day
    const byBucket = new Map<number, bigint>()
    for (const row of rows.rows as Array<{ bucket_start: Date; value_micros: string }>) {
      const at = new Date(row.bucket_start).getTime()
      byBucket.set(Math.floor(at / step) * step, BigInt(row.value_micros))
    }
    const points: TimePoint[] = []
    for (let at = Math.ceil(from.getTime() / step) * step; at < to.getTime(); at += step)
      points.push({ time: new Date(at).toISOString(), value: byBucket.has(at) ? formatMoney(byBucket.get(at)!) : null })
    const last = latest.rows[0] as { observed_at: Date; block_number: string | null } | undefined
    const first = earliest.rows[0] as { observed_at: Date } | undefined
    return {
      points,
      historyStartedAt: first ? new Date(first.observed_at).toISOString() : null,
      lastObservedAt: last ? new Date(last.observed_at).toISOString() : null,
      block: last?.block_number ? Number(last.block_number) : null,
    }
  }
}
