import type { Pool, PoolClient } from 'pg'
import { formatMoney, moneyMicros } from '../../../../packages/ausd/src/money.js'
import { defaultFreshnessThresholds } from '../../../../packages/domain/src/index.js'
import { ConflictError, InfrastructureError } from '../../application/errors.js'

export type AccountCapitalBalance = {
  environment: 'testnet' | 'mainnet'
  accountId: number
  free: string
  observedAt: number
  observedBlock: number
}
type Binding = { environment: 'testnet' | 'mainnet'; account_id: string; user_id: string }

type QueryClient = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export async function lockBookAccountCapital(client: QueryClient, bookId: string): Promise<void> {
  const book = (
    await client.query(
      `SELECT b.user_id,b.venue_account_id,b.perpl_connection_id,c.environment
    FROM books b LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id WHERE b.id=$1`,
      [bookId],
    )
  ).rows[0]
  if (!book) throw new ConflictError('BOOK_NOT_FOUND')
  if (book.perpl_connection_id == null) return // Preserve the existing operator path.
  const owner = await client.query(
    `SELECT user_id FROM perpl_account_owners WHERE environment=$1 AND account_id=$2 AND user_id=$3 FOR UPDATE`,
    [book.environment, book.venue_account_id, book.user_id],
  )
  if (owner.rows.length !== 1) throw new ConflictError('ACCOUNT_CAPITAL_BINDING_UNAVAILABLE')
}

