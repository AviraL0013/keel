import type { Book, RiskFeatures } from '../../domain/src/index.js'
import { moneyMicros } from '../../ausd/src/money.js'
export type PolicyResult = { permitted: boolean; codes: string[]; reasons: string[] }
export type PolicyMode = 'AUTOMATED' | 'MANUAL'
export function applyBookPolicy(
  book: Book,
  features: RiskFeatures,
  proposedAmount: number,
  reserveAvailable = features.reserveHeadroom,
  mode: PolicyMode = 'AUTOMATED',
): PolicyResult {
  const codes: string[] = []
  const reasons: string[] = []
  if (mode === 'AUTOMATED' && !book.automationEnabled) {
    codes.push('AUTOMATION_PAUSED')
    reasons.push('Automation is paused for this Book.')
  }
  if (book.status === 'PAUSED' || book.status === 'CLOSED' || book.status === 'SAFE_MODE') {
    codes.push('BOOK_NOT_ACTIVE')
    reasons.push('Book is not active for execution.')
  }
  if (book.stance === 'KILL') {
    codes.push('USER_KILL')
    reasons.push('Kill stance prohibits rescue.')
  }
  if (book.stance === 'HARVEST' && proposedAmount > 0) {
    codes.push('HARVEST_NO_RESCUE')
    reasons.push('Harvest stance does not permit collateral rescue.')
  }
  let proposedMicros: bigint | null = null
  try {
    proposedMicros = moneyMicros(proposedAmount)
  } catch {
    // Invalid money is a policy refusal, never an execution authorization.
  }
  if (proposedMicros === null) {
    codes.push('INVALID_AMOUNT')
    reasons.push('Proposed action amount is invalid.')
  }
  let withinCap = false
  try {
    withinCap =
      proposedMicros !== null &&
      proposedMicros <= moneyMicros(book.defenseCap) &&
      proposedMicros <= moneyMicros(reserveAvailable)
  } catch {
    withinCap = false
  }
  if (!withinCap) {
    codes.push('CAP_EXCEEDED')
    reasons.push('Proposed defense exceeds permitted reserve headroom.')
  }
  if (features.timeRemainingMs <= 0) {
    codes.push('TIME_LIMIT')
    reasons.push('Book time limit has expired.')
  }
  return { permitted: codes.length === 0, codes, reasons }
}
