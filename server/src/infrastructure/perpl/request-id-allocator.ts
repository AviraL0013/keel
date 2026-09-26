import type { Pool } from 'pg'
import { nextForwardedRequestId, requestId } from '../../../../packages/perpl/src/request-id.js'

/** PostgreSQL row lock serializes reservations for one Perpl account across workers. */
export class PerplRequestIdAllocator {
  constructor(private readonly pool: Pool) {}

  async allocate(accountId: number, venueLfr: string, rejectedForwardedRq = '0'): Promise<string> {
    const lfr = requestId(venueLfr)
    const rejected = requestId(rejectedForwardedRq)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO perpl_request_ids(account_id,last_rq) VALUES($1,0) ON CONFLICT DO NOTHING', [accountId])
      const counter = await client.query('SELECT last_rq FROM perpl_request_ids WHERE account_id=$1 FOR UPDATE', [accountId])
      const actions = await client.query('SELECT venue_reference FROM actions WHERE venue_reference LIKE $1', [`${accountId}:%`])
      let highest = lfr
      // Preserve a known forwarded rejection even after a local database reset.
      // Direct/on-chain order-history IDs are never used as an API high-water mark.
      if (rejected > highest) highest = rejected
      const durable = requestId(String(counter.rows[0].last_rq))
      if (durable > highest) highest = durable
      for (const row of actions.rows as Array<{ venue_reference: string }>) {
        const rq = row.venue_reference.split(':')[1]
        if (!rq) continue
        const prior = requestId(rq)
        if (prior > highest) highest = prior
      }
      const selected = nextForwardedRequestId(lfr.toString(), highest.toString())
      await client.query('UPDATE perpl_request_ids SET last_rq=$2 WHERE account_id=$1', [accountId, selected])
      await client.query('COMMIT')
      return selected
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
}
