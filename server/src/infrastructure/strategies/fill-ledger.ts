import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import type { Pool } from 'pg'
import type { WireFill } from '../../../../packages/perpl/src/decoder.js'
import {
  advanceStrategySlot,
  verifyStrategyMakerFill,
  type StrategyLifecycleBlock,
  type StrategySlotCheckpoint,
} from '../../../../packages/perpl/src/strategy-lifecycle.js'
import type { VerifiedStrategyOperation } from '../../../../packages/perpl/src/strategy-receipts.js'
import { reconcileStrategyIntent } from '../../../../packages/strategies/src/order-reconciliation.js'
import { strategyIntentHash } from '../../../../packages/strategies/src/order-intent.js'
import type { StrategyOrderRecord } from '../../application/strategy-orders.js'

const Exact = Decimal.clone({ precision: 160 })
type Row = StrategyOrderRecord & { user_id: string; mode: string }
type Reader = {
  read(
    from: number,
    to: number,
  ): Promise<{
    blocks: StrategyLifecycleBlock[]
    finalized: { block: number; hash: string }
  }>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plain = (value: string) => new Exact(value).toFixed()

function admission(row: Row): VerifiedStrategyOperation {
  const terms = row.market_terms
  if (
    row.simulated ||
    row.mode !== 'LIVE' ||
    row.kind !== 'POST' ||
    !row.request_id ||
    !row.submitted_at ||
    !row.wire_order ||
    !terms ||
    row.target_order_id !== null ||
    ![terms.priceDecimals, terms.sizeDecimals].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 18) ||
    row.payload_hash !== strategyIntentHash(row.wire_order, terms, null)
  )
    throw Error('STRATEGY_FILL_INTENT_UNVERIFIED')
  const resolved = reconcileStrategyIntent(
    {
      accountId: Number(row.account_id),
      marketId: row.market_id,
      contractMarketId: terms.contractMarketId,
      requestId: String(row.request_id),
      kind: 'POST',
      order: row.wire_order,
      lastExecutionBlock: Number(row.last_execution_block),
      submittedAt: row.submitted_at.getTime(),
      venueOrderId: Number(row.venue_order_id),
      previousAdmission: row.venue_progress?.strategyAdmission as VerifiedStrategyOperation | undefined,
      ...(Object.hasOwn(terms, 'builderId')
        ? { builderId: terms.builderId, builderFeePer100K: terms.builderFeePer100K }
        : {}),
    },
    { snapshotReady: false, snapshot: [], history: [], operations: [] },
  )
  if (!resolved.admission?.identity) throw Error('STRATEGY_FILL_INTENT_UNVERIFIED')
  return resolved.admission
}
const intentIdentity = (row: Row, proof: VerifiedStrategyOperation) =>
  digest([
    row.id,
    row.strategy_id,
    row.user_id,
    row.environment,
    row.account_id,
    row.market_id,
    row.payload_hash,
    row.request_id,
    String(row.last_execution_block),
    row.venue_order_id,
    proof,
  ])

/** Internal read-only ingestion seam; never submits, retries or credits paper fills.
 * The configured finalized RPC reader and immutable admitted POST identify each slot generation.
 * Totals describe proved fills, not a claim of account/strategy PnL or available capital.
 * Funding/settlement attribution remains a separate prerequisite for LIVE startup.
 */
export class StrategyFillLedger {
  constructor(
    private readonly pool: Pool,
    private readonly environment: 'testnet' | 'mainnet',
    private readonly exchange: string,
    private readonly reader: Reader,
  ) {
    if (!/^0x[0-9a-f]{40}$/i.test(exchange)) throw Error('STRATEGY_FILL_EXCHANGE_INVALID')
  }

