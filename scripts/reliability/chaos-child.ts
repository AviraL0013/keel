import { SyntheticExecutionFixture } from './chaos-fixture.js'
import { ExecutionWorker } from '../../server/src/workers/execution-worker.js'

// Parent supplies only a disposable synthetic ledger path. This child never reads credentials or opens a socket.
const path = process.argv[2]
if (!path || !process.send) process.exit(2)
const fixture = new SyntheticExecutionFixture(path)
const worker = new ExecutionWorker(
  fixture.repository,
  {
    submit: async (action, verify) => {
      await verify?.()
      fixture.ledger.orderIds.push(action.id)
      await fixture.repository.saveAction({ ...action, status: 'SUBMITTING', venueReference: '642:45' })
      process.send?.({ event: 'synthetic-send-persisted' })
      return new Promise(() => {
        setInterval(() => undefined, 1000)
      })
    },
    reconcile: async (action) => action,
  },
  undefined,
  Date.now,
  () => false,
)
await worker.execute(await worker.evaluate(fixture.book.id))
