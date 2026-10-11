/** Low-volume OI and Exchange AUSD observations, independent of event backfill. */
import pg from 'pg'
import {
  AnalyticsSnapshotRepository,
  snapshotSourceFromEnv,
  type SnapshotMetric,
  type SnapshotObservation,
} from '../infrastructure/analytics/snapshots.js'

const hour = 3_600_000
const pollMs = 60_000
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

export class AnalyticsSnapshotWorker {
  private readonly completed = new Map<SnapshotMetric, number>()

  constructor(
    private readonly source: { read: (metric: SnapshotMetric) => Promise<SnapshotObservation> },
    private readonly store: { save: (observation: SnapshotObservation) => Promise<void> },
    private readonly now: () => number = Date.now,
  ) {}

  async step(): Promise<Record<SnapshotMetric, 'saved' | 'skipped' | 'failed'>> {
    const bucket = Math.floor(this.now() / hour) * hour
    const result = { oi: 'skipped', tvl: 'skipped' } as Record<SnapshotMetric, 'saved' | 'skipped' | 'failed'>
    for (const metric of ['oi', 'tvl'] as const) {
      if (this.completed.get(metric) === bucket) continue
      try {
        const observation = await this.source.read(metric)
        if (observation.metric !== metric || this.now() - observation.observedAt.getTime() > 300_000)
          throw Error('ANALYTICS_SNAPSHOT_STALE')
        await this.store.save(observation)
        this.completed.set(metric, bucket)
        result[metric] = 'saved'
      } catch {
        // One unavailable source never fabricates a point or stops the other source.
        result[metric] = 'failed'
      }
    }
    return result
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const result = await this.step()
      if (result.oi === 'failed' || result.tvl === 'failed')
        console.error(`Analytics snapshots unavailable: oi=${result.oi}, tvl=${result.tvl}`)
      await sleep(pollMs, signal)
    }
  }
}

export function startAnalyticsSnapshots(
  env: NodeJS.ProcessEnv = process.env,
  environment: string = env.EYELER_ENV ?? '',
): { stop: () => Promise<void> } | null {
  if (env.EYELER_ANALYTICS_SNAPSHOTS_ENABLED !== 'true' || environment !== 'mainnet') return null
  if (!env.DATABASE_URL) {
    console.error('Analytics snapshots unavailable: database missing')
    return null
  }
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5_000,
    application_name: 'analytics-snapshots',
    ssl: env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
  })
  const stop = new AbortController()
  const running = new AnalyticsSnapshotWorker(snapshotSourceFromEnv(env), new AnalyticsSnapshotRepository(pool)).run(
    stop.signal,
  )
  return {
    stop: async () => {
      stop.abort()
      await running
      await pool.end()
    },
  }
}
