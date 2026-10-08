import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { getAddress, isAddress } from 'viem'
import { formatMoney, moneyMicros } from '../../../../../packages/ausd/src/money.js'
import { notionalMicros, signedMoney, sumMicros } from '../../../../../packages/analytics/src/aggregate.js'
import { EXCHANGE_DEPLOYMENT_BLOCK } from '../../../../../packages/analytics/src/decoder.js'
import {
  calculateWalletPerformance,
  type PositionEpisodeEvent,
} from '../../../../../packages/analytics/src/performance.js'
import type {
  Envelope,
  MarketSummary,
  Metric,
  ProtocolSummary,
  Window,
  WindowValue,
  WalletPerformance,
} from '../../../../../packages/analytics/src/contract.js'
import {
  PerplPublicAnalytics,
  marketDetail,
  marketSummary,
  scaledText,
  type PublicMarket,
} from '../../../infrastructure/analytics/perpl-public.js'
import { WalletChainAnalytics } from '../../../infrastructure/analytics/wallet-chain.js'

const windows = new Set(['24h', '7d', '30d', 'all'])
const metrics = new Set(['volume', 'oi', 'tvl', 'fees', 'active_users', 'net_flows'])
const intervals = new Set(['1h', '1d'])
const duration: Record<Exclude<Window, 'all'>, number> = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 }
const fail = (code: string, statusCode = 400) => Object.assign(new Error(code), { statusCode })
function numberParam(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw fail('INVALID_NUMBER')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('INVALID_NUMBER')
  return value
}
function timeParam(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(raw)) throw fail('INVALID_TIME')
  const value = Date.parse(raw)
  if (!Number.isFinite(value) || new Date(value).toISOString() !== raw) throw fail('INVALID_TIME')
  return value
}
function windowParam(raw: unknown): Window {
  const value = raw ?? '24h'
  if (typeof value !== 'string' || !windows.has(value)) throw fail('INVALID_WINDOW')
  return value as Window
}
function addressParam(raw: unknown): string {
  if (typeof raw !== 'string' || !isAddress(raw, { strict: true })) throw fail('INVALID_ADDRESS')
  return getAddress(raw)
}
function change(current: bigint | null, previous: bigint | null, count = false): WindowValue {
  const value = (input: bigint | null) => (input === null ? null : count ? input.toString() : signedMoney(input))
  const pct =
    current === null || previous === null || previous === 0n
      ? null
      : scaledText(((current - previous) * 10000n) / (previous < 0n ? -previous : previous), 2)
  return { value: value(current), previous: value(previous), changePct: pct }
}
type DbMeta = {
  asOf: string
  block: number | null
  stale: boolean
  completeFrom: Date | null
  through: Date | null
  completeHistory: boolean
  revision: string
}
async function dbMeta(pool: pg.Pool | null, publicBlock: number | null): Promise<DbMeta> {
  if (!pool)
    return {
      asOf: new Date().toISOString(),
      block: null,
      stale: true,
      completeFrom: null,
      through: null,
      completeHistory: false,
      revision: 'unindexed',
    }
  const result = await pool.query(`SELECT c.next_block::text,c.start_block::text,c.history_verified,c.updated_at,
    c.updated_at::text AS checkpoint_revision,last_block.block_hash AS block_hash,
    first_block.occurred_at AS first_time,last_block.occurred_at AS last_time,
    first_block.block_number::text AS first_block
    FROM analytics_checkpoint c
    LEFT JOIN LATERAL (SELECT block_number,occurred_at FROM analytics_blocks ORDER BY block_number LIMIT 1) first_block ON true
    LEFT JOIN analytics_blocks last_block ON last_block.block_number=c.next_block-1
    WHERE c.chain_id=143`)
  const row = result.rows[0] as
    | {
        next_block: string
        start_block: string
        history_verified: boolean
        updated_at: Date
        first_time: Date | null
        last_time: Date | null
        first_block: string | null
        checkpoint_revision: string
        block_hash: string | null
      }
    | undefined
  if (!row)
    return {
      asOf: new Date().toISOString(),
      block: null,
      stale: true,
      completeFrom: null,
      through: null,
      completeHistory: false,
      revision: 'unindexed',
    }
  const block = Number(BigInt(row.next_block) - 1n)
  const stale =
    !row.last_time ||
    Date.now() - row.last_time.getTime() > 30_000 ||
    Date.now() - row.updated_at.getTime() > 30_000 ||
    (publicBlock !== null && publicBlock - block > 100)
  const completeHistory =
    !stale &&
    row.history_verified &&
    row.start_block === EXCHANGE_DEPLOYMENT_BLOCK.toString() &&
    row.first_block === row.start_block
  return {
    asOf: row.updated_at.toISOString(),
    block,
    stale,
    completeFrom: row.first_time,
    through: row.last_time,
    revision: JSON.stringify([
      row.start_block,
      row.next_block,
      row.history_verified,
      row.checkpoint_revision,
      row.block_hash,
      row.first_block,
      row.first_time?.toISOString(),
      row.last_time?.toISOString(),
      stale,
      completeHistory,
    ]),
    completeHistory,
  }
}
async function assertHistoryUnchanged(pool: pg.Pool | null, publicBlock: number | null, meta: DbMeta): Promise<void> {
  // A rewind can commit between metadata, ownership checks and settlement reads.
  // Never return a value calculated from mixed revisions. Cached results stay
  // under their original revision and cannot become complete after a replay.
  if ((await dbMeta(pool, publicBlock)).revision !== meta.revision) throw fail('ANALYTICS_HISTORY_CHANGED', 503)
}
const coverage = (meta: DbMeta): NonNullable<Envelope<unknown>['coverage']> => ({
  from: meta.completeFrom?.toISOString() ?? null,
  through: meta.through?.toISOString() ?? null,
  completeHistory: meta.completeHistory,
  label: meta.completeHistory
    ? 'All time'
    : meta.completeFrom
      ? `Since ${meta.completeFrom.toISOString().slice(0, 10)}`
      : 'No indexed history',
})
const covered = (meta: DbMeta, from: number) =>
  !meta.stale && !!meta.completeFrom && meta.completeFrom.getTime() <= from
