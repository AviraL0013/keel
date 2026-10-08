import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { StrategyOrderRecovery } from '../server/src/infrastructure/strategies/order-recovery.js'
import { strategyIntentHash } from '../packages/strategies/src/order-intent.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import type { StrategyOrderEvidence, StrategyCommandIntent } from '../packages/strategies/src/order-reconciliation.js'

async function fixture() {
  const { db, store } = await databaseFixture()
  const user = await store.ensureUser('0x0000000000000000000000000000000000000091')
  const connection = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
    VALUES($1,$2,'testnet','trade','fixture','ACTIVE',now()+interval '1 day')`,
    [connection, user],
  )
  const strategy = (
    await db.query<{ id: string }>(
      `INSERT INTO strategies(user_id,connection_id,environment,
    account_id,market_id,mode,kind,capital,config,state,status)
    VALUES($1,$2,'testnet',642,16,'LIVE','GRID',10,'{}','{}','HALTED') RETURNING id`,
      [user, connection],
    )
  ).rows[0].id
  const order = { acc: 642, mkt: 16, t: 1, p: 990, s: 100, lv: 100, fl: 1 as const, orderTtlBlocks: 20 }
  const terms = { priceDecimals: 1, sizeDecimals: 3 }
  const id = randomUUID(),
    hash = strategyIntentHash(order, terms, null)
  await db.query(
    `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,status,
    side,price,size,idempotency_key,wire_order,market_terms,payload_hash,request_id,last_execution_block,submitted_at)
    VALUES($1,$2,'testnet',642,16,'POST','SUBMITTING','BUY',99,0.1,$3,$4,$5,$6,45,120,to_timestamp(1))`,
    [id, strategy, randomUUID(), JSON.stringify(order), JSON.stringify(terms), hash],
  )
  const txHash = `0x${'a'.repeat(64)}`
  const evidence: StrategyOrderEvidence = {
    snapshotReady: true,
    snapshot: [{ acc: 642, mkt: 16, oid: 75, rq: '45', t: 1, st: 2, sr: 0, os: 100, fs: 0, at: { b: 110 } }],
    history: [],
    historyComplete: true,
    operations: [
      {
        accountId: 642,
        requestId: '45',
        marketId: 16,
        type: 1,
        orderId: '0',
        sizeRaw: '100',
        priceRaw: '990',
        leverageHundredths: 100,
        postOnly: true,
        fillOrKill: false,
        immediateOrCancel: false,
        expiryBlock: '0',
        amountRaw: '0',
        maxNegPnlCollatBps: '0',
        feePer100K: '0',
        lastExecutionBlock: 120,
        block: 110,
        txHash,
        requestLogIndex: 0,
        outcomeLogIndex: 1,
        outcome: 'PLACED',
        venueOrderId: 75,
      },
    ],
  }
  const sent = vi.fn()
  const read = vi.fn(async (_intent: StrategyCommandIntent) => evidence)
  const scoped = {
    accountId: 642,
    connectionId: connection,
    submitStrategy: sent,
    strategyOrderEvidence: read,
  } as unknown as RuntimeVenue
  const venues = { forUser: async () => scoped } as unknown as RuntimeVenue
  const recovery = () => new StrategyOrderRecovery(store.pool, venues, 'testnet')
  const row = async () =>
    (await db.query<Record<string, unknown>>('SELECT * FROM strategy_orders WHERE id=$1', [id])).rows[0]
  return { db, store, id, evidence, read, sent, venues, recovery, row, hash, order }
}

it('recovers persisted builder attribution without inferring terms from a renewed credential', async () => {
  const f = await fixture()
  try {
    const terms = { priceDecimals: 1, sizeDecimals: 3, builderId: 25, builderFeePer100K: 0 }
    await f.db.query('UPDATE strategy_orders SET market_terms=$2,payload_hash=$3 WHERE id=$1', [
      f.id,
      JSON.stringify(terms),
      strategyIntentHash(f.order, terms, null),
    ])
    await f.db.query('UPDATE perpl_connections SET builder_id=26,builder_fee_ceiling=0')
    f.evidence.operations = [{ ...f.evidence.operations![0], builderId: 25, builderFeePer100K: '0' }]
    await f.recovery().recover()
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ builderId: 25, builderFeePer100K: 0 }))
    expect(await f.row()).toMatchObject({ status: 'OPEN', venue_progress: { strategyAdmission: { builderId: 25 } } })
    expect(f.sent).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('recovers exact durable payload and stores admission before tracking later lifecycle, without resending', async () => {
  const f = await fixture()
  try {
    await f.recovery().recover()
    expect(f.read).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: '45', order: f.order, lastExecutionBlock: 120, submittedAt: 1000 }),
    )
    expect(await f.row()).toMatchObject({
      status: 'OPEN',
      venue_order_id: 75,
      venue_progress: { strategyAdmission: { outcome: 'PLACED', block: 110 } },
    })
    f.evidence.snapshot = []
    f.evidence.history = [{ acc: 642, mkt: 16, oid: 75, rq: '45', t: 1, st: 10, sr: 0, os: 100, fs: 0, at: { b: 110 } }]
    await f.recovery().recover()
    expect(await f.row()).toMatchObject({
      status: 'UNKNOWN',
      error: 'STRATEGY_ORDER_LIFECYCLE_UNVERIFIED',
      venue_progress: { strategyAdmission: { outcome: 'PLACED' } },
    })
    expect(f.sent).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('does not use legacy, forged or mutated durable metadata as snapshot proof', async () => {
  const f = await fixture()
  try {
    await f.db.query(`UPDATE strategy_orders SET wire_order=jsonb_set(wire_order,'{p}','991') WHERE id=$1`, [f.id])
    await f.recovery().recover()
    expect(await f.row()).toMatchObject({ status: 'UNKNOWN', error: 'STRATEGY_INTENT_UNVERIFIED' })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.sent).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('keeps concurrent persisted proof and intent changes from being overwritten by an older recovery read', async () => {
  const f = await fixture()
  try {
    f.read.mockImplementationOnce(async () => {
      await f.db.query(
        `UPDATE strategy_orders SET status='CANCELED',error='NEWER_PROOF',updated_at=now() WHERE id=$1`,
        [f.id],
      )
      return f.evidence
    })
    await f.recovery().recover()
    expect(await f.row()).toMatchObject({ status: 'CANCELED', error: 'NEWER_PROOF' })
    await f.db.query(`UPDATE strategy_orders SET status='UNKNOWN',error='MUTATED',updated_at=now() WHERE id=$1`, [f.id])
    f.read.mockImplementationOnce(async () => {
      await f.db.query(
        `UPDATE strategy_orders SET wire_order=jsonb_set(wire_order,'{p}','991'),updated_at=now() WHERE id=$1`,
        [f.id],
      )
      return f.evidence
    })
    await f.recovery().recover()
    expect(await f.row()).toMatchObject({ status: 'UNKNOWN', error: 'MUTATED' })
    expect(f.sent).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('does not contradict persisted placement proof when later lfr resets and history is unavailable', async () => {
  const f = await fixture()
  try {
    await f.recovery().recover()
    expect((await f.row()).status).toBe('OPEN')
    f.evidence.snapshot = []
    f.evidence.history = []
    f.evidence.operations = []
    f.evidence.account = { lfr: '44', block: 120 }
    await f.recovery().recover()
    expect(await f.row()).toMatchObject({
      status: 'UNKNOWN',
      venue_progress: { strategyAdmission: { outcome: 'PLACED' } },
    })
    expect(f.sent).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('pins the first placement identity when a reset request ID later produces a different order or rejection', async () => {
  const f = await fixture()
  try {
    await f.recovery().recover()
    const original = f.evidence.operations![0]
    for (const outcome of ['PLACED', 'REJECTED'] as const) {
      f.evidence.operations = [{ ...original, outcome, venueOrderId: 76, txHash: `0x${'b'.repeat(64)}`, block: 115 }]
      f.evidence.snapshot = [{ ...f.evidence.snapshot[0], oid: 76, at: { b: 115 } }]
      await f.recovery().recover()
      expect(await f.row()).toMatchObject({
        status: 'UNKNOWN',
        venue_order_id: 75,
        transaction_hash: original.txHash,
        venue_progress: { strategyAdmission: { outcome: 'PLACED', venueOrderId: 75, txHash: original.txHash } },
      })
    }
    expect(f.sent).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)

it('settles an owned CANCEL only after receipt proof for its new request, despite target history retaining the POST rq', async () => {
  const f = await fixture()
  try {
    await f.recovery().recover()
    const posted = await f.row(),
      id = randomUUID()
    const order = { acc: 642, mkt: 16, t: 5, oid: 75, s: 0, lv: 0, fl: 0 as const, orderTtlBlocks: 20 }
    const terms = { priceDecimals: 1, sizeDecimals: 3 }
    await f.db.query(
      `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,status,
      idempotency_key,wire_order,market_terms,payload_hash,target_order_id,venue_order_id,request_id,last_execution_block,submitted_at)
      VALUES($1,$2,'testnet',642,16,'CANCEL','UNKNOWN',$3,$4,$5,$6,$7,75,46,120,to_timestamp(1))`,
      [
        id,
        posted.strategy_id,
        randomUUID(),
        JSON.stringify(order),
        JSON.stringify(terms),
        strategyIntentHash(order, terms, f.id),
        f.id,
      ],
    )
    const placement = f.evidence.operations![0]
    f.evidence.snapshot = []
    f.evidence.history = [{ acc: 642, mkt: 16, oid: 75, rq: '45', t: 1, st: 5, sr: 0, os: 100, fs: 0, at: { b: 115 } }]
    f.evidence.operations = []
    await f.recovery().recover()
    expect((await f.db.query('SELECT status FROM strategy_orders WHERE id=$1', [id])).rows[0].status).toBe('UNKNOWN')
    f.evidence.operations = [
      {
        ...placement,
        requestId: '46',
        type: 5,
        orderId: '75',
        priceRaw: '0',
        sizeRaw: '0',
        leverageHundredths: 0,
        postOnly: false,
        outcome: 'CANCELED',
        block: 115,
      },
    ]
    await f.recovery().recover()
    expect(
      (await f.db.query('SELECT status,venue_progress FROM strategy_orders WHERE id=$1', [id])).rows[0],
    ).toMatchObject({
      status: 'CANCELED',
      venue_progress: { strategyAdmission: { requestId: '46', outcome: 'CANCELED' } },
    })
    expect(f.sent).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30000)
