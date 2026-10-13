import { expect, it } from 'vitest'
import { readWalletActivity } from '../server/src/infrastructure/analytics/wallet-activity.js'
import { databaseFixture } from './helpers/database.js'

it('counts only settled activity from current account IDs and withholds incomplete totals', async () => {
  const db = await databaseFixture()
  try {
    const day = 86_400_000
    const to = Math.floor(Date.now() / day) * day
    const from = to - 30 * day
    await db.store.pool.query(
      `INSERT INTO analytics_rollup_coverage(from_block,to_block,from_time,through_time,end_hash,log_count)
       VALUES(54773010,54773110,$1,$2,$3,1)`,
      [new Date(from), new Date(to), `0x${'a'.repeat(64)}`],
    )
    await db.store.pool.query(
      `INSERT INTO analytics_rollup_actor(from_block,to_block,grain,bucket_start,account_id,owner_address)
       VALUES(54773010,54773110,'day',$1,5438,$2),
             (54773010,54773110,'day',$1,9999,$3)`,
      [new Date(to - day), '0x1234567890abcdef1234567890abcdef12345678', '0x9999999999999999999999999999999999999999'],
    )
    const complete = await readWalletActivity(db.store.pool, ['5438'], to + day / 2)
    expect(complete.verifiedDays).toBe(30)
    expect(complete.activeDays).toBe(1)
    expect(complete.points.at(-1)?.value).toBe('1')
    expect(complete.points[0]?.value).toBe('0')
    const other = await readWalletActivity(db.store.pool, ['1234'], to + day / 2)
    expect(other.activeDays).toBe(0)
    await db.store.pool.query('UPDATE analytics_rollup_coverage SET from_time=$1', [new Date(from + day)])
    const partial = await readWalletActivity(db.store.pool, ['5438'], to + day / 2)
    expect(partial.verifiedDays).toBe(29)
    expect(partial.activeDays).toBeNull()
    expect(partial.points[0]?.value).toBeNull()
  } finally {
    await db.db.close()
  }
}, 30_000)
