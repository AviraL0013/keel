import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { RollupRepository } from '../server/src/infrastructure/analytics/rollup-repository.js'

it('resolves known owners before inserting actors without rewriting rows, preserving owner precedence across batches', async () => {
  const db = new PGlite()
  try {
    for (const migration of ['020_analytics.sql', '021_analytics_rollups.sql', '037_analytics_rollup_owners.sql']) {
      await db.exec(await readFile(`database/migrations/${migration}`, 'utf8'))
    }
    await db.exec(`
      INSERT INTO analytics_accounts(account_id,address,created_block)
      VALUES(1,'account-one',54773010),(2,'account-two',54773010),(5,'account-five',54773010);
      INSERT INTO analytics_rollup_owner(account_id,owner_address)
      VALUES(1,'owner-one'),(2,'owner-two'),(3,'owner-three'),(5,'owner-five'),(505,'owner-last');
      CREATE TABLE actor_updates(account_id numeric NOT NULL);
      CREATE FUNCTION record_actor_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO actor_updates(account_id) VALUES(NEW.account_id);
        RETURN NEW;
      END $$;
      CREATE TRIGGER record_actor_update AFTER UPDATE ON analytics_rollup_actor
      FOR EACH ROW EXECUTE FUNCTION record_actor_update();
    `)
    const query = async (sql: string, values?: unknown[]) => {
      const result = await db.query<Record<string, unknown>>(sql, values)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    }
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
    const repo = new RollupRepository(pool)
    const range = {
      fromBlock: 100_000_000n,
      toBlock: 100_000_020n,
      fromTime: new Date('2026-10-10T12:00:00.000Z'),
      throughTime: new Date('2026-10-10T13:00:00.000Z'),
      endHash: `0x${'a'.repeat(64)}`,
      logCount: 505,
    }
    const actors = Array.from({ length: 505 }, (_, index) => ({
      grain: 'hour' as const,
      bucketStart: range.fromTime.toISOString(),
      accountId: String(index + 1),
      ownerAddress: index === 0 ? 'supplied-one' : index === 4 ? '' : null,
    }))

    await repo.saveRange(range, [], actors)

    const owners = await query(
      `SELECT account_id::text,owner_address FROM analytics_rollup_actor
       WHERE account_id IN (1,2,3,4,5,505) ORDER BY account_id`,
    )
    expect(owners.rows).toEqual([
      { account_id: '1', owner_address: 'supplied-one' },
      { account_id: '2', owner_address: 'account-two' },
      { account_id: '3', owner_address: 'owner-three' },
      { account_id: '4', owner_address: null },
      { account_id: '5', owner_address: '' },
      { account_id: '505', owner_address: 'owner-last' },
    ])
    expect((await query('SELECT count(*) AS count FROM analytics_rollup_actor')).rows[0].count).toBe(505)
    expect((await query('SELECT count(*) AS count FROM actor_updates')).rows[0].count).toBe(0)

    await repo.applyOwners(new Map([['4', 'owner-four']]), 100_000_021)
    expect((await query('SELECT owner_address FROM analytics_rollup_actor WHERE account_id=4')).rows).toEqual([
      { owner_address: 'owner-four' },
    ])
    expect((await query('SELECT account_id::text FROM actor_updates')).rows).toEqual([{ account_id: '4' }])
  } finally {
    await db.close()
  }
}, 30_000)
