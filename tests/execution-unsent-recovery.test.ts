import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { Action } from '../packages/domain/src/index.js'
import { databaseFixture } from './helpers/database.js'
import { PostgresExecutionRepository } from '../server/src/infrastructure/database/execution-repository.js'

it('reclaims only fenced, aged, unreferenced preparation; stale writers cannot revive it', async () => {
  const { db, store } = await databaseFixture()
  const repo = new PostgresExecutionRepository(store)
  try {
    const owner = await store.ensureUser('offline-recovery-owner')
    const seed = async (status: Action['status'], protocol: boolean, reference?: string, fresh = false) => {
      const book = (
        await db.query(
          "INSERT INTO books(user_id,market,side,stance,liquidation_floor,defense_cap,time_limit_ms,automation_enabled) VALUES($1,'BTC','LONG','DEFEND',6,5,3600000,true) RETURNING id",
          [owner],
        )
      ).rows[0]
      const decision = (
        await db.query(
          "INSERT INTO decisions(book_id,state,action,reason_codes,human_readable_reasons,risk_features,created_at) VALUES($1,'DEFEND','DEFEND','[]','[]','{}',$2) RETURNING id",
          [book.id, new Date(Date.now() - (fresh ? 0 : 240_000)).toISOString()],
        )
      ).rows[0]
      const action: Action = {
        id: randomUUID(),
        bookId: String(book.id),
        decisionId: String(decision.id),
        kind: 'DEFEND',
        amount: 1,
        status,
        idempotencyKey: randomUUID(),
        venueReference: reference,
      }
      await repo.saveAction(action)
      if (protocol)
        await db.query('UPDATE actions SET before_state=$2 WHERE id=$1', [
          action.id,
          JSON.stringify({ submissionProtocol: 'DURABLE_BOUND_V1' }),
        ])
      return action
    }
    for (const status of ['QUEUED', 'VALIDATING', 'SUBMITTING'] as const) {
      const pending = await seed(status, true)
      const reclaimed = await repo.reclaimUnsentAction(pending.id, new Date(Date.now() - 180_000))
      expect(reclaimed).toMatchObject({ status: 'FAILED', error: 'EXECUTION_INTERRUPTED_BEFORE_SEND' })
      expect(await store.getBook(owner, pending.bookId)).toMatchObject({ status: 'PAUSED', automationEnabled: false })
      await expect(repo.saveAction({ ...pending, status: 'SUBMITTING' })).rejects.toThrow('ACTION_STATE_CHANGED')
      const staleFinalization = await repo.finalize({ ...pending, status: 'UNKNOWN', error: 'LATE_SENDER_RESPONSE' })
      expect(staleFinalization).toMatchObject({ status: 'FAILED', error: 'EXECUTION_INTERRUPTED_BEFORE_SEND' })
      expect(await repo.finalize({ ...pending, status: 'CONFIRMED' })).toMatchObject({
        status: 'FAILED',
        error: 'EXECUTION_INTERRUPTED_BEFORE_SEND',
      })
      expect(await store.getBook(owner, pending.bookId)).toMatchObject({ status: 'PAUSED', automationEnabled: false })
      // The real before-send CAS cannot persist a reference for this stale sender.
      expect(
        (
          await db.query(
            "UPDATE actions SET venue_reference='642:45' WHERE id=$1 AND status='SUBMITTING' AND venue_reference IS NULL RETURNING id",
            [pending.id],
          )
        ).rows,
      ).toHaveLength(0)
      expect(await store.listAutopsy(owner, pending.bookId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'EXECUTION_INTERRUPTED_BEFORE_SEND' })]),
      )
    }
    const cutoff = new Date(Date.now() - 180_000)
    for (const pending of [
      await seed('SUBMITTING', true, undefined, true),
      await seed('SUBMITTING', false), // Old sender protocol is not safe to reclaim.
      await seed('SUBMITTING', true, '642:45'),
      await seed('UNKNOWN', true),
      await seed('PARTIAL', true),
    ])
      expect(await repo.reclaimUnsentAction(pending.id, cutoff)).toBeNull()
  } finally {
    await db.close()
  }
}, 20_000)