  async ingest(userId: string, orderId: string, candidate: WireFill): Promise<{ inserted: boolean }> {
    const sql = `SELECT o.*,s.user_id,s.mode FROM strategy_orders o JOIN strategies s ON s.id=o.strategy_id
      WHERE o.id=$1 AND s.user_id=$2 AND o.environment=$3`
    const row = (await this.pool.query<Row>(sql, [orderId, userId, this.environment])).rows[0]
    if (!row) throw Error('STRATEGY_ORDER_NOT_FOUND')
    const original = admission(row),
      identity = intentIdentity(row, original)
    const target = candidate?.at?.b
    if (!Number.isSafeInteger(target) || target! < original.block) throw Error('STRATEGY_FILL_UNVERIFIED')
    const prior = (
      await this.pool.query<{ intent_hash: string; replay_state: StrategySlotCheckpoint }>(
        `SELECT intent_hash,replay_state FROM strategy_slot_checkpoints
       WHERE order_id=$1 AND through_block<$2 ORDER BY through_block DESC LIMIT 1`,
        [row.id, target],
      )
    ).rows[0]
    if (prior && prior.intent_hash !== identity) throw Error('STRATEGY_FILL_INTENT_CHANGED')
    let checkpoint = prior?.replay_state
    let range: Awaited<ReturnType<Reader['read']>> | undefined
    for (let page = 0; page < 4; page++) {
      const from = checkpoint ? checkpoint.throughBlock + 1 : original.block
      const to = Math.min(from + 127, target!)
      range = await this.reader.read(from, to)
      if (
        !Number.isSafeInteger(range.finalized.block) ||
        range.finalized.block < to ||
        !/^0x[0-9a-f]{64}$/i.test(range.finalized.hash)
      )
        throw Error('STRATEGY_FILL_NOT_FINALIZED')
      if (to === target) break
      const advanced = advanceStrategySlot(this.exchange, original, range.blocks, checkpoint)
      if (advanced.status !== 'CHECKPOINT') throw Error('STRATEGY_FILL_UNVERIFIED')
      await this.saveCheckpoint(row, userId, identity, advanced.checkpoint)
      checkpoint = advanced.checkpoint
      range = undefined
    }
    // A later read resumes persisted coverage. No resend path exists.
    if (!range) throw Error('STRATEGY_FILL_RECOVERY_PENDING')
    const verified = verifyStrategyMakerFill(this.exchange, original, candidate, range.blocks, checkpoint)
    if (verified.status !== 'VERIFIED') throw Error('STRATEGY_FILL_UNVERIFIED')
    const fill = verified.fill,
      terms = row.market_terms
    const evidence = { fill, priceDecimals: terms.priceDecimals, sizeDecimals: terms.sizeDecimals }
    const proofHash = digest([fill, terms.priceDecimals, terms.sizeDecimals, row.wire_order.t])
    const size = new Exact(fill.sizeRaw).div(new Exact(10).pow(terms.sizeDecimals)).toFixed()
    const price = new Exact(fill.priceRaw).div(new Exact(10).pow(terms.priceDecimals)).toFixed()
    const gross = new Exact(fill.grossFeeRaw).div(1_000_000).toFixed()
    const builder = new Exact(fill.builderFeeRaw).div(1_000_000).toFixed()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const locked = (await client.query<Row>(sql + ' FOR UPDATE OF o,s', [orderId, userId, this.environment])).rows[0]
      let currentIdentity: string | undefined
      try {
        if (locked) currentIdentity = intentIdentity(locked, admission(locked))
      } catch {
        /* fail closed below */
      }
      if (currentIdentity !== identity) throw Error('STRATEGY_FILL_INTENT_CHANGED')
      const inserted = await client.query(
        `INSERT INTO strategy_verified_fills(environment,exchange,transaction_hash,
        log_index,block_hash,block_number,transaction_index,strategy_id,order_id,account_id,market_id,
        side,size,price,gross_fee,builder_fee,proof_hash,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT(environment,exchange,transaction_hash,log_index) DO NOTHING RETURNING order_id`,
        [
          this.environment,
          this.exchange.toLowerCase(),
          fill.transactionHash,
          fill.logIndex,
          fill.blockHash,
          fill.block,
          fill.transactionIndex,
          row.strategy_id,
          row.id,
          row.account_id,
          row.market_id,
          row.wire_order.t === 1 ? 'BUY' : 'SELL',
          size,
          price,
          gross,
          builder,
          proofHash,
          JSON.stringify(evidence),
        ],
      )
      if (!inserted.rows.length) {
        const existing = (
          await client.query<{ order_id: string; proof_hash: string }>(
            `SELECT order_id,proof_hash
          FROM strategy_verified_fills WHERE environment=$1 AND exchange=$2 AND transaction_hash=$3 AND log_index=$4`,
            [this.environment, this.exchange.toLowerCase(), fill.transactionHash, fill.logIndex],
          )
        ).rows[0]
        if (existing?.order_id !== row.id || existing.proof_hash !== proofHash)
          throw Error('STRATEGY_FILL_IDENTITY_CONFLICT')
      } else {
        // Projection and credit commit together. Earlier events never overwrite a later terminal proof.
        const latest = (
          await client.query<{ evidence: { fill: typeof fill } }>(
            `SELECT evidence FROM strategy_verified_fills
          WHERE order_id=$1 ORDER BY block_number DESC,transaction_index DESC,log_index DESC LIMIT 1`,
            [row.id],
          )
        ).rows[0].evidence.fill
        await client.query(
          `UPDATE strategy_orders SET filled_size=(SELECT COALESCE(sum(size),0)
          FROM strategy_verified_fills WHERE order_id=$1),status=CASE
          WHEN $2 THEN 'FILLED' WHEN status IN ('FILLED','CANCELED','EXPIRED','FAILED') THEN status
          WHEN $3 THEN 'CANCELED' ELSE 'PARTIAL' END,updated_at=now() WHERE id=$1`,
          [row.id, latest.fullyFilled, latest.removed],
        )
      }
      await client.query('COMMIT')
      return { inserted: inserted.rows.length === 1 }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async saveCheckpoint(row: Row, userId: string, identity: string, checkpoint: StrategySlotCheckpoint) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const locked = (
        await client.query<Row>(
          `SELECT o.*,s.user_id,s.mode FROM strategy_orders o
        JOIN strategies s ON s.id=o.strategy_id WHERE o.id=$1 AND s.user_id=$2 AND o.environment=$3
        FOR UPDATE OF o,s`,
          [row.id, userId, this.environment],
        )
      ).rows[0]
      let current: string | undefined
      try {
        if (locked) current = intentIdentity(locked, admission(locked))
      } catch {
        /* refuse below */
      }
      if (current !== identity) throw Error('STRATEGY_FILL_INTENT_CHANGED')
      await client.query(
        `INSERT INTO strategy_slot_checkpoints(order_id,through_block,intent_hash,block_hash,replay_state)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id,through_block) DO NOTHING`,
        [row.id, checkpoint.throughBlock, identity, checkpoint.blockHash, JSON.stringify(checkpoint)],
      )
      const saved = (
        await client.query<{ intent_hash: string; block_hash: string; replay_state: StrategySlotCheckpoint }>(
          'SELECT intent_hash,block_hash,replay_state FROM strategy_slot_checkpoints WHERE order_id=$1 AND through_block=$2',
          [row.id, checkpoint.throughBlock],
        )
      ).rows[0]
      if (
        saved.intent_hash !== identity ||
        saved.block_hash !== checkpoint.blockHash ||
        Object.entries(checkpoint).some(
          ([key, value]) => saved.replay_state[key as keyof StrategySlotCheckpoint] !== value,
        )
      )
        throw Error('STRATEGY_SLOT_CHECKPOINT_CONFLICT')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async totals(userId: string, strategyId: string) {
    if (
      !(
        await this.pool.query('SELECT id FROM strategies WHERE id=$1 AND user_id=$2 AND environment=$3', [
          strategyId,
          userId,
          this.environment,
        ])
      ).rows.length
    )
      throw Error('STRATEGY_NOT_FOUND')
    const row = (
      await this.pool.query<Record<string, string>>(
        `SELECT
      COALESCE(sum(size) FILTER(WHERE side='BUY'),0)::text buy_size,
      COALESCE(sum(size) FILTER(WHERE side='SELL'),0)::text sell_size,
      COALESCE(sum(size*price) FILTER(WHERE side='BUY'),0)::text buy_notional,
      COALESCE(sum(size*price) FILTER(WHERE side='SELL'),0)::text sell_notional,
      COALESCE(sum(gross_fee),0)::text gross_fee,COALESCE(sum(builder_fee),0)::text builder_fee,count(*)::text fills
      FROM strategy_verified_fills WHERE strategy_id=$1 AND environment=$2`,
        [strategyId, this.environment],
      )
    ).rows[0]
    // gross_fee already includes builder_fee. Displaying its component never charges it again.
    return {
      buySize: plain(row.buy_size),
      sellSize: plain(row.sell_size),
      buyNotional: plain(row.buy_notional),
      sellNotional: plain(row.sell_notional),
      grossFees: plain(row.gross_fee),
      builderFees: plain(row.builder_fee),
      fills: Number(row.fills),
    }
  }
}