const wrap = <T>(
  data: T,
  source: Envelope<T>['source'],
  asOf: string,
  block: number | null,
  stale: boolean,
  indexedCoverage?: Envelope<T>['coverage'],
): Envelope<T> => ({ asOf, block, source, stale, ...(indexedCoverage ? { coverage: indexedCoverage } : {}), data })
class ResponseCache {
  private values = new Map<string, { expires: number; value: Promise<unknown> }>()
  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const found = this.values.get(key)
    if (found && found.expires > Date.now()) return found.value as Promise<T>
    const value = load().catch((error) => {
      this.values.delete(key)
      throw error
    })
    this.values.set(key, { expires: Date.now() + ttlMs, value })
    if (this.values.size > 500) this.values.delete(this.values.keys().next().value!)
    return value
  }
}
export interface AnalyticsRouteDependencies {
  publicData?: PerplPublicAnalytics
  wallet?: WalletChainAnalytics
}

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  pool: pg.Pool | null,
  dependencies: AnalyticsRouteDependencies = {},
): void {
  const publicData = dependencies.publicData ?? new PerplPublicAnalytics(process.env.ANALYTICS_PERPL_API_URL)
  const wallet =
    dependencies.wallet ??
    (process.env.EYELER_ANALYTICS_RPC_URL ? new WalletChainAnalytics(process.env.EYELER_ANALYTICS_RPC_URL) : null)
  const walletProfile = (address: string, context: Parameters<WalletChainAnalytics['profile']>[1]) => {
    if (!wallet) throw fail('EYELER_ANALYTICS_RPC_URL_REQUIRED', 503)
    return wallet.profile(address, context)
  }
  const cache = new ResponseCache()
  const db = () => {
    if (!pool) throw fail('ANALYTICS_DATABASE_UNAVAILABLE', 503)
    return pool
  }
  const routeConfig = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }
  void app.register(
    async (routes) => {
      routes.setErrorHandler((error, _request, reply) => {
        const typed = error as Error & { statusCode?: number }
        const unavailable = /HTTP_(401|403|429|5\d\d)|RPC_|PERPL_/.test(typed.message)
        const code =
          typed.statusCode || /^[A-Z][A-Z0-9_]+$/.test(typed.message) ? typed.message : 'ANALYTICS_UPSTREAM_UNAVAILABLE'
        return reply
          .header('Cache-Control', 'no-store')
          .code(typed.statusCode ?? (unavailable ? 503 : 500))
          .send({ error: code, message: code })
      })

      routes.get<{ Querystring: { window?: string } }>('/protocol/summary', routeConfig, async (request, reply) => {
        const window = windowParam(request.query.window)
        reply.header('Cache-Control', 'public, max-age=15')
        return cache.get(`summary:${window}`, 15_000, async () => {
          const ctx = await publicData.context()
          const oi = sumMicros(
            ctx.value.markets.map((market) => moneyMicros(marketSummary(market).openInterest ?? '0')),
          )
          const tvl = sumMicros(ctx.value.markets.map((market) => BigInt(market.state.tvl)))
          const volume24h = sumMicros(ctx.value.markets.map((market) => BigInt(market.state.dva)))
          const meta = await dbMeta(pool, ctx.block)
          const now = Date.now()
          const from = window === 'all' ? (meta.completeFrom?.getTime() ?? now) : now - duration[window]
          const prevFrom = window === 'all' ? null : from - duration[window]
          const full = covered(meta, from)
          const prevFull = prevFrom !== null && covered(meta, prevFrom)
          const current = pool && full ? await summarySlice(pool, from, now) : null
          const previous = pool && prevFull && prevFrom !== null ? await summarySlice(pool, prevFrom, from) : null
          const net = current ? current.deposits - current.withdrawals : null
          const prevNet = previous ? previous.deposits - previous.withdrawals : null
          const data: ProtocolSummary = {
            window,
            volume: change(current?.volume ?? (window === '24h' ? volume24h : null), previous?.volume ?? null),
            fees: change(current?.fees ?? null, previous?.fees ?? null),
            revenue: change(current?.revenue ?? null, previous?.revenue ?? null),
            activeUsers: change(current?.users ?? null, previous?.users ?? null, true),
            liquidations: change(current?.liquidations ?? null, previous?.liquidations ?? null, true),
            openInterest: change(oi, null),
            tvl: change(tvl, null),
            netFlows: change(net, prevNet),
          }
          return wrap(
            data,
            full ? 'derived' : 'perpl_api',
            ctx.asOf,
            ctx.block,
            ctx.stale || !full || (window !== 'all' && !prevFull),
            coverage(meta),
          )
        })
      })

      routes.get<{ Querystring: { metric?: string; interval?: string; from?: string; to?: string } }>(
        '/protocol/timeseries',
        routeConfig,
        async (request, reply) => {
          const { metric, interval } = request.query
          if (!metric || !metrics.has(metric)) throw fail('INVALID_METRIC')
          if (!interval || !intervals.has(interval)) throw fail('INVALID_INTERVAL')
          const to = timeParam(request.query.to, Date.now())
          const from = timeParam(request.query.from, to - 86_400_000)
          const step = interval === '1h' ? 3_600_000 : 86_400_000
          if (
            from >= to ||
            to > Date.now() + 60_000 ||
            to - from > step * 2160 ||
            to - from > (interval === '1h' ? 90 : 730) * 86_400_000
          )
            throw fail('INVALID_RANGE')
          reply.header('Cache-Control', 'public, max-age=60')
          return cache.get(`series:${metric}:${interval}:${from}:${to}`, 60_000, async () => {
            const ctx = await publicData.context()
            const points = new Map<number, bigint>()
            const meta = await dbMeta(pool, ctx.block)
            if (metric === 'volume') {
              const candles = await Promise.all(
                ctx.value.markets.map((market) => publicData.volumeCandles(market, interval as '1h' | '1d', from, to)),
              )
              for (const series of candles)
                for (const point of series) points.set(point.time, (points.get(point.time) ?? 0n) + point.micros)
            } else if (pool && covered(meta, from) && ['fees', 'active_users', 'net_flows'].includes(metric)) {
              for (const row of await metricBuckets(pool, metric as Metric, interval as '1h' | '1d', from, to))
                points.set(row.time, row.value)
            }
            const data = {
              metric: metric as Metric,
              interval: interval as '1h' | '1d',
              from: new Date(from).toISOString(),
              to: new Date(to).toISOString(),
              points: [] as Array<{ time: string; value: string | null }>,
            }
            for (let time = Math.ceil(from / step) * step; time < to; time += step)
              data.points.push({
                time: new Date(time).toISOString(),
                value: points.has(time)
                  ? metric === 'active_users'
                    ? points.get(time)!.toString()
                    : signedMoney(points.get(time)!)
                  : null,
              })
            return wrap(
              data,
              metric === 'volume' ? 'perpl_api' : 'derived',
              ctx.asOf,
              ctx.block,
              ctx.stale ||
                (metric !== 'volume' && !covered(meta, from)) ||
                data.points.some((point) => point.value === null),
              metric === 'volume' ? undefined : coverage(meta),
            )
          })
        },
      )

      routes.get<{ Querystring: { window?: string } }>('/protocol/flows', routeConfig, async (request, reply) => {
        const window = windowParam(request.query.window)
        reply.header('Cache-Control', 'public, max-age=15')
        return cache.get(`flows:${window}`, 15_000, async () => {
          const ctx = await publicData.context()
          const meta = await dbMeta(pool, ctx.block)
          const now = Date.now()
          const from = window === 'all' ? (meta.completeFrom?.getTime() ?? now) : now - duration[window]
          if (!pool || !covered(meta, from))
            return wrap(
              { window, deposits: null, withdrawals: null, net: null, buckets: [] },
              'derived',
              meta.asOf,
              meta.block,
              true,
              coverage(meta),
            )
          const rows = await pool.query(
            `SELECT date_trunc('hour',occurred_at) AS time,
          coalesce(sum(amount_micros) FILTER (WHERE direction='deposit'),0) AS deposits,
          coalesce(sum(amount_micros) FILTER (WHERE direction='withdrawal'),0) AS withdrawals
          FROM analytics_flows WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1 ORDER BY 1`,
            [new Date(from), new Date(now)],
          )
          const buckets = rows.rows.map((row: { time: Date; deposits: string; withdrawals: string }) => ({
            time: row.time.toISOString(),
            deposits: formatMoney(BigInt(row.deposits)),
            withdrawals: formatMoney(BigInt(row.withdrawals)),
            net: signedMoney(BigInt(row.deposits) - BigInt(row.withdrawals)),
          }))
          const deposits = sumMicros(rows.rows.map((row: { deposits: string }) => BigInt(row.deposits)))
          const withdrawals = sumMicros(rows.rows.map((row: { withdrawals: string }) => BigInt(row.withdrawals)))
          return wrap(
            {
              window,
              deposits: formatMoney(deposits),
              withdrawals: formatMoney(withdrawals),
              net: signedMoney(deposits - withdrawals),
              buckets,
            },
            'derived',
            meta.asOf,
            meta.block,
            meta.stale,
            coverage(meta),
          )
        })
      })

      routes.get('/markets', routeConfig, async (_request, reply) => {
        reply.header('Cache-Control', 'public, max-age=15')
        const ctx = await publicData.context()
        const meta = await dbMeta(pool, ctx.block)
        const result = await cache.get(`markets:${meta.revision}`, 15_000, async () => {
          const skew =
            pool && meta.completeHistory
              ? await marketSkew(pool, meta.block!, ctx.value.markets)
              : new Map<number, { long: bigint; short: bigint }>()
          return wrap(
            {
              items: ctx.value.markets.map((market) =>
                withSkew(marketSummary(market), market, skew, meta.completeHistory),
              ),
            },
            meta.completeHistory ? 'derived' : 'perpl_api',
            ctx.asOf,
            ctx.block,
            ctx.stale || !meta.completeHistory,
          )
        })
        await assertHistoryUnchanged(pool, ctx.block, meta)
        return result
      })
      routes.get<{ Params: { id: string } }>('/markets/:id', routeConfig, async (request, reply) => {
        const id = numberParam(request.params.id, 0, 1, 2_147_483_647)
        const ctx = await publicData.context()
        const market = ctx.value.markets.find((item) => item.id === id)
        if (!market) throw fail('MARKET_NOT_FOUND', 404)
        const meta = await dbMeta(pool, ctx.block)
        const skew =
          pool && meta.completeHistory
            ? await marketSkew(pool, meta.block!, ctx.value.markets)
            : new Map<number, { long: bigint; short: bigint }>()
        await assertHistoryUnchanged(pool, ctx.block, meta)
        reply.header('Cache-Control', 'public, max-age=15')
        return wrap(
          { ...marketDetail(market), ...withSkew(marketSummary(market), market, skew, meta.completeHistory) },
          meta.completeHistory ? 'derived' : 'perpl_api',
          ctx.asOf,
          ctx.block,
          ctx.stale || !meta.completeHistory,
        )
      })
      routes.get<{ Params: { id: string }; Querystring: { interval?: string; from?: string; to?: string } }>(
        '/markets/:id/prices',
        routeConfig,
        async (request, reply) => {
          const id = numberParam(request.params.id, 0, 1, 2_147_483_647)
          const interval = request.query.interval ?? '1h'
          if (!intervals.has(interval)) throw fail('INVALID_INTERVAL')
          const to = timeParam(request.query.to, Date.now())
          const from = timeParam(request.query.from, to - 86_400_000)
          const step = interval === '1h' ? 3_600_000 : 86_400_000
          if (
            from < 0 ||
            from >= to ||
            to > Date.now() ||
            to - from > step * 2160 ||
            to - from > (interval === '1h' ? 90 : 730) * 86_400_000
          )
            throw fail('INVALID_RANGE')
          const ctx = await publicData.context()
          const market = ctx.value.markets.find((item) => item.id === id)
          if (!market) throw fail('MARKET_NOT_FOUND', 404)
          reply.header('Cache-Control', 'public, max-age=60')
          return cache.get(`prices:${id}:${interval}:${from}:${to}`, 60_000, () =>
            publicData.prices(market, interval as '1h' | '1d', from, to),
          )
        },
      )
      routes.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
        '/markets/:id/funding',
        routeConfig,
        async (request, reply) => {
          const id = numberParam(request.params.id, 0, 1, 2_147_483_647)
          const ctx = await publicData.context()
          const market = ctx.value.markets.find((item) => item.id === id)
          if (!market) throw fail('MARKET_NOT_FOUND', 404)
          const to = timeParam(request.query.to, Date.now())
          const from = timeParam(request.query.from, to - 86_400_000)
          if (
            from >= to ||
            to > Date.now() + market.funding_interval_sec * 1000 ||
            to - from > market.funding_interval_sec * 1_024_000
          )
            throw fail('INVALID_RANGE')
          reply.header('Cache-Control', 'public, max-age=60')
          return cache.get(`funding:${id}:${from}:${to}`, 60_000, async () =>
            wrap(await publicData.funding(market, from, to), 'perpl_api', ctx.asOf, ctx.block, ctx.stale),
          )
        },
      )

      routes.get<{ Querystring: { marketId?: string; from?: string; to?: string; limit?: string; cursor?: string } }>(
        '/liquidations',
        routeConfig,
        async (request, reply) => {
          const marketId =
            request.query.marketId === undefined ? null : numberParam(request.query.marketId, 0, 1, 2_147_483_647)
          const to = timeParam(request.query.to, Date.now())
          const from = timeParam(request.query.from, to - 86_400_000)
          if (from >= to || to > Date.now() + 60_000 || to - from > 90 * 86_400_000) throw fail('INVALID_RANGE')
          const limit = numberParam(request.query.limit, 50, 1, 100)
          const cursor = parseCursor(request.query.cursor)
          const ctx = await publicData.context()
          const precision = new Map(
            [...publicData.precision(ctx.value).values()].map((market) => [market.marketId, market]),
          )
          const meta = await dbMeta(pool, ctx.block)
          const params: unknown[] = [new Date(from), new Date(to), marketId]
          const keyset = cursor ? `AND (l.block_number,r.transaction_index,l.log_index) < ($4,$5,$6)` : ''
          if (cursor) params.push(...cursor)
          params.push(limit + 1)
          const rows = await db().query(
            `SELECT l.*,a.address,r.transaction_index FROM analytics_liquidations l
          JOIN analytics_raw_events r USING(block_number,transaction_hash,log_index)
          LEFT JOIN analytics_accounts a ON a.account_id=l.account_id
          WHERE l.occurred_at >= $1 AND l.occurred_at < $2 AND ($3::integer IS NULL OR l.market_id=$3)
          ${keyset} ORDER BY l.block_number DESC,r.transaction_index DESC,l.log_index DESC LIMIT $${params.length}`,
            params,
          )
          const summary = await db().query(
            `SELECT count(*) AS count,coalesce(sum(notional_micros),0) AS notional
          FROM analytics_liquidations WHERE occurred_at >= $1 AND occurred_at < $2
          AND ($3::integer IS NULL OR market_id=$3)`,
            [new Date(from), new Date(to), marketId],
          )
          const page = rows.rows.slice(0, limit)
          const items = page.map((row: Record<string, unknown>) => {
            const market = precision.get(Number(row.market_id))
            if (!market) throw fail('MARKET_PRECISION_UNAVAILABLE', 503)
            return {
              id: `${row.block_number}:${row.transaction_hash}:${row.log_index}`,
              time: new Date(String(row.occurred_at)).toISOString(),
              marketId: Number(row.market_id),
              address: row.address ? getAddress(String(row.address)) : null,
              side: row.side as 'long' | 'short',
              notional: formatMoney(BigInt(String(row.notional_micros))),
              realizedPnl: signedMoney(BigInt(String(row.realized_pnl_micros))),
              transactionHash: String(row.transaction_hash),
            }
          })
          const last = page.at(-1)
          reply.header('Cache-Control', 'public, max-age=15')
          return wrap(
            {
              items,
              nextCursor: rows.rows.length > limit && last ? cursorFor(last) : null,
              summary: {
                count: Number(summary.rows[0].count),
                notional: covered(meta, from) ? formatMoney(BigInt(summary.rows[0].notional)) : null,
              },
            },
            'monad_exchange',
            meta.asOf,
            meta.block,
            !covered(meta, from),
            coverage(meta),
          )
        },
      )

      routes.get<{ Querystring: { q?: string } }>('/search', routeConfig, async (request, reply) => {
        const q = request.query.q
        if (!q || !/^0x[0-9a-fA-F]{6,40}$/.test(q)) throw fail('INVALID_SEARCH')
        if (q.length === 42) {
          const address = addressParam(q)
          const ctx = await publicData.context()
          const result = await walletProfile(address, ctx.value)
          reply.header('Cache-Control', 'public, max-age=15')
          return wrap(
            { items: result ? [{ address, accountId: result.data.accountIds[0] ?? null }] : [] },
            'monad_exchange',
            result?.asOf ?? ctx.asOf,
            result?.block ?? ctx.block,
            result?.stale ?? ctx.stale,
          )
        }
        const rows = await db().query(
          `SELECT address,min(account_id)::text AS account_id FROM analytics_accounts
        WHERE address LIKE $1 GROUP BY address ORDER BY address LIMIT 20`,
          [`${q.toLowerCase()}%`],
        )
        const meta = await dbMeta(pool, null)
        reply.header('Cache-Control', 'public, max-age=15')
        return wrap(
          {
            items: rows.rows.map((row: { address: string; account_id: string }) => ({
              address: getAddress(row.address),
              accountId: row.account_id,
            })),
          },
          'monad_exchange',
          meta.asOf,
          meta.block,
          meta.stale,
          coverage(meta),
        )
      })

      routes.get<{ Querystring: { addresses?: string } }>('/wallets/compare', routeConfig, async (request, reply) => {
        const raw = request.query.addresses?.split(',') ?? []
        if (raw.length < 1 || raw.length > 4) throw fail('INVALID_ADDRESSES')
        const addresses = raw.map(addressParam)
        if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length)
          throw fail('DUPLICATE_ADDRESS')
        const ctx = await publicData.context()
        const meta = await dbMeta(pool, ctx.block)
        const wallets = await Promise.all(
          addresses.map((address) =>
            cache.get(`performance:${address}:${meta.revision}`, 15_000, () =>
              performance(db(), address, meta.completeHistory, meta.block),
            ),
          ),
        )
        await assertHistoryUnchanged(pool, ctx.block, meta)
        reply.header('Cache-Control', 'public, max-age=15')
        return wrap({ wallets }, 'derived', meta.asOf, meta.block, true, coverage(meta))
      })

      routes.get<{ Params: { address: string } }>('/wallets/:address', routeConfig, async (request, reply) => {
        const address = addressParam(request.params.address)
        const ctx = await publicData.context()
        const result = await walletProfile(address, ctx.value)
        if (!result) throw fail('WALLET_NOT_FOUND', 404)
        reply.header('Cache-Control', 'public, max-age=15')
        return result
      })

      routes.get<{ Params: { address: string }; Querystring: { limit?: string; cursor?: string } }>(
        '/wallets/:address/trades',
        routeConfig,
        async (request, reply) => {
          const address = addressParam(request.params.address)
          const limit = numberParam(request.query.limit, 50, 1, 100)
          const cursor = parseCursor(request.query.cursor)
          const ctx = await publicData.context()
          const precision = new Map(
            [...publicData.precision(ctx.value).values()].map((market) => [market.marketId, market]),
          )
          const params: unknown[] = [address.toLowerCase()]
          const keyset = cursor ? `AND (f.block_number,r.transaction_index,f.log_index) < ($2,$3,$4)` : ''
          if (cursor) params.push(...cursor)
          params.push(limit + 1)
          const rows = await db().query(
            `SELECT f.*,r.transaction_index,p.side,p.action,
            CASE WHEN cf.fill_count=1 THEN p.realized_pnl_micros ELSE NULL END AS realized_pnl_micros
            FROM analytics_fills f
          JOIN analytics_raw_events r USING(block_number,transaction_hash,log_index)
          JOIN analytics_accounts a ON a.account_id=f.account_id
          JOIN LATERAL (SELECT count(*) AS fill_count FROM analytics_fills same
            WHERE same.transaction_hash=f.transaction_hash AND same.account_id=f.account_id AND same.market_id=f.market_id) cf ON true
          JOIN LATERAL (SELECT min(side) AS side,min(action) AS action,
            CASE WHEN count(*)=1 THEN min(realized_pnl_micros) ELSE NULL END AS realized_pnl_micros,
            count(*) AS event_count FROM analytics_position_events e
            WHERE e.transaction_hash=f.transaction_hash AND e.account_id=f.account_id AND e.market_id=f.market_id
              AND e.action IN ('open','increase','reduce','close','liquidation')) p ON p.event_count=1
          WHERE a.address=$1 ${keyset}
          ORDER BY f.block_number DESC,r.transaction_index DESC,f.log_index DESC LIMIT $${params.length}`,
            params,
          )
          const page = rows.rows.slice(0, limit)
          const items = page.map((row: Record<string, unknown>) => {
            const market = precision.get(Number(row.market_id))
            if (!market) throw fail('MARKET_PRECISION_UNAVAILABLE', 503)
            return {
              id: `${row.block_number}:${row.transaction_hash}:${row.log_index}`,
              time: new Date(String(row.occurred_at)).toISOString(),
              marketId: Number(row.market_id),
              side: row.side as 'long' | 'short',
              action: row.action as 'open' | 'increase' | 'reduce' | 'close',
              size: scaledText(BigInt(String(row.size_raw)), market.sizeDecimals),
              price: scaledText(BigInt(String(row.price_raw)), market.priceDecimals),
              notional: formatMoney(BigInt(String(row.notional_micros))),
              fee: formatMoney(BigInt(String(row.fee_micros))),
              realizedPnl:
                row.realized_pnl_micros === null ? null : signedMoney(BigInt(String(row.realized_pnl_micros))),
              transactionHash: String(row.transaction_hash),
            }
          })
          const meta = await dbMeta(pool, ctx.block)
          reply.header('Cache-Control', 'public, max-age=15')
          return wrap(
            { items, nextCursor: rows.rows.length > limit ? cursorFor(page.at(-1)!) : null },
            'monad_exchange',
            meta.asOf,
            meta.block,
            true,
            coverage(meta),
          )
        },
      )

      routes.get<{ Params: { address: string } }>(
        '/wallets/:address/performance',
        routeConfig,
        async (request, reply) => {
          const address = addressParam(request.params.address)
          const ctx = await publicData.context()
          const meta = await dbMeta(pool, ctx.block)
          const result = await cache.get(`performance:${address}:${meta.revision}`, 15_000, () =>
            performance(db(), address, meta.completeHistory, meta.block),
          )
          await assertHistoryUnchanged(pool, ctx.block, meta)
          reply.header('Cache-Control', 'public, max-age=15')
          return wrap(result, 'derived', meta.asOf, meta.block, true, coverage(meta))
        },
      )
    },
    { prefix: '/analytics/v1' },
  )
}

