/** Read-only mainnet decode smoke. Does not connect to a database. */
import { HyperSyncRollupSource } from '../server/src/infrastructure/analytics/hypersync-rollups.js'

const token = process.env.EYELER_HYPERSYNC_TOKEN
if (!token) throw new Error('EYELER_HYPERSYNC_TOKEN_REQUIRED')
const source = new HyperSyncRollupSource(token)
const head = await source.height()
const range = await source.readRange(head - 112, head - 12)
const owners = await source.readOwners(head - 100_012, head - 12)
console.log(
  JSON.stringify({
    chainId: 143,
    fromBlock: range.coverage.fromBlock.toString(),
    toBlock: range.coverage.toBlock.toString(),
    selectedLogs: range.coverage.logCount,
    hourlyBuckets: range.buckets.filter((bucket) => bucket.grain === 'hour').length,
    dailyBuckets: range.buckets.filter((bucket) => bucket.grain === 'day').length,
    distinctHourlyAccounts: range.actors.filter((actor) => actor.grain === 'hour').length,
    ownerEvents: owners.size,
  }),
)
