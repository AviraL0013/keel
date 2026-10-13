import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import {
  buildStrategyRunReport,
  createStrategyEvidencePublication,
} from '../server/src/infrastructure/strategies/report.js'
import { StrategyFillLedger } from '../server/src/infrastructure/strategies/fill-ledger.js'
import { strategyIntentHash } from '../packages/strategies/src/order-intent.js'
import { exchange, slotFixture, hash } from './helpers/strategy-slot.js'

const from = '2026-10-05T00:00:00Z',
  to = '2026-10-05T01:00:00Z'

async function reportFixture(mode: 'PAPER' | 'LIVE' = 'LIVE', environment: 'testnet' | 'mainnet' = 'mainnet') {
  const { db, store } = await databaseFixture()
  const user = await store.ensureUser('0x0000000000000000000000000000000000000073')
  const connection = randomUUID(),
    strategy = randomUUID(),
    order = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status)
     VALUES($1,$2,$3,'trade','never-export-this-key','ACTIVE')`,
    [connection, user, environment],
  )
  await db.query(
    `INSERT INTO strategies(id,user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status,created_at)
     VALUES($1,$2,$3,$4,642,116,$5,'GRID',1000,'{}','{}','STOPPED',$6)`,
    [strategy, user, connection, environment, mode, from],
  )
  const vector = slotFixture()
  const wire = { acc: 642, mkt: 116, t: 1, p: 990, s: 100, lv: 100, fl: 1 as const, orderTtlBlocks: 20 }
  const terms = { priceDecimals: 1, sizeDecimals: 3, contractMarketId: 16 }
  await db.query(
    `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,simulated,status,side,price,size,
       idempotency_key,wire_order,market_terms,payload_hash,request_id,last_execution_block,submitted_at,
       venue_order_id,venue_progress,created_at,execution_origin)
     VALUES($1,$2,$3,642,116,'POST',false,'PARTIAL','BUY',99,0.1,$4,$5,$6,$7,45,111,$8,90075,$9,$8,'AUTOMATION')`,
    [
      order,
      strategy,
      environment,
      randomUUID(),
      JSON.stringify(wire),
      JSON.stringify(terms),
      strategyIntentHash(wire, terms, null),
      from,
      JSON.stringify({ strategyAdmission: vector.admission }),
    ],
  )
  const report = () => buildStrategyRunReport(store.pool, from, to, strategy, { userId: user, environment })
  return { db, store, user, environment, strategy, order, vector, report }
}

it('labels simulated fills and reports PnL, risk and observed uptime without inventing hashes', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000071')
    const connection = randomUUID(),
      strategy = randomUUID(),
      order = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status)
      VALUES($1,$2,'testnet','trade','fixture','ACTIVE')`,
      [connection, user],
    )
    await db.query(
      `INSERT INTO strategies(id,user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status,created_at)
      VALUES($1,$2,$3,'testnet',642,16,'PAPER','GRID',1000,'{}','{}','STOPPED','2026-10-05T00:00:00Z')`,
      [strategy, user, connection],
    )
    await db.query(
      `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,simulated,status,side,price,size)
      VALUES($1,$2,'testnet',642,16,'POST',true,'FILLED','BUY',99,0.1)`,
      [order, strategy],
    )
    await db.query(
      `INSERT INTO strategy_fills(strategy_id,order_id,side,liquidity,price,size,fee,filled_at,simulated)
      VALUES($1,$2,'BUY','MAKER',99,0.1,0.01,'2026-10-05T00:30:00Z',true)`,
      [strategy, order],
    )
    await db.query(
      `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory) VALUES
      ($1,'2026-10-05T00:00:00Z',1000,0),($1,'2026-10-05T00:59:00Z',1001,0.1),($1,'2026-10-05T01:00:00Z',999,0)`,
      [strategy],
    )
    await db.query(
      `INSERT INTO strategy_tick_minutes(strategy_id,minute,first_tick,last_tick,tick_count)
      VALUES($1,'2026-10-05T00:30:00Z','2026-10-05T00:30:00Z','2026-10-05T00:30:59Z',2)`,
      [strategy],
    )
    await db.query(
      `INSERT INTO strategy_risk_events(strategy_id,code,observed_at)
      VALUES($1,'VOLATILITY','2026-10-05T00:45:00Z')`,
      [strategy],
    )
    const report = await buildStrategyRunReport(store.pool, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', strategy, {
      userId: user,
      environment: 'testnet',
    })
    expect(report.strategies[0]).toMatchObject({
      mode: 'PAPER',
      pnl: '1',
      pnlAvailability: 'SIMULATED',
      observedMinuteCoverage: 1 / 60,
      transactionHashes: [],
    })
    expect(report.strategies[0]!.fills[0]).toMatchObject({ simulated: true, transactionHash: null })
    expect(report.strategies[0]!.riskEvents[0]).toMatchObject({ code: 'VOLATILITY' })
  } finally {
    await db.close()
  }
}, 30_000)