function parseCursor(raw: unknown): [string, number, number] | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string' || raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw fail('INVALID_CURSOR')
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      !/^\d+$/.test(String(value[0])) ||
      !Number.isSafeInteger(value[1]) ||
      value[1] < 0 ||
      !Number.isSafeInteger(value[2]) ||
      value[2] < 0
    )
      throw new Error('INVALID')
    return [String(value[0]), value[1], value[2]]
  } catch {
    throw fail('INVALID_CURSOR')
  }
}
function cursorFor(row: Record<string, unknown>): string {
  return Buffer.from(
    JSON.stringify([String(row.block_number), Number(row.transaction_index), Number(row.log_index)]),
  ).toString('base64url')
}

const unsupportedSettlements = ['PositionDeleveraged', 'PositionDeleveragedV2', 'PositionUnwound', 'PositionUnwoundV2']

async function marketSkew(
  pool: pg.Pool,
  throughBlock: number,
  markets: PublicMarket[],
): Promise<Map<number, { long: bigint; short: bigint } | null>> {
  const result = await pool.query(
    `SELECT market_id,side,sum(size_raw) AS size_raw FROM (
    SELECT DISTINCT ON (e.account_id,e.market_id) e.market_id,e.side,e.size_raw
    FROM analytics_position_events e JOIN analytics_raw_events r USING(block_number,transaction_hash,log_index)
    WHERE e.block_number <= $1
    ORDER BY e.account_id,e.market_id,e.block_number DESC,r.transaction_index DESC,e.log_index DESC
  ) latest WHERE size_raw > 0 GROUP BY market_id,side`,
    [throughBlock],
  )
  const skew = new Map<number, { long: bigint; short: bigint } | null>()
  for (const row of result.rows as Array<{ market_id: number; side: 'long' | 'short'; size_raw: string }>) {
    const value = skew.get(row.market_id) ?? { long: 0n, short: 0n }
    value[row.side] = BigInt(row.size_raw)
    skew.set(row.market_id, value)
  }
  const unsupported = await pool.query(
    `SELECT DISTINCT args->>'perpId' AS market_id FROM analytics_raw_events
    WHERE event_name=ANY($1::text[]) AND block_number <= $2`,
    [unsupportedSettlements, throughBlock],
  )
  for (const row of unsupported.rows as Array<{ market_id: string | null }>) {
    const perpetualId = Number(row.market_id)
    const matches = markets.filter((market) => market.perpetual_id === perpetualId)
    if (
      !row.market_id ||
      !/^\d+$/.test(row.market_id) ||
      !Number.isSafeInteger(perpetualId) ||
      perpetualId <= 0 ||
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].id) ||
      matches[0].id <= 0
    )
      throw fail('ANALYTICS_SETTLEMENT_CONTEXT_UNAVAILABLE', 503)
    skew.set(matches[0].id, null)
  }
  return skew
}
function withSkew(
  summary: MarketSummary,
  market: PublicMarket,
  skew: Map<number, { long: bigint; short: bigint } | null>,
  available: boolean,
): MarketSummary {
  if (!available || skew.get(market.id) === null) return summary
  const { long, short } = skew.get(market.id) ?? { long: 0n, short: 0n }
  const mark = BigInt(market.state.mrk)
  const money = (size: bigint) =>
    formatMoney(notionalMicros(mark, size, market.config.price_decimals, market.config.size_decimals))
  return {
    ...summary,
    longOpenInterest: money(long),
    shortOpenInterest: money(short),
    longSharePct: long + short === 0n ? null : scaledText((long * 10000n + (long + short) / 2n) / (long + short), 2),
  }
}

