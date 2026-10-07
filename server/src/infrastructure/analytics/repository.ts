import type pg from 'pg'
import type { ChainLog, DecodedExchangeEvent } from '../../../../packages/analytics/src/decoder.js'
import type { DerivedEvent } from '../../../../packages/analytics/src/aggregate.js'

export interface IndexedBlock {
  number: bigint
  hash: string
  timestamp: Date
}
export interface IndexedLog {
  raw: ChainLog
  decoded: DecodedExchangeEvent | null
  derived: DerivedEvent | null
}
export interface Checkpoint {
  startBlock: bigint
  nextBlock: bigint
  lastBlockHash: string | null
  historyVerified: boolean
}

export class AnalyticsRepository {
  constructor(readonly pool: pg.Pool) {}

  async checkpoint(): Promise<Checkpoint | null> {
    const result = await this.pool.query(
      'SELECT start_block,next_block,last_block_hash,history_verified FROM analytics_checkpoint WHERE chain_id=143',
    )
    const row = result.rows[0] as
      { start_block: string; next_block: string; last_block_hash: string | null; history_verified: boolean } | undefined
    return row
      ? {
          startBlock: BigInt(row.start_block),
          nextBlock: BigInt(row.next_block),
          lastBlockHash: row.last_block_hash,
          historyVerified: row.history_verified,
        }
      : null
  }

  async initialize(startBlock: bigint, historyVerified: boolean): Promise<Checkpoint> {
    await this.pool.query(
      `INSERT INTO analytics_checkpoint(chain_id,start_block,next_block,history_verified)
      VALUES(143,$1,$1,$2) ON CONFLICT(chain_id) DO UPDATE SET
      start_block=LEAST(analytics_checkpoint.start_block,EXCLUDED.start_block),
      next_block=CASE WHEN EXCLUDED.start_block < analytics_checkpoint.start_block
        THEN EXCLUDED.start_block ELSE analytics_checkpoint.next_block END,
      last_block_hash=CASE WHEN EXCLUDED.start_block < analytics_checkpoint.start_block
        THEN NULL ELSE analytics_checkpoint.last_block_hash END,
      history_verified=analytics_checkpoint.history_verified OR
        (EXCLUDED.history_verified AND EXCLUDED.start_block <= analytics_checkpoint.start_block),
      updated_at=CASE WHEN EXCLUDED.start_block < analytics_checkpoint.start_block
        THEN now() ELSE analytics_checkpoint.updated_at END`,
      [startBlock.toString(), historyVerified],
    )
    const checkpoint = await this.checkpoint()
    if (!checkpoint) throw new Error('ANALYTICS_CHECKPOINT_MISSING')
    return checkpoint
  }

