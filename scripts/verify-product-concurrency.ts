import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { BooksApplication, type BookSetup } from '../server/src/application/books.js'
import { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'
import { DevelopmentKeyCustody } from '../server/src/infrastructure/perpl/key-custody.js'
import { PerplUserVenues } from '../server/src/infrastructure/perpl/user-venues.js'
import { PerplRequestIdAllocator } from '../server/src/infrastructure/perpl/request-id-allocator.js'
import { TelegramLinks } from '../server/src/infrastructure/telegram/links.js'
import { StrategyTelegramCommands } from '../server/src/infrastructure/strategies/telegram-commands.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import { OpeningTrades } from '../server/src/application/opening-trades.js'
import { StrategyOrderRecovery } from '../server/src/infrastructure/strategies/order-recovery.js'
import { strategyIntentHash } from '../packages/strategies/src/order-intent.js'
import type { StrategyOrderEvidence } from '../packages/strategies/src/order-reconciliation.js'

// No supplied connection string, environment file, production service or network
// endpoint is accepted. This command owns one ephemeral, loopback-only fixture.
const run = promisify(execFile)
const label = 'eyeler.fixture=product-concurrency'
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const signal = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
async function waitForBarrier(entered: Promise<void>, work: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      entered,
      work.then(() => {
        throw new Error('EXPECTED_HELD_TRANSACTION')
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('FIXTURE_BARRIER_TIMEOUT')), 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const docker = async (...args: string[]) =>
  (await run('docker', args, { timeout: 30_000, windowsHide: true })).stdout.trim()
async function fixturePort(id: string): Promise<number> {
  assert.match(id, /^[0-9a-f]{64}$/)
  const data = JSON.parse(await docker('inspect', id, '--format', '{{json .}}'))
  assert.equal(data.Config.Labels['eyeler.fixture'], 'product-concurrency')
  assert.match(data.Name, /^\/eyeler-product-test-/)
  const mapping = data.NetworkSettings.Ports['5432/tcp']
  assert.equal(mapping.length, 1)
  assert.equal(mapping[0].HostIp, '127.0.0.1')
  const port = Number(mapping[0].HostPort)
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535)
  return port
}
function pool(port: number, name: string, max = 2) {
  return new pg.Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'eyeler_fixture',
    max,
    application_name: name,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
  })
}
async function waitForLock(observer: pg.Pool, name: string) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    const rows = await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname='eyeler_fixture' AND application_name=$1 AND wait_event_type='Lock'",
      [name],
    )
    if (rows.rows.length) return
    await pause(20)
  }
  throw new Error(`EXPECTED_DATABASE_LOCK_${name}`)
}
async function seed(db: pg.Pool, account: number) {
  const store = new PostgresStore('', db)
  const user = await store.ensureUser(`0x${account.toString(16).padStart(40, '0')}`)
  const connection = randomUUID(),
    custody = new DevelopmentKeyCustody('12'.repeat(32))
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,wallet_address,scope_mask,expires_at,sealed_private_key,sealed_api_token)
    SELECT $1::uuid,id,'testnet','trade','fake','ACTIVE',wallet_address,3,now()+interval '1 day',$3,$4 FROM users WHERE id=$2`,
    [
      connection,
      user,
      custody.seal('11'.repeat(32), `${connection}:private_key`),
      custody.seal('fake-only', `${connection}:api_token`),
    ],
  )
  await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,$2,true,false)', [
    connection,
    account,
  ])
  await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',$1,$2)", [
    account,
    user,
  ])
  return { store, user, connection, custody }
}
async function proveBooks(db: pg.Pool, observer: pg.Pool) {
  const f = await seed(db, 642),
    entered = signal(),
    release = signal()
  let reloads = 0,
    sends = 0
  const createBook = f.store.createBook.bind(f.store)
  f.store.createBook = (user, input, reload) =>
    createBook(
      user,
      input,
      reload &&
        (async (client) => {
          if (++reloads === 1) {
            // Hold BEFORE the guarded venue's authorization query. A second creator
            // fills the pool before this transaction reloads any private venue state.
            entered.resolve()
            await release.promise
          }
          return reload(client)
        }),
    )
  const registry = new PerplUserVenues(
    f.store,
    'testnet',
    f.custody,
    async () =>
      ({
        accountId: 642,
        ready: () => true,
        refresh: async () => {},
        close: async () => {},
        submit: async () => {
          sends++
          throw new Error('ORDERS_FORBIDDEN')
        },
        reconcile: async (action) => action,
        loadBookSetup: async () => {
          const at = Date.now()
          return {
            market: 'BTC',
            reserveAvailable: 100,
            capital: { environment: 'testnet', accountId: 642, free: '100.000000', observedAt: at, observedBlock: 100 },
            position: {
              side: 'LONG',
              size: 1,
              entryPrice: 100,
              markPrice: 100,
              liquidationPrice: 90,
              leverage: 5,
              unrealizedPnl: 0,
              margin: 20,
              status: 'OPEN',
              timestamp: at,
            },
            telemetry: {
              mark: 100,
              oracle: 100,
              bid: 99.9,
              ask: 100.1,
              mid: 100,
              spreadBps: 20,
              fundingRate: 0,
              depthNotional: 10000,
              volatility: 0.01,
              volume24h: 0,
              openInterest: 0,
              block: 100,
              timestamp: at,
              source: 'replay',
            },
          } satisfies BookSetup
        },
      }) satisfies RuntimeVenue,
  )
  const app = new BooksApplication(f.store, registry)
  const command = (position: number) => ({
    market: 'BTC',
    marketId: 16,
    venueAccountId: 642,
    venuePositionId: position,
    side: 'LONG' as const,
    stance: 'DEFEND' as const,
    liquidationFloor: 6,
    defenseCap: 1,
    timeLimitMs: 3600000,
    automationEnabled: false,
    reserveAvailable: 60,
  })
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined
  try {
    await registry.start()
    await registry.forUser(f.user)
    first = app.create(f.user, command(1))
    await waitForBarrier(entered.promise, first)
    second = app.create(f.user, command(2)).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await waitForLock(observer, 'eyeler_fixture_books')
    // Both pool clients are occupied. The winner must reuse its own client.
    assert.equal(db.totalCount, 2)
    assert.equal(db.idleCount, 0)
    release.resolve()
    await first
    const result = (await second) as { error?: Error }
    assert.equal(result.error?.message, 'ACCOUNT_CAPITAL_INSUFFICIENT')
    assert.equal((await f.store.listBooks(f.user)).length, 1)
    assert.equal(sends, 0)
    console.log('PASS independent Book claims serialize with a saturated two-client pool; no order sent')
  } finally {
    release.resolve()
    await Promise.allSettled([first, second])
    await registry.close()
  }
}
async function proveTelegram(port: number, observer: pg.Pool) {
  const commandDb = pool(port, 'eyeler_fixture_command'),
    unlinkDb = pool(port, 'eyeler_fixture_unlink')
  const secret = 'fake-webhook-secret-only-32chars',
    f = await seed(commandDb, 643)
  const commands = new StrategyTelegramCommands(commandDb, 'testnet', async () => {})
  const links = new TelegramLinks(commandDb, 'EyelerFixtureBot', secret, Date.now, commands)
  const unlink = new TelegramLinks(unlinkDb, 'EyelerFixtureBot', secret)
  const update = (id: number) => ({
    update_id: id,
    message: {
      date: Math.floor(Date.now() / 1000),
      text: '/killswitch',
      chat: { id: 101, type: 'private' },
      from: { id: 101, is_bot: false },
    },
  })
  try {
    await commandDb.query(
      `INSERT INTO strategies(user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status)
      VALUES($1,$2,'testnet',643,16,'PAPER','GRID',100,'{}','{}','RUNNING')`,
      [f.user, f.connection],
    )
    await commandDb.query('INSERT INTO telegram_links(user_id,telegram_user_id,chat_id) VALUES($1,101,101)', [f.user])
    const blocker = await observer.connect()
    let unlinked: Promise<unknown> | undefined, handled: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.user])
      unlinked = unlink.unlink(f.user)
      await waitForLock(observer, 'eyeler_fixture_unlink')
      handled = links.handle(secret, update(801))
      await waitForLock(observer, 'eyeler_fixture_command')
      await blocker.query('COMMIT')
      await Promise.all([unlinked, handled])
      assert.equal(
        (await observer.query('SELECT * FROM strategy_user_controls WHERE user_id=$1', [f.user])).rows.length,
        0,
      )
      console.log('PASS independent unlink-first race refuses Telegram control')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await Promise.allSettled([unlinked, handled])
    }
    await commandDb.query('INSERT INTO telegram_links(user_id,telegram_user_id,chat_id) VALUES($1,101,101)', [f.user])
    const entered = signal(),
      release = signal(),
      execute = commands.execute.bind(commands)
    commands.execute = async (...args) => {
      const result = await execute(...args)
      entered.resolve()
      await release.promise
      return result
    }
    let command: Promise<unknown> | undefined, revoke: Promise<unknown> | undefined
    try {
      command = links.handle(secret, update(802))
      await waitForBarrier(entered.promise, command)
      revoke = unlink.unlink(f.user)
      await waitForLock(observer, 'eyeler_fixture_unlink')
      release.resolve()
      await Promise.all([command, revoke])
      await links.handle(secret, update(802))
      assert.equal(
        (await observer.query('SELECT killed FROM strategy_user_controls WHERE user_id=$1', [f.user])).rows[0].killed,
        true,
      )
      assert.equal(
        (
          await observer.query(
            'SELECT * FROM strategy_risk_events WHERE strategy_id IN (SELECT id FROM strategies WHERE user_id=$1)',
            [f.user],
          )
        ).rows.length,
        1,
      )
      assert.equal((await links.status(f.user)).status, 'NOT_LINKED')
      console.log('PASS independent command-first race commits once before unlink; replies are fake')
    } finally {
      release.resolve()
      await Promise.allSettled([command, revoke])
    }
  } finally {
    await commandDb.end()
    await unlinkDb.end()
  }
}

async function proveBookOpening(db: pg.Pool, observer: pg.Pool, bookFirst: boolean) {
  const account = bookFirst ? 645 : 644,
    f = await seed(db, account),
    entered = signal(),
    release = signal()
  let bookLoads = 0,
    quotes = 0,
    sends = 0
  const registry = new PerplUserVenues(
    f.store,
    'testnet',
    f.custody,
    async () =>
      ({
        accountId: account,
        ready: () => true,
        refresh: async () => {},
        close: async () => {},
        submit: async () => {
          sends++
          throw new Error('ORDERS_FORBIDDEN')
        },
        reconcile: async (action) => action,
        loadBookSetup: async () => {
          if (bookFirst && ++bookLoads === 2) {
            entered.resolve()
            await release.promise
          }
          const at = Date.now()
          return {
            market: 'BTC',
            reserveAvailable: 100,
            capital: {
              environment: 'testnet',
              accountId: account,
              free: '100.000000',
              observedAt: at,
              observedBlock: 100,
            },
            position: {
              side: 'LONG',
              size: 1,
              entryPrice: 100,
              markPrice: 100,
              liquidationPrice: 90,
              leverage: 5,
              unrealizedPnl: 0,
              margin: 20,
              status: 'OPEN',
              timestamp: at,
            },
            telemetry: {
              mark: 100,
              oracle: 100,
              bid: 99.9,
              ask: 100.1,
              mid: 100,
              spreadBps: 20,
              fundingRate: 0,
              depthNotional: 10000,
              volatility: 0.01,
              volume24h: 0,
              openInterest: 0,
              block: 100,
              timestamp: at,
              source: 'replay',
            },
          } satisfies BookSetup
        },
        openingMarketSnapshot: async () => {
          if (!bookFirst && ++quotes === 2) {
            entered.resolve()
            await release.promise
          }
          const at = Date.now()
          return {
            environment: 'testnet',
            accountId: account,
            marketId: 16,
            symbol: 'BTC',
            collateralAsset: 'USD',
            priceDecimals: 2,
            sizeDecimals: 2,
            collateralDecimals: 6,
            bidRaw: 9999,
            askRaw: 10001,
            markRaw: 10000,
            priceTick: '0.01',
            sizeStep: '0.01',
            minimumSize: '0.01',
            initialMarginBps: 1000,
            takerFeeMicros: 500,
            minimumNotionalRaw: '1000000',
            recycleFeeRaw: '1000',
            marketOpen: true,
            marketObservedAt: at,
            balanceObservedAt: at,
            balanceBlock: 100,
            marketBlock: 100,
            headBlock: 101,
            headObservedAt: at,
            orderTtlBlocks: 10,
            freeBalance: '100.000000',
          }
        },
      }) satisfies RuntimeVenue,
  )
  let winner: Promise<unknown> | undefined, loser: Promise<unknown> | undefined
  try {
    await registry.start()
    await registry.forUser(f.user)
    const books = new BooksApplication(f.store, registry),
      openings = new OpeningTrades(f.store, registry, 'testnet', { enabled: true, executionDisabled: false })
    const preview = await openings.preview(f.user, { marketId: 16, side: 'LONG', size: '1.00', leverage: '5.00' }),
      key = randomUUID()
    const create = () =>
      books.create(f.user, {
        market: 'BTC',
        marketId: 16,
        venueAccountId: account,
        venuePositionId: 1,
        side: 'LONG',
        stance: 'DEFEND',
        liquidationFloor: 6,
        defenseCap: 1,
        timeLimitMs: 3600000,
        automationEnabled: false,
        reserveAvailable: 90,
      })
    const prepare = () => openings.prepareConfirmation(f.user, preview.id, key)
    winner = bookFirst ? create() : prepare()
    await waitForBarrier(entered.promise, winner)
    loser = (bookFirst ? prepare() : create()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await waitForLock(observer, 'eyeler_fixture_books')
    release.resolve()
    await winner
    const result = (await loser) as { error?: Error }
    assert.equal(
      result.error?.message,
      bookFirst ? 'OPENING_WOULD_UNDERFUND_BOOK_RESERVES' : 'ACCOUNT_CAPITAL_INSUFFICIENT',
    )
    if (!bookFirst) assert.equal((await prepare()).createdNow, false)
    assert.equal(sends, 0)
    console.log(`PASS independent ${bookFirst ? 'Book-first' : 'opening-first'} capital race; no order sent`)
  } finally {
    release.resolve()
    await Promise.allSettled([winner, loser])
    await registry.close()
  }
}

async function proveStrategyRecovery(db: pg.Pool, observer: pg.Pool) {
  const f = await seed(observer, 707),
    id = randomUUID()
  const order = { acc: 707, mkt: 16, t: 1, s: 100, p: 990, lv: 100, fl: 1 as const, orderTtlBlocks: 20 }
  const terms = { priceDecimals: 1, sizeDecimals: 3, contractMarketId: 16 }
  const strategy = (
    await observer.query<{ id: string }>(
      `INSERT INTO strategies(user_id,connection_id,environment,
    account_id,market_id,mode,kind,capital,config,state,status)
    VALUES($1,$2,'testnet',707,16,'LIVE','GRID',10,'{}','{}','HALTED') RETURNING id`,
      [f.user, f.connection],
    )
  ).rows[0].id
  await observer.query(
    `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,status,
    side,price,size,idempotency_key,wire_order,market_terms,payload_hash,request_id,last_execution_block,submitted_at)
    VALUES($1,$2,'testnet',707,16,'POST','SUBMITTING','BUY',99,0.1,$3,$4,$5,$6,45,120,now())`,
    [id, strategy, randomUUID(), JSON.stringify(order), JSON.stringify(terms), strategyIntentHash(order, terms, null)],
  )
  const evidence: StrategyOrderEvidence = {
    historyComplete: true,
    history: [],
    snapshotReady: true,
    snapshot: [
      {
        acc: 707,
        mkt: 16,
        rq: '45',
        oid: 75,
        scid: 75,
        st: 2,
        t: 1,
        sr: 0,
        os: 100,
        fs: 0,
        c: { b: 110, tx: 0, txid: 'a'.repeat(64) },
        at: { b: 110 },
      },
    ],
    operations: [
      {
        accountId: 707,
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
        txHash: `0x${'a'.repeat(64)}`,
        requestLogIndex: 0,
        outcomeLogIndex: 1,
        outcome: 'PLACED',
        venueOrderId: 75,
        contractOrderId: 75,
        transactionIndex: 0,
        requestTransactionLogIndex: 0,
        outcomeTransactionLogIndex: 1,
        identity: {
          accountId: 707,
          marketId: 16,
          contractMarketId: 16,
          venueOrderId: 75,
          contractOrderId: 75,
          placementRequestId: '45',
          type: 1,
          creationBlock: 110,
          creationTransactionIndex: 0,
          creationTxHash: `0x${'a'.repeat(64)}`,
        },
      },
    ],
  }
  let read = async () => evidence
  const scoped = { accountId: 707, strategyOrderEvidence: () => read() } as RuntimeVenue
  const venue = { forUser: async () => scoped } as RuntimeVenue
  const recovery = new StrategyOrderRecovery(db, venue, 'testnet')
  await recovery.recover()
  assert.equal((await observer.query('SELECT status FROM strategy_orders WHERE id=$1', [id])).rows[0].status, 'OPEN')
  const entered = signal(),
    release = signal()
  read = async () => {
    entered.resolve()
    await release.promise
    return evidence
  }
  const work = recovery.recover()
  try {
    await waitForBarrier(entered.promise, work)
    // A different PostgreSQL session changes the immutable command while the
    // read-only venue lookup is held. The old recovery write must lose its CAS.
    await observer.query(
      `UPDATE strategy_orders SET wire_order=jsonb_set(wire_order,'{p}','991'),
      status='UNKNOWN',error='NEWER_SESSION',updated_at=now() WHERE id=$1`,
      [id],
    )
    release.resolve()
    await work
    const saved = (await observer.query('SELECT status,error,venue_order_id FROM strategy_orders WHERE id=$1', [id]))
      .rows[0]
    assert.equal(saved.status, 'UNKNOWN')
    assert.equal(saved.error, 'NEWER_SESSION')
    assert.equal(Number(saved.venue_order_id), 75)
    console.log('PASS independent strategy recovery CAS preserves newer command and pinned order; no submission method')
  } finally {
    release.resolve()
    await work
  }
}

if (process.argv[2] === '--allocator-worker') {
  const db = pool(await fixturePort(process.argv[3] ?? ''), 'eyeler_fixture_allocator', 1)
  try {
    console.log(await new PerplRequestIdAllocator(db).allocate(642, '100'))
  } finally {
    await db.end()
  }
} else {
  let id: string | undefined, db: pg.Pool | undefined, observer: pg.Pool | undefined
  try {
    id = await docker(
      'create',
      '--pull',
      'never',
      '--label',
      label,
      '--name',
      `eyeler-product-test-${randomUUID()}`,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=eyeler_fixture',
      '-p',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data:rw',
      'postgres:16',
    )
    await docker('start', id)
    const port = await fixturePort(id)
    db = pool(port, 'eyeler_fixture_books')
    observer = pool(port, 'eyeler_fixture_observer', 2)
    const end = Date.now() + 20_000
    while (true) {
      try {
        await observer.query('SELECT 1')
        break
      } catch (error) {
        if (Date.now() > end) throw error
        await pause(100)
      }
    }
    const migrations = (await readdir('database/migrations')).filter((name) => name.endsWith('.sql')).sort()
    for (const name of migrations) await observer.query(await readFile(`database/migrations/${name}`, 'utf8'))
    await proveBooks(db, observer)
    await proveBookOpening(db, observer, false)
    await proveBookOpening(db, observer, true)
    await proveTelegram(port, observer)
    await proveStrategyRecovery(db, observer)
    const outputs = await Promise.all(
      [1, 2].map(() =>
        run(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--allocator-worker', id!], {
          timeout: 30_000,
          windowsHide: true,
        }),
      ),
    )
    assert.deepEqual(outputs.map((value) => value.stdout.trim()).sort(), ['101', '102'])
    console.log('PASS request IDs are distinct across independent Node processes')
    for (const name of migrations) await observer.query(await readFile(`database/migrations/${name}`, 'utf8'))
    console.log('PASS all migrations rerun against existing fixture data')
  } finally {
    await db?.end()
    await observer?.end()
    if (id) {
      await fixturePort(id)
      await docker('rm', '--force', id)
    }
  }
}