it('refuses an unscoped export and never exposes another owner or environment', async () => {
  const f = await reportFixture()
  try {
    await expect(
      buildStrategyRunReport(f.store.pool, from, to, undefined, { userId: '', environment: 'mainnet' }),
    ).rejects.toThrow('STRATEGY_REPORT_SCOPE_INVALID')
    const other = await f.store.ensureUser('0x0000000000000000000000000000000000000074')
    expect(
      (await buildStrategyRunReport(f.store.pool, from, to, undefined, { userId: other, environment: 'mainnet' }))
        .strategies,
    ).toEqual([])
    expect(
      (await buildStrategyRunReport(f.store.pool, from, to, undefined, { userId: f.user, environment: 'testnet' }))
        .strategies,
    ).toEqual([])
  } finally {
    await f.db.close()
  }
}, 30_000)

it('does not report legacy LIVE hashes, paper equity, or unverified funding as real profitability', async () => {
  const f = await reportFixture()
  try {
    await f.db.query(
      `INSERT INTO strategy_fills(strategy_id,order_id,venue_order_id,transaction_hash,block_number,transaction_index,
         log_index,side,liquidity,price,size,fee,filled_at,simulated)
       VALUES($1,$2,90075,$3,112,0,0,'BUY','MAKER',99,0.1,0.01,$4,false)`,
      [f.strategy, f.order, hash(444), from],
    )
    await f.db.query(
      `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory)
       VALUES($1,$2,1000,0),($1,'2026-10-05T00:59:00Z',2000,0)`,
      [f.strategy, from],
    )
    await f.db.query(
      `INSERT INTO strategy_funding(strategy_id,applied_at,amount,simulated)
       VALUES($1,$2,100,false)`,
      [f.strategy, from],
    )
    const result = (await f.report()).strategies[0]
    expect(result).toMatchObject({
      pnl: null,
      pnlAvailability: 'UNAVAILABLE',
      fundingPaid: null,
      fills: [],
      automatedMainnetAdmissions: 1,
      automatedMainnetFills: 0,
    })
    expect(result.transactionHashes).not.toContain(hash(444))
    expect(result.commandAdmissions[0]).toMatchObject({ origin: 'AUTOMATION', evidence: 'STORED_COMMAND_ADMISSION' })
    await f.db.query(`UPDATE strategy_orders SET execution_origin='INTERNAL' WHERE id=$1`, [f.order])
    expect((await f.report()).strategies[0].automatedMainnetAdmissions).toBe(0)
    await f.db.query(`UPDATE strategy_orders SET payload_hash=$2 WHERE id=$1`, [f.order, 'a'.repeat(64)])
    expect((await f.report()).strategies[0].commandAdmissions).toEqual([])
  } finally {
    await f.db.close()
  }
}, 30_000)

