import type { Book } from '../../packages/domain/src/index.js'

export type BookControls = { automationEnabled?: boolean; status?: Book['status']; stance?: Book['stance'] }

export function validateBookControls(book: Book, patch: BookControls) {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !['automationEnabled', 'status', 'stance'].includes(key))) throw new Error('INVALID_BOOK_CONTROLS')
  if (patch.automationEnabled !== undefined && typeof patch.automationEnabled !== 'boolean') throw new Error('INVALID_BOOK_CONTROLS')
  if (patch.status !== undefined && !['ACTIVE', 'PAUSED', 'SAFE_MODE', 'CLOSED'].includes(patch.status)) throw new Error('INVALID_BOOK_CONTROLS')
  if (patch.stance !== undefined && !['DEFEND', 'HARVEST', 'KILL'].includes(patch.stance)) throw new Error('INVALID_BOOK_CONTROLS')
  if (book.status === 'CLOSED' && (patch.automationEnabled === true || (patch.status !== undefined && patch.status !== 'CLOSED'))) throw new Error('INVALID_BOOK_STATUS_TRANSITION')
  if (book.status === 'SAFE_MODE' && (patch.automationEnabled === true || patch.status === 'ACTIVE')) throw new Error('INVALID_BOOK_STATUS_TRANSITION')
  if (patch.status === 'CLOSED' && book.status !== 'CLOSED') throw new Error('INVALID_BOOK_STATUS_TRANSITION')
}
