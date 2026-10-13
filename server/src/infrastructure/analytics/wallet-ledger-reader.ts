import { getAddress } from 'viem'
import type pg from 'pg'
import { notionalMicros, signedMoney } from '../../../../packages/analytics/src/aggregate.js'
import type { Trade } from '../../../../packages/analytics/src/contract.js'
import { completeRange } from '../../../../packages/analytics/src/rollups.js'
import { scaledText } from './perpl-public.js'
import type { MarketPrecision } from '../../../../packages/analytics/src/aggregate.js'
import type { WalletChainAnalytics } from './wallet-chain.js'

const day = 86_400_000
type OwnerAt = WalletChainAnalytics['ownerAt']

export interface IndexedTradePage {
  items: Trade[]
  nextCursor: string | null
  unavailableReason: string | null
  from: string
  through: string
  asOf: string
  block: number | null
  complete: boolean
}

export interface IndexedGrossSettlement {
  grossRealizedPnl: string | null
  closedEvents: number | null
  unavailableReason: string | null
  from: string
  through: string
  asOf: string
  block: number | null
}

/** Gross price PnL plus funding on account-linked settlement events; fees excluded. */
export async function readIndexedGrossSettlement(
  pool: pg.Pool,
  address: string,
  ownerAt: OwnerAt,
  now = Date.now(),
): Promise<IndexedGrossSettlement> {
  const wanted = getAddress(address)
  const to = Math.floor(now / day) * day
  const from = to - 30 * day
  const client = await pool.connect()
  let ranges: Array<{ fromBlock: bigint; toBlock: bigint; fromTime: Date; throughTime: Date }>
  let ownerCursor = 0n
  let rows: Array<Record<string, unknown>>
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const coverage = await client.query(
      `SELECT from_block::text,to_block::text,from_time,through_time FROM analytics_rollup_coverage
       WHERE wallet_indexed_at IS NOT NULL ORDER BY from_block`,
    )
    ranges = coverage.rows.map((row: Record<string, unknown>) => ({
      fromBlock: BigInt(String(row.from_block)),
      toBlock: BigInt(String(row.to_block)),
      fromTime: new Date(String(row.from_time)),
      throughTime: new Date(String(row.through_time)),
    }))
    const ownerProgress = await client.query('SELECT next_block::text FROM analytics_rollup_owner_scan WHERE id=1')
    ownerCursor = BigInt(String(ownerProgress.rows[0]?.next_block ?? '0'))
    const result = await client.query(
      `SELECT e.account_id::text,e.block_number::text,e.block_hash,e.action,e.realized_pnl_micros::text
       FROM analytics_wallet_event e JOIN analytics_rollup_owner o ON o.account_id=e.account_id
       WHERE o.owner_address=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3
         AND (e.realized_pnl_micros IS NOT NULL OR e.action='unsupported')
       ORDER BY e.block_number,e.transaction_index,e.log_index LIMIT 21`,
      [wanted.toLowerCase(), new Date(from), new Date(to)],
    )
    rows = result.rows
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  const first = ranges.findLast((range) => range.fromTime.getTime() <= from)
  const last = ranges.find((range) => range.throughTime.getTime() >= to)
  const complete = !!first && !!last && completeRange(ranges, first.fromBlock, last.toBlock)
  let reason: string | null = !complete
    ? 'INCOMPLETE_HISTORY'
    : ownerCursor <= last.toBlock
      ? 'OWNER_ENUMERATION_INCOMPLETE'
      : rows.some((row) => row.action === 'unsupported')
        ? 'SETTLEMENT_FORMULA_UNVERIFIED'
        : rows.length > 20
          ? 'OWNER_PROOF_SCAN_LIMIT'
          : null
  let total = 0n
  if (!reason) {
    for (const row of rows) {
      const block = BigInt(String(row.block_number))
      const hash = String(row.block_hash)
      try {
        const proof = await ownerAt(BigInt(String(row.account_id)), block, hash)
        if (
          proof.accountId !== String(row.account_id) ||
          proof.address.toLowerCase() !== wanted.toLowerCase() ||
          proof.block !== block.toString() ||
          proof.blockHash.toLowerCase() !== hash.toLowerCase() ||
          proof.source !== 'monad_exchange'
        ) {
          reason = 'OWNERSHIP_UNVERIFIED'
          break
        }
      } catch {
        reason = 'OWNERSHIP_UNAVAILABLE'
        break
      }
      total += BigInt(String(row.realized_pnl_micros))
    }
  }
  const latest = ranges.at(-1)
  return {
    grossRealizedPnl: reason ? null : signedMoney(total),
    closedEvents: reason ? null : rows.length,
    unavailableReason: reason,
    from: new Date(from).toISOString(),
    through: new Date(to).toISOString(),
    asOf: latest?.throughTime.toISOString() ?? new Date(0).toISOString(),
    block: latest ? Number(latest.toBlock - 1n) : null,
  }
}