async function performance(
  pool: pg.Pool,
  address: string,
  completeHistory: boolean,
  throughBlock: number | null,
): Promise<WalletPerformance> {
  let complete = completeHistory && throughBlock !== null
  if (complete) {
    // An unmapped account could belong to this wallet. Do not let an inner join
    // silently remove its settlements and publish a partial or zero PnL.
    // Raw-history coverage is separate from support for every settlement type.
    const missing = await pool.query(
      `SELECT EXISTS(
        SELECT 1 FROM (
          SELECT account_id,block_number FROM analytics_position_events
          UNION ALL SELECT account_id,block_number FROM analytics_fills
        ) e LEFT JOIN analytics_accounts a ON a.account_id=e.account_id
        WHERE e.block_number <= $1 AND a.account_id IS NULL
      ) OR EXISTS(
        SELECT 1 FROM analytics_raw_events r LEFT JOIN analytics_accounts a ON a.account_id::text=r.args->>'accountId'
        WHERE r.block_number <= $1 AND r.event_name=ANY($2::text[])
          AND (a.account_id IS NULL OR a.address=$3)
      ) AS incomplete`,
      [throughBlock, unsupportedSettlements, address.toLowerCase()],
    )
    complete = missing.rows[0]?.incomplete === false
  }
  if (complete) {
    const rows = await pool.query(
      `SELECT e.account_id,e.market_id,e.action,e.realized_pnl_micros,e.occurred_at
      FROM analytics_position_events e JOIN analytics_accounts a ON a.account_id=e.account_id
      JOIN analytics_raw_events r USING(block_number,transaction_hash,log_index)
      WHERE a.address=$1 AND e.block_number <= $2 ORDER BY e.block_number,r.transaction_index,e.log_index`,
      [address.toLowerCase(), throughBlock],
    )
    const events: PositionEpisodeEvent[] = rows.rows.map((row: Record<string, unknown>) => ({
      accountId: String(row.account_id),
      marketId: Number(row.market_id),
      action: row.action as PositionEpisodeEvent['action'],
      realizedPnlMicros: row.realized_pnl_micros === null ? null : BigInt(String(row.realized_pnl_micros)),
      at: new Date(String(row.occurred_at)).getTime(),
    }))
    try {
      return calculateWalletPerformance(address, events)
    } catch {
      /* Unknown old event: expose partial totals only. */
    }
  }
  const result = await pool.query(
    `SELECT coalesce(sum(e.realized_pnl_micros),0) AS realized,
    count(*) FILTER (WHERE e.action IN ('close','liquidation')) AS closed
    FROM analytics_position_events e JOIN analytics_accounts a ON a.account_id=e.account_id
    WHERE a.address=$1`,
    [address.toLowerCase()],
  )
  return {
    address,
    realizedPnl: result.rows[0].closed === '0' ? null : signedMoney(BigInt(result.rows[0].realized)),
    winRatePct: null,
    profitFactor: null,
    maxDrawdownPct: null,
    currentStreak: 0,
    longestWinStreak: 0,
    longestLossStreak: 0,
    averageHoldSeconds: null,
    bestMarketId: null,
    worstMarketId: null,
    closedTrades: Number(result.rows[0].closed),
    equityCurve: [],
  }
}

