import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { StrategyOrders, type StrategyOrderRecord } from '../server/src/application/strategy-orders.js'
import { StrategyStore } from '../server/src/infrastructure/strategies/store.js'
import { StrategyOrderRecovery } from '../server/src/infrastructure/strategies/order-recovery.js'
import { PerplPreSubmissionError, type PerplOrder } from '../packages/perpl/src/trading.js'
import type { RuntimeVenue } from '../server/src/runtime.js'

async function fixture() {
  const { db, store } = await databaseFixture()
  const user = await store.ensureUser('0x0000000000000000000000000000000000000032')
  const other = await store.ensureUser('0x0000000000000000000000000000000000000033')
  const connection = randomUUID()
  await db.query(
    `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,expires_at)
    VALUES($1,$2,'testnet','trade','fixture','ACTIVE',now()+interval '1 day')`,
    [connection, user],
  )
  await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,642,true,false)', [
    connection,
  ])
  await db.query("INSERT INTO perpl_account_owners(environment,account_id,user_id) VALUES('testnet',642,$1)", [user])
  const strategy = (
    await db.query<{ id: string }>(
      `INSERT INTO strategies(user_id,connection_id,environment,account_id,market_id,
    mode,kind,capital,config,state,status,live_confirmed_at)
    VALUES($1,$2,'testnet',642,16,'LIVE','GRID',100,'{}','{}','RUNNING',now()) RETURNING id`,
      [user, connection],
    )
  ).rows[0].id as string
  const wire = vi.fn()
  let reference = '642:45'
  let expiry = 120
  let disconnect = false
  let intercepted = async (_id: string) => {}
  const verify = vi.fn(async (_intent: StrategyOrderRecord) => {})
  const row = async (id: string) =>
    (await db.query<StrategyOrderRecord>('SELECT * FROM strategy_orders WHERE id=$1', [id])).rows[0]!
  const submit = vi.fn(
    async (
      id: string,
      order: PerplOrder,
      beforeSend: (reference: string, lb: number) => Promise<void>,
      beforeVerify?: () => Promise<void>,
    ): Promise<{ venueReference: string; status: 'SUBMITTED' | 'CANCELED' }> => {
      await beforeSend(reference, expiry)
      const saved = await row(id)
      expect(saved).toMatchObject({
        status: 'SUBMITTING',
        request_id: '45',
        last_execution_block: 120,
        wire_order: order,
        simulated: false,
        strategy_id: strategy,
      })
      expect(saved.submitted_at).toBeTruthy()
      expect(saved.payload_hash).toMatch(/^[a-f0-9]{64}$/)
      try {
        await beforeVerify?.()
      } catch (error) {
        throw new PerplPreSubmissionError(error instanceof Error ? error.message : 'PRE_SEND_FAILED')
      }
      wire()
      await intercepted(id)
      if (disconnect) throw new Error('FAKE_DISCONNECT_AFTER_WRITE')
      return { venueReference: reference, status: 'SUBMITTED' as const }
    },
  )
  const scoped = {
    accountId: 642,
    connectionId: connection,
    submitStrategy: submit,
    ready: () => true,
  } as unknown as RuntimeVenue
  const venues = {
    forUser: async (owner: string, id?: string) => (owner === user && id === connection ? scoped : undefined),
  } as RuntimeVenue
  const options = { enabled: true, accountMode: 'per-user' as const, executionDisabled: false }
  const service = () => new StrategyOrders(store, venues, 'testnet', options, verify)
  const input = {
    idempotencyKey: randomUUID(),
    order: { acc: 642, mkt: 16, t: 1, p: 990, s: 100, lv: 100, fl: 1 as const, orderTtlBlocks: 20 },
    marketTerms: { priceDecimals: 1, sizeDecimals: 3 },
  }
  return {
    db,
    store,
    user,
    other,
    strategy,
    connection,
    service,
    input,
    wire,
    submit,
    verify,
    row,
    setReference: (value: string, lb = 120) => {
      reference = value
      expiry = lb
    },
    setDisconnect: () => {
      disconnect = true
    },
    intercept: (work: (id: string) => Promise<void>) => {
      intercepted = work
    },
    options,
  }
}

