import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import Decimal from 'decimal.js'
import type { StrategyOrderRecord } from '../../application/strategy-orders.js'
import type { VerifiedStrategyOperation } from '../../../../packages/perpl/src/strategy-receipts.js'
import type { VerifiedStrategyMakerFill } from '../../../../packages/perpl/src/strategy-lifecycle.js'
import { decodeStrategyOrderIdentity } from '../../../../packages/perpl/src/strategy-identity.js'
import { strategyIntentHash } from '../../../../packages/strategies/src/order-intent.js'
import { reconcileStrategyIntent } from '../../../../packages/strategies/src/order-reconciliation.js'

const Exact = Decimal.clone({ precision: 160 })
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plain = (value: string) => new Exact(value).toFixed()
const iso = (value: string) =>
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value))
const at = (value: string | Date) => new Date(value).toISOString()

export type StrategyReportScope = { userId: string; environment: 'testnet' | 'mainnet' }
export type StrategyRunReport = {
  schemaVersion: 1
  from: string
  to: string
  environment: 'testnet' | 'mainnet'
  limitation: string
  independentlyReverified: false
  strategies: Array<{
    id: string
    mode: string
    environment: string
    marketId: number
    accountId: string
    pnl: string | null
    pnlAvailability: 'SIMULATED' | 'UNAVAILABLE'
    pnlReason: string | null
    observedMinuteCoverage: number
    observedMinutes: number
    expectedMinutes: number
    fundingPaid: string | null
    transactionHashes: string[]
    automatedMainnetAdmissions: number
    automatedMainnetFills: number
    unresolvedOrders: number
    commandAdmissions: Array<{
      orderId: string
      kind: string
      submittedAt: string
      origin: 'AUTOMATION' | 'ORIGIN_NOT_RECORDED'
      requestId: string
      block: number
      transactionHash: string
      evidence: 'STORED_COMMAND_ADMISSION'
    }>
    fills: Array<{
      at: string
      timeBasis: 'SIMULATED_FILL_TIME' | 'LEDGER_RECORDED_TIME'
      orderId: string
      side: string
      price: string
      size: string
      fee: string
      builderFee: string | null
      simulated: boolean
      origin: 'AUTOMATION' | 'ORIGIN_NOT_RECORDED'
      transactionHash: string | null
      block: number | null
      logIndex: number | null
      evidence: 'SIMULATED' | 'STORED_VERIFIED_FILL'
    }>
    riskEvents: Array<{ at: string; code: string }>
  }>
}

type Selected = { id: string; mode: string; environment: string; market_id: number; account_id: string }
type ReportOrder = StrategyOrderRecord & { execution_origin?: string }
type PaperFill = { filled_at: string | Date; order_id: string; side: string; price: string; size: string; fee: string }
type StoredFill = ReportOrder & {
  price: string
  size: string
  recorded_at: string | Date
  exchange: string
  transaction_hash: string
  block_hash: string
  block_number: string
  transaction_index: number
  log_index: number
  side: string
  gross_fee: string
  builder_fee: string
  proof_hash: string
  evidence: { fill: VerifiedStrategyMakerFill; priceDecimals: number; sizeDecimals: number }
}

function origin(row: ReportOrder): 'AUTOMATION' | 'ORIGIN_NOT_RECORDED' {
  return row.execution_origin === 'AUTOMATION' ? 'AUTOMATION' : 'ORIGIN_NOT_RECORDED'
}

