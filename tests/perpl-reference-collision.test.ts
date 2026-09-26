import { describe, expect, it, vi } from 'vitest'
import { PerplLiveAdapter } from '../packages/perpl/src/live.js'
import type { Action } from '../packages/domain/src/index.js'

describe('ambiguous Perpl request ID', () => {
  it('never reconciles two actions from the same account against one request ID', async () => {
    const context = vi.fn(async () => { throw new Error('CONTEXT_SHOULD_NOT_BE_READ') })
    const evidence = vi.fn(async () => { throw new Error('HISTORY_SHOULD_NOT_BE_READ') })
    const live = new PerplLiveAdapter({} as never, context, { evidence } as never, async () => undefined, async () => undefined, async () => true)
    const action = { id: 'second', venueReference: '642:1', status: 'UNKNOWN', error: 'VENUE_OUTCOME_PENDING' } as Action
    expect(await live.reconcile(action)).toMatchObject({ id: 'second', status: 'UNKNOWN', error: 'VENUE_REFERENCE_COLLISION' })
    expect(context).not.toHaveBeenCalled()
    expect(evidence).not.toHaveBeenCalled()
  })
})
