import { createHash } from 'node:crypto'
import type { PerplOrder } from '../../perpl/src/trading.js'

export type StrategyBuilderTerms = { builderId?: number | null; builderFeePer100K?: number }

/** Legacy absence means no builder proof. Partial or malformed terms never do.
 * The product submits zero builder fee even when enrollment permits more.
 */
export function validStrategyBuilderTerms(terms: StrategyBuilderTerms): boolean {
  const builder = Object.hasOwn(terms, 'builderId'),
    fee = Object.hasOwn(terms, 'builderFeePer100K')
  if (!builder && !fee) return true
  return (
    builder &&
    fee &&
    terms.builderFeePer100K === 0 &&
    (terms.builderId === null ||
      (Number.isSafeInteger(terms.builderId) && terms.builderId! >= 1 && terms.builderId! <= 255))
  )
}

/** PostgreSQL JSONB reorders keys; the durable identity must not depend on that order. */
export function strategyIntentHash(order: PerplOrder, terms: object, target: string | null) {
  const sorted = (value: object) => Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256')
    .update(JSON.stringify([sorted(order), sorted(terms), target]))
    .digest('hex')
}