it('persists the exact intent before one fake write and never resends duplicate or restarted requests', async () => {
  const f = await fixture()
  try {
    const [first, duplicate] = await Promise.all([
      f.service().submit(f.user, f.strategy, f.input),
      f.service().submit(f.user, f.strategy, f.input),
    ])
    expect(duplicate.id).toBe(first.id)
    expect(first.status).toBe('UNKNOWN') // A socket acknowledgement is not execution proof.
    expect(await f.service().submit(f.user, f.strategy, f.input)).toMatchObject({ id: first.id })
    expect(await f.service().submit(f.user, f.strategy, f.input)).toMatchObject({ id: first.id })
    expect(f.wire).toHaveBeenCalledOnce()
    expect(f.submit).toHaveBeenCalledOnce()
    expect(first.size).toBe('0.100000000000000000')
    expect(first.price).toBe('99.000000000000000000')
    await expect(
      f.service().submit(f.user, f.strategy, {
        ...f.input,
        order: { ...f.input.order, p: 980 },
      }),
    ).rejects.toThrow('STRATEGY_IDEMPOTENCY_CONFLICT')
    expect(f.wire).toHaveBeenCalledOnce()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('refuses foreign ownership and all opening gates before reaching the fake transport', async () => {
  const f = await fixture()
  try {
    await expect(f.service().submit(f.other, f.strategy, f.input)).rejects.toThrow('STRATEGY_NOT_FOUND')
    for (const change of [{ enabled: false }, { accountMode: 'operator' as const }, { executionDisabled: true }]) {
      const service = new StrategyOrders(f.store, undefined, 'testnet', { ...f.options, ...change }, f.verify)
      await expect(service.submit(f.user, f.strategy, f.input)).rejects.toThrow('STRATEGY_SUBMISSION_DISABLED')
    }
    await expect(
      f.service().submit(f.user, f.strategy, {
        ...f.input,
        order: { ...f.input.order, acc: 643 },
      }),
    ).rejects.toThrow('STRATEGY_ORDER_BINDING_INVALID')
    await f.db.query("UPDATE perpl_connections SET status='REVOKED' WHERE id=$1", [f.connection])
    await expect(f.service().submit(f.user, f.strategy, f.input)).rejects.toThrow('STRATEGY_CONNECTION_UNAVAILABLE')
    expect(f.submit).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('accepts the canonical PostgreSQL bigint string before the fake socket write', async () => {
  const f = await fixture()
  try {
    f.submit.mockImplementationOnce(async (id, _order, beforeSend, verify) => {
      await beforeSend('642:45', 120)
      const saved = await f.row(id)
      // node-postgres int8 is text; PGlite's numeric result hid this defect.
      const query = vi
        .spyOn(f.store.pool, 'query')
        .mockResolvedValueOnce({ rows: [{ allowed: 1 }] } as never)
        .mockResolvedValueOnce({ rows: [{ ...saved, last_execution_block: '120' }] } as never)
        .mockResolvedValueOnce({ rows: [{ allowed: 1 }] } as never)
        .mockResolvedValueOnce({ rows: [{ ...saved, last_execution_block: '120' }] } as never)
      try {
        await verify?.()
      } finally {
        query.mockRestore()
      }
      f.wire()
      return { venueReference: '642:45', status: 'SUBMITTED' }
    })
    expect(await f.service().submit(f.user, f.strategy, f.input)).toMatchObject({ status: 'UNKNOWN', error: null })
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.wire).toHaveBeenCalledOnce()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('rejects invalid references and definite pre-send failures without a fake write', async () => {
  const f = await fixture()
  try {
    for (const [reference, expiry] of [
      ['643:45', 120],
      ['642:0', 120],
      ['642:45', 0],
    ] as const) {
      f.setReference(reference, expiry)
      const result = await f.service().submit(f.user, f.strategy, { ...f.input, idempotencyKey: randomUUID() })
      expect(result.status).toBe('FAILED')
    }
    f.setReference('642:45')
    f.verify.mockRejectedValueOnce(new Error('FAKE_ADMISSION_REFUSED'))
    const result = await f.service().submit(f.user, f.strategy, f.input)
    expect(result).toMatchObject({ status: 'FAILED', request_id: '45', error: 'FAKE_ADMISSION_REFUSED' })
    expect(f.wire).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('keeps ambiguous and late responses from overwriting durable recovery evidence', async () => {
  const f = await fixture()
  try {
    f.setDisconnect()
    const result = await f.service().submit(f.user, f.strategy, f.input)
    expect(result).toMatchObject({ status: 'UNKNOWN', request_id: '45', last_execution_block: 120 })
    await f.service().submit(f.user, f.strategy, f.input)
    expect(f.wire).toHaveBeenCalledOnce()
    f.setReference('642:46')
    f.intercept(async (id) => {
      await f.db.query("UPDATE strategy_orders SET status='FILLED' WHERE id=$1", [id])
    })
    // The second fake frame uses a fresh request; read assertion is adjusted for this case.
    f.submit.mockImplementationOnce(async (id, _order, beforeSend, verify) => {
      await beforeSend('642:46', 120)
      await verify?.()
      f.wire()
      await f.db.query("UPDATE strategy_orders SET status='FILLED' WHERE id=$1", [id])
      return { venueReference: '642:46', status: 'SUBMITTED' }
    })
    const late = await f.service().submit(f.user, f.strategy, { ...f.input, idempotencyKey: randomUUID() })
    expect(late.status).toBe('FILLED')
  } finally {
    await f.db.close()
  }
}, 30_000)

it('leaves a creator that crashed before submission unsent and keeps production LIVE start blocked', async () => {
  const f = await fixture()
  try {
    const prepared = await f.service().prepare(f.user, f.strategy, f.input)
    expect(prepared.status).toBe('QUEUED')
    expect((await f.service().submit(f.user, f.strategy, f.input)).id).toBe(prepared.id)
    expect(f.submit).not.toHaveBeenCalled()
    await f.db.query("UPDATE strategies SET status='PAUSED' WHERE id=$1", [f.strategy])
    await expect(new StrategyStore(f.store.pool, 'testnet').start(f.user, f.strategy)).rejects.toThrow(
      'STRATEGY_LIVE_WORKER_NOT_READY',
    )
  } finally {
    await f.db.close()
  }
}, 30_000)

it('blocks failed persistence and never marks another submitter reference as a definite failure', async () => {
  const f = await fixture()
  try {
    f.submit.mockImplementationOnce(async (_id, _order, beforeSend) => {
      const fault = vi.spyOn(f.store.pool, 'query').mockRejectedValueOnce(new Error('FAKE_PERSIST_FAILURE'))
      try {
        await beforeSend('642:45', 120)
      } finally {
        fault.mockRestore()
      }
      f.wire()
      return { venueReference: '642:45', status: 'SUBMITTED' }
    })
    expect((await f.service().submit(f.user, f.strategy, f.input)).status).toBe('FAILED')
    f.submit.mockImplementationOnce(async (id, _order, beforeSend) => {
      await f.db.query(
        "UPDATE strategy_orders SET status='SUBMITTING',request_id=44,last_execution_block=120 WHERE id=$1",
        [id],
      )
      await beforeSend('642:45', 120)
      f.wire()
      return { venueReference: '642:45', status: 'SUBMITTED' }
    })
    const loser = await f.service().submit(f.user, f.strategy, { ...f.input, idempotencyKey: randomUUID() })
    expect(loser).toMatchObject({ status: 'SUBMITTING', request_id: '44' })
    expect(f.wire).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('reauthorizes after persistence and rejects reference mutation before the fake write', async () => {
  const f = await fixture()
  try {
    f.submit.mockImplementationOnce(async (_id, _order, beforeSend, verify) => {
      await beforeSend('642:45', 120)
      await f.db.query("UPDATE perpl_connections SET status='REVOKED' WHERE id=$1", [f.connection])
      try {
        await verify?.()
      } catch (error) {
        throw new PerplPreSubmissionError((error as Error).message)
      }
      f.wire()
      return { venueReference: '642:45', status: 'SUBMITTED' }
    })
    expect((await f.service().submit(f.user, f.strategy, f.input)).status).toBe('FAILED')
    await f.db.query("UPDATE perpl_connections SET status='ACTIVE' WHERE id=$1", [f.connection])
    f.submit.mockImplementationOnce(async (id, _order, beforeSend, verify) => {
      await beforeSend('642:46', 120)
      await f.db.query('UPDATE strategy_orders SET request_id=47 WHERE id=$1', [id])
      try {
        await verify?.()
      } catch (error) {
        throw new PerplPreSubmissionError((error as Error).message)
      }
      f.wire()
      return { venueReference: '642:46', status: 'SUBMITTED' }
    })
    await f.service().submit(f.user, f.strategy, { ...f.input, idempotencyKey: randomUUID() })
    expect(f.wire).not.toHaveBeenCalled()
  } finally {
    await f.db.close()
  }
}, 30_000)

it('rechecks revocation, kill and reference changes after asynchronous admission', async () => {
  const f = await fixture()
  try {
    for (const kind of ['revocation', 'kill', 'expiry'] as const) {
      const reference = `642:${45 + ['revocation', 'kill', 'expiry'].indexOf(kind)}`
      f.submit.mockImplementationOnce(async (_id, _order, beforeSend, verify) => {
        await beforeSend(reference, 120)
        try {
          await verify?.()
        } catch (error) {
          throw new PerplPreSubmissionError((error as Error).message)
        }
        f.wire()
        return { venueReference: reference, status: 'SUBMITTED' }
      })
      f.verify.mockImplementationOnce(async (intent) => {
        if (kind === 'revocation')
          await f.db.query("UPDATE perpl_connections SET status='REVOKED' WHERE id=$1", [f.connection])
        else if (kind === 'kill')
          await f.db.query('INSERT INTO strategy_user_controls(user_id,killed) VALUES($1,true)', [f.user])
        else await f.db.query('UPDATE strategy_orders SET last_execution_block=121 WHERE id=$1', [intent.id])
      })
      expect((await f.service().submit(f.user, f.strategy, { ...f.input, idempotencyKey: randomUUID() })).status).toBe(
        'FAILED',
      )
      expect(f.wire).not.toHaveBeenCalled()
      await f.db.query("UPDATE perpl_connections SET status='ACTIVE' WHERE id=$1", [f.connection])
      await f.db.query('DELETE FROM strategy_user_controls WHERE user_id=$1', [f.user])
    }
  } finally {
    await f.db.close()
  }
}, 30_000)

it('derives cancellation identity only from an owned real POST and rejects forged targets', async () => {
  const f = await fixture()
  try {
    const posted = await f.service().submit(f.user, f.strategy, f.input)
    await f.db.query("UPDATE strategy_orders SET status='OPEN',venue_order_id=75 WHERE id=$1", [posted.id])
    const input = {
      idempotencyKey: randomUUID(),
      targetOrderId: posted.id,
      order: { acc: 642, mkt: 16, t: 5, s: 0, lv: 0, fl: 0 as const, orderTtlBlocks: 20 },
      marketTerms: f.input.marketTerms,
    }
    await expect(
      f.service().submit(f.user, f.strategy, { ...input, order: { ...input.order, oid: 76 } }),
    ).rejects.toThrow('STRATEGY_ORDER_TARGET_INVALID')
    const paper = randomUUID()
    await f.db.query(
      `INSERT INTO strategy_orders(id,strategy_id,environment,account_id,market_id,kind,simulated,status,
      side,price,size,venue_order_id,market_terms) VALUES($1,$2,'testnet',642,16,'POST',true,'OPEN','BUY',99,1,76,$3)`,
      [paper, f.strategy, JSON.stringify(f.input.marketTerms)],
    )
    await expect(f.service().submit(f.user, f.strategy, { ...input, targetOrderId: paper })).rejects.toThrow(
      'STRATEGY_ORDER_TARGET_INVALID',
    )
    f.submit.mockImplementationOnce(async (id, order, beforeSend, verify) => {
      expect(order.oid).toBe(75)
      await beforeSend('642:46', 120)
      await verify?.()
      f.wire()
      expect((await f.row(id)).target_order_id).toBe(posted.id)
      return { venueReference: '642:46', status: 'CANCELED' }
    })
    const canceled = await f.service().submit(f.user, f.strategy, input)
    expect(canceled.status).toBe('UNKNOWN')
    const recoveryVenue = {
      forUser: async () => ({
        accountId: 642,
        strategyOrderEvidence: async () => ({
          snapshotReady: true,
          snapshot: [],
          history: [{ acc: 642, mkt: 16, oid: 75, rq: '45', st: 5, sr: 0, t: 1, os: 100, fs: 0, at: { b: 110 } }],
        }),
      }),
    } as unknown as RuntimeVenue
    await new StrategyOrderRecovery(f.store.pool, recoveryVenue, 'testnet').recover()
    expect((await f.row(canceled.id)).status).toBe('CANCELED')
    expect(f.wire).toHaveBeenCalledTimes(2)
  } finally {
    await f.db.close()
  }
}, 30_000)
