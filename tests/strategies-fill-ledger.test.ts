import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { exchange, slotFixture, maker, event, block, hash, requestValues } from './helpers/strategy-slot.js'
import { StrategyFillLedger } from '../server/src/infrastructure/strategies/fill-ledger.js'
import { strategyIntentHash } from '../packages/strategies/src/order-intent.js'
import type { StrategyLifecycleBlock } from '../packages/perpl/src/strategy-lifecycle.js'

async function fixture() {
  const { db, store } = await databaseFixture()
  const user = await store.ensureUser('0x0000000000000000000000000000000000000064')
  const connection = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
    VALUES($1,$2,'testnet','trade','fake','ACTIVE',now()+interval '1 day')`,
    [connection, user],
  )
  const strategy = (
    await db.query<{ id: string }>(
      `INSERT INTO strategies(user_id,connection_id,environment,account_id,
    market_id,mode,kind,capital,config,state,status) VALUES($1,$2,'testnet',642,116,'LIVE','GRID',100,'{}','{}','PAUSED')
    RETURNING id`,
      [user, connection],
    )
  ).rows[0].id
  const vector = slotFixture()
  const wire = { acc: 642, mkt: 116, t: 1, p: 990, s: 100, lv: 100, fl: 1 as const, orderTtlBlocks: 20 }
  const terms = { priceDecimals: 1, sizeDecimals: 3, contractMarketId: 16 }
  const insertOrder = async (owner = strategy) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO strategy_orders(
    strategy_id,environment,account_id,market_id,kind,simulated,status,side,price,size,
    idempotency_key,wire_order,market_terms,payload_hash,request_id,last_execution_block,submitted_at,
    venue_order_id,venue_progress) VALUES($1,'testnet',642,116,'POST',false,'PARTIAL','BUY',99,0.1,$2,$3,$4,$5,
    45,111,now(),90075,$6) RETURNING id`,
        [
          owner,
          randomUUID(),
          JSON.stringify(wire),
          JSON.stringify(terms),
          strategyIntentHash(wire, terms, null),
          JSON.stringify({ strategyAdmission: vector.admission }),
        ],
      )
    ).rows[0].id
  const order = await insertOrder()
  const read = vi.fn(async (_from: number, _to: number) => ({
    blocks: vector.blocks,
    finalized: { block: 112, hash: hash(112) },
  }))
  const ledger = () => new StrategyFillLedger(store.pool, 'testnet', exchange, { read })
  const count = async () =>
    Number((await db.query<{ n: number }>('SELECT count(*)::int n FROM strategy_verified_fills')).rows[0].n)
  return { db, store, user, connection, strategy, vector, wire, terms, order, read, ledger, count, insertOrder }
}