/** Revalidate the stored immutable command, without making a new chain-verification claim. */
function admission(row: ReportOrder): VerifiedStrategyOperation | undefined {
  try {
    const terms = row.market_terms
    if (
      row.simulated ||
      !row.request_id ||
      !row.submitted_at ||
      !row.wire_order ||
      !terms ||
      ![terms.priceDecimals, terms.sizeDecimals].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 18) ||
      row.payload_hash !== strategyIntentHash(row.wire_order, terms, row.target_order_id)
    )
      return undefined
    return reconcileStrategyIntent(
      {
        accountId: Number(row.account_id),
        marketId: Number(row.market_id),
        contractMarketId: terms.contractMarketId,
        requestId: String(row.request_id),
        kind: row.kind,
        order: row.wire_order,
        lastExecutionBlock: Number(row.last_execution_block),
        submittedAt: new Date(row.submitted_at).getTime(),
        targetIdentity: decodeStrategyOrderIdentity(terms.targetIdentity),
        previousAdmission: row.venue_progress?.strategyAdmission as VerifiedStrategyOperation | undefined,
        ...(row.venue_order_id ? { venueOrderId: Number(row.venue_order_id) } : {}),
        ...(Object.hasOwn(terms, 'builderId')
          ? { builderId: terms.builderId, builderFeePer100K: terms.builderFeePer100K }
          : {}),
      },
      { snapshotReady: false, snapshot: [], history: [], operations: [] },
    ).admission
  } catch {
    return undefined
  }
}

function verifiedFill(row: StoredFill): boolean {
  try {
    const command = admission(row),
      stored = row.evidence,
      fill = stored?.fill,
      terms = row.market_terms
    return !!(
      row.kind === 'POST' &&
      command?.identity &&
      fill &&
      terms &&
      /^0x[0-9a-f]{40}$/i.test(row.exchange) &&
      hash(row.transaction_hash) &&
      hash(row.block_hash) &&
      fill.transactionHash === row.transaction_hash &&
      fill.blockHash === row.block_hash &&
      fill.block === Number(row.block_number) &&
      fill.transactionIndex === row.transaction_index &&
      fill.logIndex === row.log_index &&
      fill.accountId === Number(row.account_id) &&
      fill.marketId === row.market_id &&
      row.side === (row.wire_order.t === 1 ? 'BUY' : 'SELL') &&
      fill.contractMarketId === terms.contractMarketId &&
      fill.venueOrderId === command.venueOrderId &&
      fill.contractOrderId === command.contractOrderId &&
      fill.placementRequestId === String(row.request_id) &&
      fill.placementTransactionHash === command.txHash &&
      fill.placementLogIndex === command.outcomeLogIndex &&
      fill.block >= command.block &&
      stored.priceDecimals === terms.priceDecimals &&
      stored.sizeDecimals === terms.sizeDecimals &&
      // The ledger hashes the verifier's ordered object. JSONB reorders keys;
      // rebuild that original field order rather than hash the database object.
      row.proof_hash ===
        digest([
          pick(fill, [
            'transactionHash',
            'blockHash',
            'block',
            'transactionIndex',
            'logIndex',
            'transactionLogIndex',
            'accountId',
            'marketId',
            'contractMarketId',
            'venueOrderId',
            'contractOrderId',
            'placementRequestId',
            'placementTransactionHash',
            'placementLogIndex',
            'sizeRaw',
            'priceRaw',
            'grossFeeRaw',
            'builderFeeRaw',
            'remainingSizeRaw',
            'removed',
            'fullyFilled',
          ]),
          terms.priceDecimals,
          terms.sizeDecimals,
          row.wire_order.t,
        ]) &&
      row.size !== null &&
      row.price !== null &&
      new Exact(fill.sizeRaw).div(new Exact(10).pow(terms.sizeDecimals)).eq(row.size) &&
      new Exact(fill.priceRaw).div(new Exact(10).pow(terms.priceDecimals)).eq(row.price) &&
      new Exact(fill.grossFeeRaw).div(1_000_000).eq(row.gross_fee) &&
      new Exact(fill.builderFeeRaw).div(1_000_000).eq(row.builder_fee)
    )
  } catch {
    return false
  }
}

const bounded = <T>(rows: T[]): T[] => {
  if (rows.length > 500) throw Error('STRATEGY_REPORT_LIMIT_EXCEEDED')
  return rows
}