it('exports only the stored verified fill ledger, preserving exact fees and JSONB proof identity', async () => {
  const f = await reportFixture()
  try {
    const ledger = new StrategyFillLedger(f.store.pool, f.environment, exchange, {
      read: vi.fn(async () => ({ blocks: f.vector.blocks, finalized: { block: 112, hash: hash(112) } })),
    })
    await ledger.ingest(f.user, f.order, f.vector.candidate)
    await f.db.query(`UPDATE strategy_verified_fills SET recorded_at='2026-10-05T00:30:00Z' WHERE order_id=$1`, [
      f.order,
    ])
    const result = await f.report()
    expect(result.independentlyReverified).toBe(false)
    expect(result.strategies[0]).toMatchObject({ pnl: null, fundingPaid: null, automatedMainnetFills: 1 })
    expect(result.strategies[0].fills).toHaveLength(1)
    expect(result.strategies[0].fills[0]).toMatchObject({
      size: '0.03',
      price: '99',
      fee: '0.000003',
      builderFee: '0',
      simulated: false,
      origin: 'AUTOMATION',
      evidence: 'STORED_VERIFIED_FILL',
      timeBasis: 'LEDGER_RECORDED_TIME',
      block: 112,
    })
    await f.db.query(`UPDATE strategy_verified_fills SET proof_hash=$2 WHERE order_id=$1`, [f.order, 'f'.repeat(64)])
    await expect(f.report()).rejects.toThrow('STRATEGY_REPORT_STORED_FILL_INVALID')
  } finally {
    await f.db.close()
  }
}, 30_000)

it('keeps simulation equity arithmetic exact beyond 2^53 and requires two distinct observations', async () => {
  const f = await reportFixture('PAPER', 'testnet')
  try {
    await f.db.query(
      `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory)
       VALUES($1,$2,9007199254740993.123456789,0)`,
      [f.strategy, from],
    )
    expect((await f.report()).strategies[0].pnl).toBe(null)
    await f.db.query(
      `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory)
       VALUES($1,'2026-10-05T00:59:00Z',9007199254740993.123456790,0)`,
      [f.strategy],
    )
    expect((await f.report()).strategies[0].pnl).toBe('0.000000001')
  } finally {
    await f.db.close()
  }
}, 30_000)

it('requires explicit review, safe HTTPS system URL and whitelists public artifact fields', async () => {
  const f = await reportFixture()
  try {
    const report = await f.report()
    const input = {
      ownerReviewed: true as const,
      systemUrl: 'https://app.eyeler.xyz',
      candidateSha: 'a'.repeat(40),
      publishedAt: '2026-10-05T02:00:00Z',
    }
    Object.assign(report, { privateKey: 'never-export-secret' })
    Object.assign(report.strategies[0], { connectionId: 'never-export-connection' })
    Object.assign(report.strategies[0].commandAdmissions[0], { sessionToken: 'never-export-token' })
    const published = createStrategyEvidencePublication(report, input)
    const encoded = JSON.stringify(published)
    expect(encoded).not.toContain('never-export')
    expect(encoded).not.toContain(f.user)
    expect(published).toMatchObject({ visibility: 'OWNER_REVIEWED_PUBLIC', deploymentAttested: false })
    for (const systemUrl of [
      'http://app.eyeler.xyz',
      'https://user:password@app.eyeler.xyz',
      'https://app.eyeler.xyz/?token=secret',
      'https://app.eyeler.xyz/#session',
    ])
      expect(() => createStrategyEvidencePublication(report, { ...input, systemUrl })).toThrow(
        'STRATEGY_PUBLICATION_URL_INVALID',
      )
    expect(() =>
      createStrategyEvidencePublication(report, { ...input, ownerReviewed: false as unknown as true }),
    ).toThrow('STRATEGY_PUBLICATION_REVIEW_REQUIRED')
  } finally {
    await f.db.close()
  }
}, 30_000)

it('refuses an oversized report instead of silently truncating evidence counts', async () => {
  const f = await reportFixture()
  try {
    await f.db.query(
      `INSERT INTO strategy_risk_events(strategy_id,code,observed_at)
       SELECT $1,'STALE',$2::timestamptz FROM generate_series(1,501)`,
      [f.strategy, from],
    )
    await expect(f.report()).rejects.toThrow('STRATEGY_REPORT_LIMIT_EXCEEDED')
    await expect(
      buildStrategyRunReport(f.store.pool, from, '2026-11-06T00:00:00Z', undefined, {
        userId: f.user,
        environment: 'mainnet',
      }),
    ).rejects.toThrow('STRATEGY_REPORT_WINDOW_INVALID')
  } finally {
    await f.db.close()
  }
}, 30_000)
