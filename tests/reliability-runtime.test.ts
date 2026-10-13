import { expect, it } from 'vitest'
import { SyntheticExecutionFixture } from '../scripts/reliability/chaos-fixture.js'
import { ExecutionWorker } from '../server/src/workers/execution-worker.js'

it('refused reliability admission cannot transmit an automatic Book action', async () => {
  const fixture = new SyntheticExecutionFixture()
  let frames = 0
  const worker = new ExecutionWorker(
    fixture.repository,
    {
      submit: async (_action, verify) => {
        await verify?.()
        frames++
        return { venueReference: '642:45', status: 'SUBMITTED' }
      },
      reconcile: async (action) => ({ ...action, status: 'CONFIRMED' }),
    },
    undefined,
    Date.now,
    () => false,
    async () => {
      throw Error('RELIABILITY_REFUSED')
    },
  )
  const decision = await worker.evaluate(fixture.book.id)
  const result = await worker.execute(decision)
  expect(frames).toBe(0)
  expect(result).toHaveProperty('status', 'FAILED')
})