  /** Roll back a rare deeper reorg. Raw-event FK cascades clean derived rows. */
  async rewind(fromBlock: bigint): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL TIME ZONE 'UTC'")
      await client.query('DELETE FROM analytics_blocks WHERE block_number >= $1', [fromBlock.toString()])
      await client.query('DELETE FROM analytics_accounts WHERE created_block >= $1', [fromBlock.toString()])
      await client.query(
        `UPDATE analytics_checkpoint SET next_block=$1,last_block_hash=NULL,updated_at=now()
        WHERE chain_id=143`,
        [fromBlock.toString()],
      )
      await client.query('DELETE FROM analytics_market_hourly')
      await client.query('DELETE FROM analytics_market_daily')
      await this.refreshRollups(client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /** Atomic checkpoint, raw-event, derived-event and rollup update. */
  async saveChunk(blocks: IndexedBlock[], logs: IndexedLog[], fromBlock: bigint, startBlock: bigint): Promise<void> {
    if (!blocks.length || blocks[0].number !== fromBlock) throw new Error('ANALYTICS_CHUNK_INVALID')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL TIME ZONE 'UTC'")
      await client.query(
        `INSERT INTO analytics_checkpoint(chain_id,start_block,next_block)
        VALUES(143,$1,$1) ON CONFLICT(chain_id) DO NOTHING`,
        [startBlock.toString()],
      )
      const checkpoint = await client.query(
        'SELECT start_block,next_block FROM analytics_checkpoint WHERE chain_id=143 FOR UPDATE',
      )
      if (BigInt(checkpoint.rows[0].start_block) !== startBlock || BigInt(checkpoint.rows[0].next_block) !== fromBlock)
        throw new Error('ANALYTICS_CHECKPOINT_CONFLICT')
      for (const block of blocks)
        await client.query(
          `INSERT INTO analytics_blocks(block_number,block_hash,occurred_at)
        VALUES($1,$2,$3) ON CONFLICT(block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash,occurred_at=EXCLUDED.occurred_at`,
          [block.number.toString(), block.hash, block.timestamp],
        )
      const times = new Map(blocks.map((block) => [block.number.toString(), block.timestamp]))
      for (const { raw, decoded, derived } of logs) {
        const block = BigInt(raw.blockNumber)
        const time = times.get(block.toString())
        if (!time) throw new Error('ANALYTICS_LOG_BLOCK_MISSING')
        const key = [block.toString(), raw.transactionHash, Number(BigInt(raw.logIndex))]
        await client.query(
          `INSERT INTO analytics_raw_events(block_number,transaction_hash,log_index,transaction_index,block_hash,event_name,args,data,topics)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(block_number,transaction_hash,log_index) DO NOTHING`,
          [
            ...key,
            Number(BigInt(raw.transactionIndex)),
            raw.blockHash,
            decoded?.eventName ?? null,
            decoded ? JSON.stringify(decoded.args) : null,
            raw.data,
            JSON.stringify(raw.topics),
          ],
        )
        if (!derived) continue
        if (derived.kind === 'account') {
          await client.query(
            `INSERT INTO analytics_accounts(account_id,address,created_block) VALUES($1,$2,$3)
            ON CONFLICT(account_id) DO UPDATE SET address=EXCLUDED.address`,
            [derived.accountId, derived.address, block.toString()],
          )
        } else if (derived.kind === 'flow') {
          await client.query(
            `INSERT INTO analytics_flows(block_number,transaction_hash,log_index,account_id,direction,amount_micros,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [...key, derived.accountId, derived.direction, derived.amountMicros.toString(), time],
          )
        } else if (derived.kind === 'fill') {
          await client.query(
            `INSERT INTO analytics_fills(block_number,transaction_hash,log_index,account_id,market_id,price_raw,size_raw,notional_micros,fee_micros,builder_fee_micros,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
            [
              ...key,
              derived.accountId,
              derived.marketId,
              derived.priceRaw.toString(),
              derived.sizeRaw.toString(),
              derived.notionalMicros.toString(),
              derived.feeMicros.toString(),
              derived.builderFeeMicros.toString(),
              time,
            ],
          )
        } else if (derived.kind === 'taker_fee') {
          await client.query(
            `INSERT INTO analytics_taker_fees(block_number,transaction_hash,log_index,fee_micros,builder_fee_micros,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [...key, derived.feeMicros.toString(), derived.builderFeeMicros.toString(), time],
          )
        } else if (derived.kind === 'liquidation') {
          await client.query(
            `INSERT INTO analytics_liquidations(block_number,transaction_hash,log_index,account_id,market_id,side,lot_raw,price_raw,notional_micros,realized_pnl_micros,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
            [
              ...key,
              derived.accountId,
              derived.marketId,
              derived.side,
              derived.lotRaw.toString(),
              derived.priceRaw.toString(),
              derived.notionalMicros.toString(),
              derived.realizedPnlMicros.toString(),
              time,
            ],
          )
          await client.query(
            `INSERT INTO analytics_position_events(block_number,transaction_hash,log_index,account_id,market_id,side,action,size_raw,realized_pnl_micros,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
            [
              ...key,
              derived.accountId,
              derived.marketId,
              derived.side,
              derived.remainingLotRaw > 0n ? 'reduce' : 'liquidation',
              derived.remainingLotRaw.toString(),
              derived.realizedPnlMicros.toString(),
              time,
            ],
          )
        } else {
          await client.query(
            `INSERT INTO analytics_position_events(block_number,transaction_hash,log_index,account_id,market_id,side,action,size_raw,entry_price_raw,leverage_hundredths,collateral_micros,realized_pnl_micros,protocol_fee_micros,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
            [
              ...key,
              derived.accountId,
              derived.marketId,
              derived.side,
              derived.action,
              derived.sizeRaw?.toString() ?? null,
              derived.entryPriceRaw?.toString() ?? null,
              derived.leverageHundredths?.toString() ?? null,
              derived.collateralMicros?.toString() ?? null,
              derived.realizedPnlMicros?.toString() ?? null,
              derived.protocolFeeMicros?.toString() ?? null,
              time,
            ],
          )
        }
      }
      await this.refreshRollups(client, blocks[0].timestamp, blocks.at(-1)!.timestamp)
      const last = blocks.at(-1)!
      await client.query(
        `UPDATE analytics_checkpoint SET next_block=$1,last_block_hash=$2,updated_at=now() WHERE chain_id=143`,
        [(last.number + 1n).toString(), last.hash],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async refreshRollups(client: pg.PoolClient, from?: Date, to?: Date): Promise<void> {
    for (const [table, bucket] of [
      ['analytics_market_hourly', 'hour'],
      ['analytics_market_daily', 'day'],
    ] as const) {
      const trunc = bucket === 'hour' ? 'hour' : 'day'
      if (from && to)
        await client.query(
          `DELETE FROM ${table} WHERE ${bucket} BETWEEN date_trunc('${trunc}',$1::timestamptz) AND date_trunc('${trunc}',$2::timestamptz)`,
          [from, to],
        )
      await client.query(
        `INSERT INTO ${table}(${bucket},market_id,volume_micros,maker_fees_micros,active_accounts)
        SELECT date_trunc('${trunc}',occurred_at)${bucket === 'day' ? '::date' : ''},market_id,
          sum(notional_micros),sum(fee_micros),count(DISTINCT account_id)
        FROM analytics_fills
        ${from && to ? `WHERE occurred_at >= date_trunc('${trunc}',$1::timestamptz) AND occurred_at < date_trunc('${trunc}',$2::timestamptz) + interval '1 ${trunc}'` : ''}
        GROUP BY 1,2 ON CONFLICT(${bucket},market_id) DO UPDATE SET volume_micros=EXCLUDED.volume_micros,
          maker_fees_micros=EXCLUDED.maker_fees_micros,active_accounts=EXCLUDED.active_accounts`,
        from && to ? [from, to] : [],
      )
    }
  }
}