describe('durable receipt-backed strategy fills', () => {
  it('checkpoints long finalized history and resumes after restart without resending or losing earlier fills', async () => {
    const f = await fixture()
    try {
      const blocks = [
        ...f.vector.blocks,
        ...Array.from({ length: 637 }, (_, i) => block(113 + i, [])),
        block(750, [{ events: [maker(70n)] }]),
      ]
      f.read.mockImplementation(async (from, to) => ({
        blocks: blocks.filter((b) => Number(b.block.number) >= from && Number(b.block.number) <= to),
        finalized: { block: 750, hash: hash(750) },
      }))
      const last = { ...f.vector.candidate, s: 70, at: { b: 750, tx: 0, l: 0, txid: hash(75000).slice(2) } }
      await expect(f.ledger().ingest(f.user, f.order, last)).rejects.toThrow('STRATEGY_FILL_RECOVERY_PENDING')
      expect(await f.count()).toBe(0)
      expect((await f.db.query('SELECT max(through_block)::int b FROM strategy_slot_checkpoints')).rows[0].b).toBe(621)
      await f.ledger().ingest(f.user, f.order, last)
      await f.ledger().ingest(f.user, f.order, f.vector.candidate)
      expect((await f.ledger().totals(f.user, f.strategy)).buySize).toBe('0.1')
      expect(f.read.mock.calls.every(([from, to]) => to - from < 128)).toBe(true)
      expect(await f.count()).toBe(2)
    } finally {
      await f.db.close()
    }
  }, 30000)
  it('credits a cleared partial fill without labeling its discarded remainder FILLED', async () => {
    const f = await fixture()
    try {
      const value = slotFixture([
        event('OrderRequest', requestValues()),
        event('ClearingRemainingOrderLockBeyondBalance', [16n, 642n, 75n, 990n, 30n, 0n, 0n, 1n, 0n, 0n]),
        maker(),
      ])
      f.read.mockResolvedValue({ blocks: value.blocks, finalized: { block: 112, hash: hash(112) } })
      await f.ledger().ingest(f.user, f.order, value.candidate)
      expect(
        (await f.db.query('SELECT filled_size::text,status FROM strategy_orders WHERE id=$1', [f.order])).rows[0],
      ).toEqual({ filled_size: '0.030000000000000000', status: 'CANCELED' })
    } finally {
      await f.db.close()
    }
  }, 30000)
  it('credits a partial fill once across duplicate events and service restart, with exact fees', async () => {
    const f = await fixture()
    try {
      expect(await f.ledger().ingest(f.user, f.order, f.vector.candidate)).toMatchObject({ inserted: true })
      expect(await f.ledger().ingest(f.user, f.order, f.vector.candidate)).toMatchObject({ inserted: false })
      expect(await f.ledger().totals(f.user, f.strategy)).toEqual({
        buySize: '0.03',
        sellSize: '0',
        buyNotional: '2.97',
        sellNotional: '0',
        grossFees: '0.000003',
        builderFees: '0',
        fills: 1,
      })
      expect(
        (await f.db.query('SELECT filled_size::text,status FROM strategy_orders WHERE id=$1', [f.order])).rows[0],
      ).toEqual({ filled_size: '0.030000000000000000', status: 'PARTIAL' })
      expect(await f.count()).toBe(1)
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('rolls back a restart between ledger insert and order projection, then replays exactly once', async () => {
    const f = await fixture()
    try {
      await f.db.exec(`CREATE FUNCTION fail_fill_projection() RETURNS trigger AS $$ BEGIN
        RAISE EXCEPTION 'FAKE_CRASH_BEFORE_PROJECTION'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER fake_fill_crash BEFORE UPDATE ON strategy_orders FOR EACH ROW EXECUTE FUNCTION fail_fill_projection();`)
      await expect(f.ledger().ingest(f.user, f.order, f.vector.candidate)).rejects.toThrow(
        'FAKE_CRASH_BEFORE_PROJECTION',
      )
      expect(await f.count()).toBe(0)
      await f.db.exec('DROP TRIGGER fake_fill_crash ON strategy_orders; DROP FUNCTION fail_fill_projection();')
      await f.ledger().ingest(f.user, f.order, f.vector.candidate)
      expect(await f.count()).toBe(1)
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('does not regress a terminal order when earlier partial evidence arrives out of order', async () => {
    const f = await fixture()
    try {
      const last = block(113, [{ events: [maker(70n)] }])
      const blocks: StrategyLifecycleBlock[] = [...f.vector.blocks, last]
      f.read.mockImplementation(async (_from, to) => ({
        blocks: blocks.filter((b) => Number(b.block.number) <= to),
        finalized: { block: 113, hash: hash(113) },
      }))
      const second = { ...f.vector.candidate, s: 70, at: { b: 113, tx: 0, l: 0, txid: hash(11300).slice(2) } }
      await f.ledger().ingest(f.user, f.order, second)
      await f.ledger().ingest(f.user, f.order, f.vector.candidate)
      expect(
        (await f.db.query('SELECT filled_size::text,status FROM strategy_orders WHERE id=$1', [f.order])).rows[0],
      ).toEqual({ filled_size: '0.100000000000000000', status: 'FILLED' })
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('records late fills for stopped strategies without turning canceled remainder into a full fill', async () => {
    const f = await fixture()
    try {
      await f.db.query("UPDATE strategies SET status='STOPPED' WHERE id=$1", [f.strategy])
      await f.db.query("UPDATE strategy_orders SET status='CANCELED' WHERE id=$1", [f.order])
      await f.ledger().ingest(f.user, f.order, f.vector.candidate)
      expect(
        (await f.db.query('SELECT filled_size::text,status FROM strategy_orders WHERE id=$1', [f.order])).rows[0],
      ).toMatchObject({ filled_size: '0.030000000000000000', status: 'CANCELED' })
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('refuses absent evidence, non-finalized reads, forged candidates and foreign ownership without credit', async () => {
    const f = await fixture()
    try {
      await expect(f.ledger().ingest(randomUUID(), f.order, f.vector.candidate)).rejects.toThrow(
        'STRATEGY_ORDER_NOT_FOUND',
      )
      await expect(f.ledger().ingest(f.user, f.order, { ...f.vector.candidate, s: 31 })).rejects.toThrow(
        'STRATEGY_FILL_UNVERIFIED',
      )
      f.read.mockResolvedValueOnce({ blocks: [f.vector.blocks[0]], finalized: { block: 112, hash: hash(112) } })
      await expect(f.ledger().ingest(f.user, f.order, f.vector.candidate)).rejects.toThrow('STRATEGY_FILL_UNVERIFIED')
      f.read.mockResolvedValueOnce({ blocks: f.vector.blocks, finalized: { block: 111, hash: hash(111) } })
      await expect(f.ledger().ingest(f.user, f.order, f.vector.candidate)).rejects.toThrow(
        'STRATEGY_FILL_NOT_FINALIZED',
      )
      expect(await f.count()).toBe(0)
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('rechecks immutable admission after the RPC read, rejecting rebinding before any credit', async () => {
    const f = await fixture()
    try {
      f.read.mockImplementationOnce(async () => {
        await f.db.query('UPDATE strategy_orders SET request_id=46 WHERE id=$1', [f.order])
        return { blocks: f.vector.blocks, finalized: { block: 112, hash: hash(112) } }
      })
      await expect(f.ledger().ingest(f.user, f.order, f.vector.candidate)).rejects.toThrow(
        'STRATEGY_FILL_INTENT_CHANGED',
      )
      expect(await f.count()).toBe(0)
    } finally {
      await f.db.close()
    }
  }, 30000)

  it('migration 032 reruns twice without changing legacy paper rows or credited fill evidence', async () => {
    const f = await fixture()
    try {
      const paperStrategy = (
        await f.db.query<{ id: string }>(
          `INSERT INTO strategies(user_id,connection_id,environment,
        account_id,market_id,mode,kind,capital,config,state,status)
        SELECT user_id,connection_id,environment,account_id,market_id,'PAPER',kind,capital,config,state,'PAUSED'
        FROM strategies WHERE id=$1 RETURNING id`,
          [f.strategy],
        )
      ).rows[0].id
      const paperOrder = (
        await f.db.query<{ id: string }>(
          `INSERT INTO strategy_orders(strategy_id,environment,
        account_id,market_id,kind,simulated,status,side,price,size)
        VALUES($1,'testnet',642,116,'POST',true,'FILLED','BUY',99,0.1) RETURNING id`,
          [paperStrategy],
        )
      ).rows[0].id
      await f.db.query(
        `INSERT INTO strategy_fills(strategy_id,order_id,simulated,side,liquidity,price,size,fee,filled_at)
        VALUES($1,$2,true,'BUY','MAKER',99,0.1,0.003,now())`,
        [paperStrategy, paperOrder],
      )
      const legacy = (
        await f.db.query('SELECT row_to_json(f) value FROM strategy_fills f WHERE order_id=$1', [paperOrder])
      ).rows[0].value
      await f.ledger().ingest(f.user, f.order, f.vector.candidate)
      const sql = await readFile('database/migrations/032_strategy_verified_fills.sql', 'utf8')
      await f.db.exec(sql)
      await f.db.exec(sql)
      expect(await f.count()).toBe(1)
      const result = await f.db.query("SELECT count(*)::int n FROM strategies WHERE id=$1 AND status='PAUSED'", [
        f.strategy,
      ])
      expect(result.rows[0].n).toBe(1)
      expect(
        (await f.db.query('SELECT row_to_json(f) value FROM strategy_fills f WHERE order_id=$1', [paperOrder])).rows[0]
          .value,
      ).toEqual(legacy)
      const totals = await f.ledger().totals(f.user, paperStrategy)
      expect(totals.fills).toBe(0)
    } finally {
      await f.db.close()
    }
  }, 30000)
})
