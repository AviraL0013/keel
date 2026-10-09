import type { Pool } from 'pg'
import Decimal from 'decimal.js'

export type StrategyRunReport = {
  from: string
  to: string
  limitation: string
  strategies: Array<{
    id: string
    mode: string
    environment: string
    marketId: number
    pnl: number | null
    observedMinuteCoverage: number
    observedMinutes: number
    expectedMinutes: number
    fundingPaid: string
    transactionHashes: string[]
    fills: Array<{
      at: string
      side: string
      price: string
      size: string
      fee: string
      simulated: boolean
      transactionHash: string | null
    }>
    riskEvents: Array<{ at: string; code: string }>
  }>
}

const iso = (value: string) =>
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value))

export async function buildStrategyRunReport(
  pool: Pool,
  from: string,
  to: string,
  strategyId?: string,
): Promise<StrategyRunReport> {
  if (
    !iso(from) ||
    !iso(to) ||
    Date.parse(from) >= Date.parse(to) ||
    (strategyId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(strategyId))
  )
    throw new Error('STRATEGY_REPORT_WINDOW_INVALID')
  const selected = await pool.query<{ id: string; mode: string; environment: string; market_id: number }>(
    'SELECT id,mode,environment,market_id FROM strategies WHERE created_at<$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY id',
    [to, strategyId ?? null],
  )
  const strategies: StrategyRunReport['strategies'] = []
  const expectedMinutes = Math.ceil((Date.parse(to) - Date.parse(from)) / 60_000)
  for (const row of selected.rows) {
    const [equity, ticks, funding, fills, risks] = await Promise.all([
      pool.query<{ equity: string }>(
        `SELECT equity::text FROM strategy_equity_points
        WHERE strategy_id=$1 AND observed_at>=$2 AND observed_at<$3 ORDER BY observed_at`,
        [row.id, from, to],
      ),
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM strategy_tick_minutes
        WHERE strategy_id=$1 AND minute>=$2 AND minute<$3`,
        [row.id, from, to],
      ),
      pool.query<{ paid: string }>(
        `SELECT COALESCE(sum(amount),0)::text AS paid FROM strategy_funding
        WHERE strategy_id=$1 AND applied_at>=$2 AND applied_at<$3`,
        [row.id, from, to],
      ),
      pool.query<{
        filled_at: string
        side: string
        price: string
        size: string
        fee: string
        simulated: boolean
        transaction_hash: string | null
      }>(
        `SELECT filled_at,side,price::text,size::text,fee::text,simulated,transaction_hash
        FROM strategy_fills WHERE strategy_id=$1 AND filled_at>=$2 AND filled_at<$3 ORDER BY filled_at,id`,
        [row.id, from, to],
      ),
      pool.query<{ observed_at: string; code: string }>(
        `SELECT observed_at,code FROM strategy_risk_events
        WHERE strategy_id=$1 AND observed_at>=$2 AND observed_at<$3 ORDER BY observed_at,id`,
        [row.id, from, to],
      ),
    ])
    const points = equity.rows
    const pnl =
      points.length < 2 ? null : Number(new Decimal(points.at(-1)!.equity).minus(points[0]!.equity).toFixed(8))
    const verifiedHashes = [
      ...new Set(
        fills.rows
          .filter((fill) => !fill.simulated && /^0x[0-9a-fA-F]{64}$/.test(fill.transaction_hash ?? ''))
          .map((fill) => fill.transaction_hash!),
      ),
    ]
    const observedMinutes = Number(ticks.rows[0]?.count ?? 0)
    strategies.push({
      id: row.id,
      mode: row.mode,
      environment: row.environment,
      marketId: Number(row.market_id),
      pnl,
      observedMinuteCoverage: Math.min(1, observedMinutes / expectedMinutes),
      observedMinutes,
      expectedMinutes,
      fundingPaid: funding.rows[0]?.paid ?? '0',
      transactionHashes: verifiedHashes,
      fills: fills.rows.map((fill) => ({
        at: new Date(fill.filled_at).toISOString(),
        side: fill.side,
        price: fill.price,
        size: fill.size,
        fee: fill.fee,
        simulated: fill.simulated,
        transactionHash: fill.simulated ? null : fill.transaction_hash,
      })),
      riskEvents: risks.rows.map((risk) => ({ at: new Date(risk.observed_at).toISOString(), code: risk.code })),
    })
  }
  return {
    from,
    to,
    limitation:
      'Minute coverage counts recorded strategy ticks, not process uptime. PnL requires two equity observations in window. Transaction hashes come from non-simulated venue fills; verify receipts independently.',
    strategies,
  }
}
