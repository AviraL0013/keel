/** Low-priority, read-only chain ingestion in the existing mainnet API process. */
import pg from 'pg'
import { newestGap } from '../../../packages/analytics/src/rollups.js'
import { HyperSyncRollupSource } from '../infrastructure/analytics/hypersync-rollups.js'
import { RollupRepository } from '../infrastructure/analytics/rollup-repository.js'

const pollMs = 12_000
const maxChunk = 25_000n
const dayMs = 86_400_000
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

export class AnalyticsRollupWorker {
  private windowStart: { block: bigint; refreshed: number } | null = null
  private backfillCeiling: bigint | null = null
  private lastPrune = 0
  private ownerCursor: number | null = null
  private lastOwnerScan = 0
  constructor(
    readonly source: HyperSyncRollupSource,
    readonly repo: RollupRepository,
    readonly now: () => number = Date.now,
    readonly walletLedgerEnabled = false,
  ) {}

  async step(signal?: AbortSignal): Promise<'indexed' | 'caught-up' | 'rewound'> {
    const height = await this.source.height(signal)
    const safeHead = height - 12
    if (safeHead <= 54_773_010) return 'caught-up'
    const now = this.now()
    if (!this.windowStart || now - this.windowStart.refreshed > 3_600_000) {
      // Daily readers need 30 complete UTC days; this boundary is up to one day older than rolling now-30d.
      const firstDay = Math.floor(now / dayMs) * dayMs - 30 * dayMs
      const block = await this.source.blockAtOrAfter(new Date(firstDay), safeHead, signal)
      this.windowStart = { block: BigInt(block), refreshed: now }
    }
    this.backfillCeiling ??= BigInt(safeHead) + 1n
    if (now - this.lastPrune >= 3_600_000) {
      await this.repo.prune(new Date(now - 35 * dayMs))
      this.lastPrune = now
    }
    const coverage = await this.repo.coverage()
    const newest = coverage[0]
    if (newest && newest.toBlock - 1n <= BigInt(safeHead)) {
      const observed = await this.source.block(Number(newest.toBlock - 1n), signal)
      if (observed.hash.toLowerCase() !== newest.endHash.toLowerCase()) {
        await this.repo.deleteRange(newest.fromBlock, newest.toBlock)
        return 'rewound'
      }
    }
    let indexed = false
    // Tail on every poll; initial backfill keeps descending below its fixed ceiling.
    const tail = newestGap(coverage, this.backfillCeiling, BigInt(safeHead) + 1n, maxChunk)
    if (tail) {
      const range = await this.source.readRange(
        Number(tail.fromBlock),
        Number(tail.toBlock),
        signal,
        this.walletLedgerEnabled,
      )
      await this.repo.saveRange(
        range.coverage,
        range.buckets,
        range.actors,
        this.walletLedgerEnabled ? range.walletEvents : undefined,
      )
      indexed = true
    }
    const backfill = newestGap(coverage, this.windowStart.block, this.backfillCeiling, maxChunk)
    if (backfill) {
      const range = await this.source.readRange(
        Number(backfill.fromBlock),
        Number(backfill.toBlock),
        signal,
        this.walletLedgerEnabled,
      )
      await this.repo.saveRange(
        range.coverage,
        range.buckets,
        range.actors,
        this.walletLedgerEnabled ? range.walletEvents : undefined,
      )
      indexed = true
    }
    if (now - this.lastOwnerScan >= 60_000) {
      this.ownerCursor ??= await this.repo.ownerCursor()
    }
    if (now - this.lastOwnerScan >= 60_000 && this.ownerCursor !== null && this.ownerCursor <= safeHead) {
      const end = Math.min(safeHead + 1, this.ownerCursor + 500_000)
      this.lastOwnerScan = now
      try {
        await this.repo.applyOwners(await this.source.readOwners(this.ownerCursor, end, signal), end)
        this.ownerCursor = end
      } catch (error) {
        if (!signal?.aborted)
          console.error(`Analytics rollup owners: ${error instanceof Error ? error.message : 'UNKNOWN'}`)
      }
    }
    // Expand old aggregate-only ranges newest first. Range hash check prevents
    // attaching wallet events to a different canonical history after a reorg.
    const missingWallet = this.walletLedgerEnabled ? await this.repo.nextWalletBackfillRange() : null
    if (missingWallet) {
      const range = await this.source.readRange(
        Number(missingWallet.fromBlock),
        Number(missingWallet.toBlock),
        signal,
        true,
      )
      if (range.coverage.endHash.toLowerCase() !== missingWallet.endHash.toLowerCase())
        throw new Error('WALLET_LEDGER_RANGE_CHANGED')
      await this.repo.saveWalletRange(range.coverage, range.walletEvents)
      indexed = true
    }
    return indexed ? 'indexed' : 'caught-up'
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      try {
        const started = Date.now()
        await this.step(signal)
        failures = 0
        await sleep(Math.max(1_000, pollMs - (Date.now() - started)), signal)
      } catch (error) {
        if (signal.aborted) return
        console.error(`Analytics rollups: ${error instanceof Error ? error.message : 'UNKNOWN'}`)
        failures++
        await sleep(Math.min(60_000, pollMs * 2 ** Math.min(failures, 3)), signal)
      }
    }
  }
}

export function startAnalyticsRollups(
  env: NodeJS.ProcessEnv = process.env,
  environment: string = env.EYELER_ENV ?? '',
): { stop: () => Promise<void> } | null {
  if (env.EYELER_ANALYTICS_ROLLUPS_ENABLED !== 'true' || environment !== 'mainnet') return null
  if (!env.DATABASE_URL || !env.EYELER_HYPERSYNC_TOKEN) {
    console.error('Analytics rollups: ANALYTICS_ROLLUPS_CONFIG_REQUIRED')
    return null
  }
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5_000,
    application_name: 'analytics-rollups',
    ssl: env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
  })
  const stop = new AbortController()
  const running = (async () => {
    while (!stop.signal.aborted) {
      try {
        const lock = await pool.connect()
        let owned = false
        try {
          const result = await lock.query('SELECT pg_try_advisory_lock(143,20261011) AS owned')
          owned = result.rows[0]?.owned === true
          if (owned) {
            await new AnalyticsRollupWorker(
              new HyperSyncRollupSource(env.EYELER_HYPERSYNC_TOKEN!),
              new RollupRepository(pool),
              Date.now,
              env.EYELER_ANALYTICS_WALLET_LEDGER_ENABLED === 'true',
            ).run(stop.signal)
          }
        } finally {
          if (owned) await lock.query('SELECT pg_advisory_unlock(143,20261011)')
          lock.release()
        }
      } catch (error) {
        if (!stop.signal.aborted)
          console.error(`Analytics rollups startup: ${error instanceof Error ? error.message : 'UNKNOWN'}`)
      }
      await sleep(pollMs, stop.signal)
    }
  })()
  return {
    stop: async () => {
      stop.abort()
      await running
      await pool.end()
    },
  }
}
