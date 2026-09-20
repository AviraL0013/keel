import type { Book, RiskFeatures } from '../../domain/src/index.js'
export type PolicyResult = { permitted: boolean; codes: string[]; reasons: string[] }
export function applyBookPolicy(book: Book, features: RiskFeatures, proposedAmount: number, reserveAvailable = features.reserveHeadroom): PolicyResult {
  const codes: string[] = []; const reasons: string[] = []
  if (!book.automationEnabled || book.status === 'PAUSED' || book.status === 'CLOSED') { codes.push('AUTOMATION_PAUSED'); reasons.push('Automation is paused for this Book.') }
  if (book.stance === 'KILL') { codes.push('USER_KILL'); reasons.push('Kill stance prohibits rescue.') }
  if (book.stance === 'HARVEST' && proposedAmount > 0) { codes.push('HARVEST_NO_RESCUE'); reasons.push('Harvest stance does not permit collateral rescue.') }
  if (!Number.isFinite(proposedAmount) || proposedAmount < 0) { codes.push('INVALID_AMOUNT'); reasons.push('Proposed action amount is invalid.') }
  if (proposedAmount > book.defenseCap || proposedAmount > reserveAvailable) { codes.push('CAP_EXCEEDED'); reasons.push('Proposed defense exceeds permitted reserve headroom.') }
  if (features.timeRemainingMs <= 0) { codes.push('TIME_LIMIT'); reasons.push('Book time limit has expired.') }
  return { permitted: codes.length === 0, codes, reasons }
}