/** Wallet rows are candidates until ownership is proved at their exact event blocks. */
export async function readIndexedTradePage(
  pool: pg.Pool,
  address: string,
  precisionByMarket: Map<number, MarketPrecision>,
  ownerAt: OwnerAt,
  limit: number,
  cursor?: string,
  now = Date.now(),
): Promise<IndexedTradePage> {
  const wanted = getAddress(address)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw Error('WALLET_LEDGER_LIMIT_INVALID')
  let offset = 0
  if (cursor) {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    if (!/^\d+$/.test(decoded) || decoded.length > 5) throw Error('WALLET_LEDGER_CURSOR_INVALID')
    offset = Number(decoded)
    if (!Number.isSafeInteger(offset) || offset > 10000) throw Error('WALLET_LEDGER_CURSOR_INVALID')
  }
  const to = Math.floor(now / day) * day
  const from = to - 30 * day
  const client = await pool.connect()
  let ranges: Array<{ fromBlock: bigint; toBlock: bigint; fromTime: Date; throughTime: Date }>
  let rows: Array<Record<string, unknown>>
  let unresolved = 0
  let ownerCursor = 0n
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const coverage = await client.query(
      `SELECT from_block::text,to_block::text,from_time,through_time FROM analytics_rollup_coverage
       WHERE wallet_indexed_at IS NOT NULL ORDER BY from_block`,
    )
    ranges = coverage.rows.map((row: Record<string, unknown>) => ({
      fromBlock: BigInt(String(row.from_block)),
      toBlock: BigInt(String(row.to_block)),
      fromTime: new Date(String(row.from_time)),
      throughTime: new Date(String(row.through_time)),
    }))
    const ownerProgress = await client.query('SELECT next_block::text FROM analytics_rollup_owner_scan WHERE id=1')
    ownerCursor = BigInt(String(ownerProgress.rows[0]?.next_block ?? '0'))
    const incomplete = await client.query(
      `SELECT count(*)::text AS count FROM analytics_wallet_event e
       JOIN analytics_rollup_owner o ON o.account_id=e.account_id
       WHERE o.owner_address=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3
         AND (NOT e.fill_verified OR e.action='unsupported')`,
      [wanted.toLowerCase(), new Date(from), new Date(to)],
    )
    unresolved = Number(incomplete.rows[0]?.count ?? 0)
    const result = await client.query(
      `SELECT e.block_number::text,e.block_hash,e.transaction_hash,e.transaction_index,e.log_index,
              e.occurred_at,e.account_id::text,e.market_id,e.side,e.action,e.price_raw::text,
              e.size_raw::text,e.fee_micros::text,e.realized_pnl_micros::text
       FROM analytics_wallet_event e JOIN analytics_rollup_owner o ON o.account_id=e.account_id
       WHERE o.owner_address=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3
         AND e.fill_verified AND e.action IN ('open','increase','reduce','close','liquidation')
       ORDER BY e.block_number DESC,e.transaction_index DESC,e.log_index DESC LIMIT $4 OFFSET $5`,
      [wanted.toLowerCase(), new Date(from), new Date(to), limit + 1, offset],
    )
    rows = result.rows
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  const first = ranges.findLast((range) => range.fromTime.getTime() <= from)
  const last = ranges.find((range) => range.throughTime.getTime() >= to)
  const complete = !!first && !!last && completeRange(ranges, first.fromBlock, last.toBlock)
  const pageRows = rows.slice(0, limit)
  const items: Trade[] = []
  let proofUnavailable = false
  let proofMismatch = false
  for (const row of pageRows) {
    const block = BigInt(String(row.block_number))
    const hash = String(row.block_hash)
    let proof: Awaited<ReturnType<OwnerAt>>
    try {
      proof = await ownerAt(BigInt(String(row.account_id)), block, hash)
    } catch {
      proofUnavailable = true
      continue
    }
    if (
      proof.accountId !== String(row.account_id) ||
      proof.address.toLowerCase() !== wanted.toLowerCase() ||
      proof.block !== block.toString() ||
      proof.blockHash.toLowerCase() !== hash.toLowerCase() ||
      proof.source !== 'monad_exchange'
    ) {
      proofMismatch = true
      continue
    }
    const marketId = Number(row.market_id)
    const precision = precisionByMarket.get(marketId)
    if (!precision) throw Error('MARKET_PRECISION_UNAVAILABLE')
    const price = BigInt(String(row.price_raw))
    const size = BigInt(String(row.size_raw))
    items.push({
      id: `${row.block_number}:${row.transaction_hash}:${row.log_index}`,
      time: new Date(String(row.occurred_at)).toISOString(),
      marketId,
      side: row.side as 'long' | 'short',
      action: row.action as Trade['action'],
      price: scaledText(price, precision.priceDecimals),
      size: scaledText(size, precision.sizeDecimals),
      notional: signedMoney(notionalMicros(price, size, precision.priceDecimals, precision.sizeDecimals)),
      fee: row.fee_micros === null ? null : signedMoney(BigInt(String(row.fee_micros))),
      realizedPnl: row.realized_pnl_micros === null ? null : signedMoney(BigInt(String(row.realized_pnl_micros))),
      transactionHash: String(row.transaction_hash),
    })
  }
  const latest = ranges.at(-1)
  const pageCapReached = rows.length > limit && offset + limit > 10000
  return {
    items,
    nextCursor:
      rows.length > limit && offset + limit <= 10000 ? Buffer.from(String(offset + limit)).toString('base64url') : null,
    unavailableReason: proofUnavailable
      ? 'OWNERSHIP_UNAVAILABLE'
      : proofMismatch
        ? 'OWNERSHIP_UNVERIFIED'
        : pageCapReached
          ? 'TRADE_PAGE_LIMIT'
          : !complete
            ? 'INCOMPLETE_HISTORY'
            : ownerCursor <= (last?.toBlock ?? 0n)
              ? 'OWNER_ENUMERATION_INCOMPLETE'
              : unresolved > 0
                ? 'INCOMPLETE_TRADE_ATTRIBUTION'
                : null,
    from: new Date(from).toISOString(),
    through: new Date(to).toISOString(),
    asOf: latest?.throughTime.toISOString() ?? new Date(0).toISOString(),
    block: latest ? Number(latest.toBlock - 1n) : null,
    complete,
  }
}