/** Owner-scoped, read-only export. It never submits, publishes, or independently verifies receipts. */
export async function buildStrategyRunReport(
  pool: Pick<Pool, 'query'>,
  from: string,
  to: string,
  strategyId: string | undefined,
  scope: StrategyReportScope,
): Promise<StrategyRunReport> {
  if (!scope || !uuid(scope.userId) || !['testnet', 'mainnet'].includes(scope.environment))
    throw Error('STRATEGY_REPORT_SCOPE_INVALID')
  if (
    !iso(from) ||
    !iso(to) ||
    Date.parse(from) >= Date.parse(to) ||
    Date.parse(to) - Date.parse(from) > 31 * 86_400_000 ||
    (strategyId !== undefined && !uuid(strategyId))
  )
    throw Error('STRATEGY_REPORT_WINDOW_INVALID')
  const selected = await pool.query<Selected>(
    `SELECT id,mode,environment,market_id,account_id::text FROM strategies
     WHERE user_id=$1 AND environment=$2 AND created_at<$3 AND ($4::uuid IS NULL OR id=$4)
     ORDER BY id LIMIT 101`,
    [scope.userId, scope.environment, to, strategyId ?? null],
  )
  if (selected.rows.length > 100) throw Error('STRATEGY_REPORT_LIMIT_EXCEEDED')
  const strategies: StrategyRunReport['strategies'] = []
  const expectedMinutes = Math.ceil((Date.parse(to) - Date.parse(from)) / 60_000)
  for (const row of selected.rows) {
    const [ticks, risks, commands, paper, live] = await Promise.all([
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM strategy_tick_minutes WHERE strategy_id=$1 AND minute>=$2 AND minute<$3`,
        [row.id, from, to],
      ),
      pool.query<{ observed_at: string; code: string }>(
        `SELECT observed_at,code FROM strategy_risk_events WHERE strategy_id=$1 AND observed_at>=$2 AND observed_at<$3
         ORDER BY observed_at,id LIMIT 501`,
        [row.id, from, to],
      ),
      pool.query<ReportOrder>(
        `SELECT * FROM strategy_orders WHERE strategy_id=$1 AND environment=$4 AND simulated=false
         AND COALESCE(submitted_at,created_at)>=$2 AND COALESCE(submitted_at,created_at)<$3
         ORDER BY COALESCE(submitted_at,created_at),id LIMIT 501`,
        [row.id, from, to, scope.environment],
      ),
      row.mode === 'PAPER'
        ? Promise.all([
            pool.query<{ equity: string }>(
              `SELECT equity::text FROM (
             (SELECT observed_at,equity FROM strategy_equity_points
              WHERE strategy_id=$1 AND observed_at>=$2 AND observed_at<$3 ORDER BY observed_at LIMIT 1)
             UNION
             (SELECT observed_at,equity FROM strategy_equity_points
              WHERE strategy_id=$1 AND observed_at>=$2 AND observed_at<$3 ORDER BY observed_at DESC LIMIT 1)
           ) points ORDER BY observed_at`,
              [row.id, from, to],
            ),
            pool.query<{ paid: string }>(
              `SELECT COALESCE(sum(amount),0)::text AS paid FROM strategy_funding
           WHERE strategy_id=$1 AND simulated=true AND applied_at>=$2 AND applied_at<$3`,
              [row.id, from, to],
            ),
            pool.query<PaperFill>(
              `SELECT filled_at,order_id,side,price::text,size::text,fee::text FROM strategy_fills
           WHERE strategy_id=$1 AND simulated=true AND filled_at>=$2 AND filled_at<$3 ORDER BY filled_at,id LIMIT 501`,
              [row.id, from, to],
            ),
          ])
        : Promise.resolve(null),
      row.mode === 'LIVE'
        ? pool.query<StoredFill>(
            `SELECT o.*,f.recorded_at,f.exchange,f.transaction_hash,f.block_hash,f.block_number::text,
           f.transaction_index,f.log_index,f.side,f.size::text,f.price::text,f.gross_fee::text,
           f.builder_fee::text,f.proof_hash,f.evidence
         FROM strategy_verified_fills f JOIN strategy_orders o ON o.id=f.order_id
         WHERE f.strategy_id=$1 AND f.environment=$4 AND f.recorded_at>=$2 AND f.recorded_at<$3
         ORDER BY f.block_number,f.transaction_index,f.log_index LIMIT 501`,
            [row.id, from, to, scope.environment],
          )
        : Promise.resolve(null),
    ])
    const commandAdmissions: StrategyRunReport['strategies'][number]['commandAdmissions'] = []
    for (const command of bounded(commands.rows)) {
      const proof = admission(command)
      if (row.mode === 'LIVE' && proof && command.submitted_at)
        commandAdmissions.push({
          orderId: command.id,
          kind: command.kind,
          submittedAt: at(command.submitted_at),
          origin: origin(command),
          requestId: String(command.request_id),
          block: proof.block,
          transactionHash: proof.txHash,
          evidence: 'STORED_COMMAND_ADMISSION',
        })
    }
    const fills: StrategyRunReport['strategies'][number]['fills'] = []
    if (paper)
      for (const fill of bounded(paper[2].rows))
        fills.push({
          at: at(fill.filled_at),
          timeBasis: 'SIMULATED_FILL_TIME',
          orderId: fill.order_id,
          side: fill.side,
          price: plain(fill.price),
          size: plain(fill.size),
          fee: plain(fill.fee),
          builderFee: null,
          simulated: true,
          origin: 'ORIGIN_NOT_RECORDED',
          transactionHash: null,
          block: null,
          logIndex: null,
          evidence: 'SIMULATED',
        })
    if (live)
      for (const fill of bounded(live.rows)) {
        if (!verifiedFill(fill)) throw Error('STRATEGY_REPORT_STORED_FILL_INVALID')
        fills.push({
          at: at(fill.recorded_at),
          timeBasis: 'LEDGER_RECORDED_TIME',
          orderId: fill.id,
          side: fill.side,
          price: plain(fill.price),
          size: plain(fill.size),
          fee: plain(fill.gross_fee),
          builderFee: plain(fill.builder_fee),
          simulated: false,
          origin: origin(fill),
          transactionHash: fill.transaction_hash,
          block: Number(fill.block_number),
          logIndex: fill.log_index,
          evidence: 'STORED_VERIFIED_FILL',
        })
      }
    const points = paper ? bounded(paper[0].rows) : []
    const observedMinutes = Number(ticks.rows[0]?.count ?? 0)
    strategies.push({
      id: row.id,
      mode: row.mode,
      environment: row.environment,
      marketId: Number(row.market_id),
      accountId: String(row.account_id),
      pnl: points.length < 2 ? null : new Exact(points.at(-1)!.equity).minus(points[0].equity).toFixed(),
      pnlAvailability: row.mode === 'PAPER' ? 'SIMULATED' : 'UNAVAILABLE',
      pnlReason:
        row.mode === 'PAPER'
          ? points.length < 2
            ? 'TWO_EQUITY_OBSERVATIONS_REQUIRED'
            : null
          : 'Complete attributed funding, settlement, gas and capital-flow coverage is not established.',
      observedMinuteCoverage: Math.min(1, observedMinutes / expectedMinutes),
      observedMinutes,
      expectedMinutes,
      fundingPaid: paper ? plain(paper[1].rows[0]?.paid ?? '0') : null,
      transactionHashes: [
        ...new Set([
          ...commandAdmissions.map((command) => command.transactionHash),
          ...fills.flatMap((fill) => (fill.transactionHash ? [fill.transactionHash] : [])),
        ]),
      ],
      automatedMainnetAdmissions:
        row.environment === 'mainnet' && row.mode === 'LIVE'
          ? commandAdmissions.filter((command) => command.origin === 'AUTOMATION').length
          : 0,
      automatedMainnetFills:
        row.environment === 'mainnet' && row.mode === 'LIVE'
          ? fills.filter((fill) => !fill.simulated && fill.origin === 'AUTOMATION').length
          : 0,
      unresolvedOrders: commands.rows.filter((command) => ['QUEUED', 'SUBMITTING', 'UNKNOWN'].includes(command.status))
        .length,
      commandAdmissions,
      fills,
      riskEvents: bounded(risks.rows).map((risk) => ({
        at: at(risk.observed_at),
        code: /^[A-Z0-9_]{1,100}$/.test(risk.code) ? risk.code : 'UNRECOGNIZED_RISK_CODE',
      })),
    })
  }
  return {
    schemaVersion: 1,
    from,
    to,
    environment: scope.environment,
    independentlyReverified: false,
    limitation:
      'Minute coverage counts recorded ticks, not uptime. PAPER PnL is simulated equity change. LIVE net PnL and funding completeness are unavailable. LIVE fills come only from the stored verified ledger; their window uses ledger recording time, not chain event time. Command admission is not a fill. Unresolved order counts cover commands submitted or created in the window, using status at export. Stored proofs and automation origin are revalidated database records, not independent RPC verification or deployment attestation. Gross fill fees already include builder fees. No API key, user ID, session, wallet address or connection ID is exported.',
    strategies,
  }
}

function pick<T, K extends keyof T>(value: T, keys: K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>
}

/** Explicit opt-in artifact for a public evidence page. No publication or network call occurs here. */
export function createStrategyEvidencePublication(
  report: StrategyRunReport,
  input: { ownerReviewed: true; systemUrl: string; candidateSha: string; publishedAt: string },
) {
  let url: URL
  try {
    url = new URL(input.systemUrl)
  } catch {
    throw Error('STRATEGY_PUBLICATION_URL_INVALID')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw Error('STRATEGY_PUBLICATION_URL_INVALID')
  if (input.ownerReviewed !== true || !/^[0-9a-f]{40}$/.test(input.candidateSha) || !iso(input.publishedAt))
    throw Error('STRATEGY_PUBLICATION_REVIEW_REQUIRED')
  const sanitized: StrategyRunReport = {
    ...pick(report, ['schemaVersion', 'from', 'to', 'environment', 'limitation', 'independentlyReverified']),
    strategies: report.strategies.map((strategy) => ({
      ...pick(strategy, [
        'id',
        'mode',
        'environment',
        'marketId',
        'accountId',
        'pnl',
        'pnlAvailability',
        'pnlReason',
        'observedMinuteCoverage',
        'observedMinutes',
        'expectedMinutes',
        'fundingPaid',
        'transactionHashes',
        'automatedMainnetAdmissions',
        'automatedMainnetFills',
        'unresolvedOrders',
      ]),
      commandAdmissions: strategy.commandAdmissions.map((command) =>
        pick(command, [
          'orderId',
          'kind',
          'submittedAt',
          'origin',
          'requestId',
          'block',
          'transactionHash',
          'evidence',
        ]),
      ),
      fills: strategy.fills.map((fill) =>
        pick(fill, [
          'at',
          'timeBasis',
          'orderId',
          'side',
          'price',
          'size',
          'fee',
          'builderFee',
          'simulated',
          'origin',
          'transactionHash',
          'block',
          'logIndex',
          'evidence',
        ]),
      ),
      riskEvents: strategy.riskEvents.map((risk) => pick(risk, ['at', 'code'])),
    })),
  }
  return {
    schemaVersion: 1 as const,
    visibility: 'OWNER_REVIEWED_PUBLIC' as const,
    publishedAt: input.publishedAt,
    systemUrl: url.toString(),
    candidateSha: input.candidateSha,
    deploymentAttested: false as const,
    report: sanitized,
  }
}