export async function withAccountCapital<T>(
  pool: Pool,
  owner: { userId: string; connectionId: string; accountId: number; environment: 'testnet' | 'mainnet' },
  work: (client: PoolClient, binding: Binding) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const binding = await lockAccountCapital(
      client,
      owner.userId,
      owner.connectionId,
      owner.accountId,
      owner.environment,
    )
    const result = await work(client, binding)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** The caller owns BEGIN/COMMIT. All admissions for this account use this lock. */
export async function lockAccountCapital(
  client: PoolClient,
  userId: string,
  connectionId: string,
  accountId: number,
  environment?: 'testnet' | 'mainnet',
): Promise<Binding> {
  const result = await client.query<Binding>(
    `SELECT c.environment,a.account_id::text,c.user_id
     FROM perpl_connections c JOIN perpl_accounts a ON a.connection_id=c.id
     JOIN perpl_account_owners o ON o.environment=c.environment AND o.account_id=a.account_id AND o.user_id=c.user_id
     WHERE c.id=$1 AND c.user_id=$2 AND a.account_id=$3 AND ($4::text IS NULL OR c.environment=$4)
       AND c.status='ACTIVE' AND c.revoked_at IS NULL AND c.expires_at>now() AND c.scope='trade'
       AND a.forwarding=true AND a.frozen=false
     FOR UPDATE OF o FOR SHARE OF c,a`,
    [connectionId, userId, accountId, environment ?? null],
  )
  if (result.rows.length !== 1) throw new ConflictError('ACCOUNT_CAPITAL_BINDING_UNAVAILABLE')
  return result.rows[0]!
}

/** No client attestation is accepted. The server fetches this balance after acquiring the account lock. */
export async function assertAccountCapitalCoverage(
  client: PoolClient,
  binding: Binding,
  balance: AccountCapitalBalance,
  required: string,
  excludeOpeningId?: string,
  now = Date.now(),
): Promise<string> {
  if (
    balance.environment !== binding.environment ||
    balance.accountId !== Number(binding.account_id) ||
    !Number.isSafeInteger(balance.observedAt) ||
    !Number.isSafeInteger(balance.observedBlock) ||
    balance.observedBlock <= 0 ||
    balance.observedAt > now ||
    now - balance.observedAt > defaultFreshnessThresholds.marketMs ||
    !/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(balance.free)
  )
    throw new InfrastructureError('PERPL_FREE_BALANCE_UNAVAILABLE')
  let free: bigint, amount: bigint
  try {
    free = moneyMicros(balance.free)
    amount = moneyMicros(required)
  } catch {
    throw new InfrastructureError('PERPL_FREE_BALANCE_UNAVAILABLE')
  }
  const claims = await client.query<{ amount: string }>(
    `SELECT (r.available+r.reserved)::text AS amount FROM reserves r
     JOIN books b ON b.id=r.book_id LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id
     WHERE b.venue_account_id=$1 AND (c.environment=$2 OR c.id IS NULL)
       AND (b.status<>'CLOSED' OR EXISTS(SELECT 1 FROM actions a WHERE a.book_id=b.id AND a.kind='DEFEND'
         AND a.status IN ('QUEUED','VALIDATING','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN','PARTIAL')))
     UNION ALL
     SELECT (collateral+fees)::text FROM opening_orders
     WHERE account_id=$1 AND environment=$2 AND ($3::uuid IS NULL OR id<>$3)
       AND status IN ('QUEUED','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN')
     UNION ALL
     SELECT capital::text FROM strategies WHERE account_id=$1 AND environment=$2 AND mode='LIVE'`,
    [binding.account_id, binding.environment, excludeOpeningId ?? null],
  )
  let promised = 0n
  try {
    for (const row of claims.rows) promised += moneyMicros(row.amount)
  } catch {
    throw new InfrastructureError('ACCOUNT_CAPITAL_CLAIMS_UNAVAILABLE')
  }
  // Receiving a response now does not prove its chain snapshot includes a
  // settled spend. Keep the claim until verified execution blocks are covered.
  const settled = await client.query<{
    amount: string
    status: string
    error: string | null
    request_id: string
    market_id: number
    side: string
    tx_hash: string
    evidence: {
      operations?: Array<{ requestId: string; marketId: number; type: number; block: number; txHash: string }>
      fills?: Array<{ acc: number; mkt: number; at: { b?: number } }>
      positions?: Array<{ at?: { b?: number } }>
    } | null
  }>(
    `SELECT (collateral+fees)::text AS amount,status,error,request_id::text,market_id,side,tx_hash,evidence FROM opening_orders
     WHERE environment=$1 AND account_id=$2 AND ($3::uuid IS NULL OR id<>$3) AND status IN ('CONFIRMED','PARTIAL','FAILED')`,
    [binding.environment, binding.account_id, excludeOpeningId ?? null],
  )
  const block = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  for (const row of settled.rows) {
    const operations = Array.isArray(row.evidence?.operations) ? row.evidence.operations : []
    const fills = Array.isArray(row.evidence?.fills) ? row.evidence.fills : []
    if (row.status === 'FAILED') {
      const positions = Array.isArray(row.evidence?.positions) ? row.evidence.positions : []
      if (!operations.length && !fills.length && !positions.length && row.error !== 'PERPL_REQUEST_ID_SUPERSEDED')
        continue // The submission/reconciliation path proved no account spend.
      // FAILED is an outcome of this intent, not proof that the account did not
      // spend. A superseded payload can exceed the original collateral budget.
      // Freeze admission until the balance covers every verified execution.
      if (
        !operations.length ||
        operations.some(
          (item) =>
            !item ||
            item.requestId !== row.request_id ||
            !/^0x[0-9a-fA-F]{64}$/.test(item.txHash) ||
            !block(item.block) ||
            item.block > balance.observedBlock,
        ) ||
        fills.some((fill) => !fill || !block(fill.at?.b) || fill.at.b > balance.observedBlock) ||
        positions.some((position) => !position || !block(position.at?.b) || position.at.b > balance.observedBlock)
      )
        throw new InfrastructureError('PERPL_FREE_BALANCE_UNAVAILABLE')
      continue
    }
    const operation = operations.find(
      (item) =>
        item &&
        item.requestId === row.request_id &&
        item.marketId === row.market_id &&
        item.type === (row.side === 'LONG' ? 1 : 2) &&
        item.txHash === row.tx_hash &&
        /^0x[0-9a-fA-F]{64}$/.test(item.txHash) &&
        block(item.block),
    )
    const covered =
      operation &&
      fills.length > 0 &&
      fills.every(
        (fill) => fill && fill.acc === Number(binding.account_id) && fill.mkt === row.market_id && block(fill.at?.b),
      ) &&
      balance.observedBlock >= Math.max(operation.block, ...fills.map((fill) => fill.at.b!))
    if (!covered) promised += moneyMicros(row.amount)
  }
  const defenses = await client.query<{ amount: string; venue_progress: { confirmedExecutionBlock?: number } | null }>(
    `SELECT e.amount::text,a.venue_progress FROM reserve_ledger_entries e JOIN actions a ON a.id=e.action_id
     JOIN books b ON b.id=e.book_id LEFT JOIN perpl_connections c ON c.id=b.perpl_connection_id
     WHERE e.type='RESERVE_DEPLOYED' AND b.venue_account_id=$1 AND (c.environment=$2 OR c.id IS NULL)`,
    [binding.account_id, binding.environment],
  )
  for (const row of defenses.rows) {
    const executed = row.venue_progress?.confirmedExecutionBlock
    if (!block(executed) || balance.observedBlock < executed) promised += moneyMicros(row.amount)
  }
  if (amount + promised > free) throw new ConflictError('ACCOUNT_CAPITAL_INSUFFICIENT')
  return formatMoney(free - promised - amount)
}
