import { createHash } from 'node:crypto'
import type { PerplOrder } from '../../perpl/src/trading.js'

/** PostgreSQL JSONB reorders keys; the durable identity must not depend on that order. */
export function strategyIntentHash(order: PerplOrder, terms: object, target: string | null) {
  const sorted = (value: object) => Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256')
    .update(JSON.stringify([sorted(order), sorted(terms), target]))
    .digest('hex')
}