async function summarySlice(pool: pg.Pool, from: number, to: number) {
  const [fills, takers, users, revenue, flows, liqs] = await Promise.all([
    pool.query(
      `SELECT coalesce(sum(notional_micros),0) AS volume,coalesce(sum(fee_micros),0) AS fees,
      coalesce(sum(builder_fee_micros),0) AS builder FROM analytics_fills WHERE occurred_at >= $1 AND occurred_at < $2`,
      [new Date(from), new Date(to)],
    ),
    pool.query(
      `SELECT coalesce(sum(fee_micros),0) AS fees,coalesce(sum(builder_fee_micros),0) AS builder
      FROM analytics_taker_fees WHERE occurred_at >= $1 AND occurred_at < $2`,
      [new Date(from), new Date(to)],
    ),
    pool.query(
      `SELECT count(DISTINCT a.address) AS users FROM analytics_fills f
      JOIN analytics_accounts a ON a.account_id=f.account_id
      WHERE f.occurred_at >= $1 AND f.occurred_at < $2`,
      [new Date(from), new Date(to)],
    ),
    pool.query(
      `SELECT coalesce(sum(protocol_fee_micros),0) AS revenue FROM analytics_position_events
      WHERE occurred_at >= $1 AND occurred_at < $2 AND action <> 'liquidation'`,
      [new Date(from), new Date(to)],
    ),
    pool.query(
      `SELECT coalesce(sum(amount_micros) FILTER (WHERE direction='deposit'),0) AS deposits,
      coalesce(sum(amount_micros) FILTER (WHERE direction='withdrawal'),0) AS withdrawals
      FROM analytics_flows WHERE occurred_at >= $1 AND occurred_at < $2`,
      [new Date(from), new Date(to)],
    ),
    pool.query(`SELECT count(*) AS count FROM analytics_liquidations WHERE occurred_at >= $1 AND occurred_at < $2`, [
      new Date(from),
      new Date(to),
    ]),
  ])
  const fees = BigInt(fills.rows[0].fees) + BigInt(takers.rows[0].fees)
  return {
    volume: BigInt(fills.rows[0].volume),
    fees,
    revenue: BigInt(revenue.rows[0].revenue),
    users: BigInt(users.rows[0].users),
    liquidations: BigInt(liqs.rows[0].count),
    deposits: BigInt(flows.rows[0].deposits),
    withdrawals: BigInt(flows.rows[0].withdrawals),
  }
}
async function metricBuckets(pool: pg.Pool, metric: Metric, interval: '1h' | '1d', from: number, to: number) {
  const bucket = interval === '1h' ? 'hour' : 'day'
  const query =
    metric === 'fees'
      ? `SELECT date_trunc('${bucket}',occurred_at) AS time,sum(fee_micros) AS value FROM (
        SELECT occurred_at,fee_micros FROM analytics_fills UNION ALL
        SELECT occurred_at,fee_micros FROM analytics_taker_fees) f
        WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1 ORDER BY 1`
      : metric === 'active_users'
        ? `SELECT date_trunc('${bucket}',f.occurred_at) AS time,count(DISTINCT a.address) AS value
        FROM analytics_fills f JOIN analytics_accounts a ON a.account_id=f.account_id
        WHERE f.occurred_at >= $1 AND f.occurred_at < $2
        GROUP BY 1 ORDER BY 1`
        : `SELECT date_trunc('${bucket}',occurred_at) AS time,
        coalesce(sum(CASE WHEN direction='deposit' THEN amount_micros ELSE -amount_micros END),0) AS value
        FROM analytics_flows WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1 ORDER BY 1`
  const rows = await pool.query(query, [new Date(from), new Date(to)])
  return rows.rows.map((row: { time: Date | string; value: string }) => ({
    time: new Date(row.time).getTime(),
    value: BigInt(row.value),
  }))
}
