/** Read-only HyperSync timing run. Stores no logs and never prints credentials. */
import { performance } from 'node:perf_hooks'
import { toEventSelector } from 'viem'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.ts'

const endpoint = 'https://monad.hypersync.xyz'
const token = process.env.EYELER_HYPERSYNC_TOKEN
if (!token) throw new Error('EYELER_HYPERSYNC_TOKEN_REQUIRED')
const exchange = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F'
const allCount = process.argv.includes('--all-count')

async function query(body) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await fetch(`${endpoint}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)))
      continue
    }
    if (!response.ok) throw new Error(`HYPERSYNC_HTTP_${response.status}`)
    return response.json()
  }
  throw new Error('HYPERSYNC_RETRY_EXHAUSTED')
}

const heightResponse = await fetch(`${endpoint}/height`, { signal: AbortSignal.timeout(15_000) })
if (!heightResponse.ok) throw new Error(`HYPERSYNC_HEIGHT_HTTP_${heightResponse.status}`)
const { height } = await heightResponse.json()
const end = height - 12
const cutoff = Date.now() - 30 * 86_400_000

async function timestamp(number) {
  const result = await query({
    from_block: number,
    to_block: number + 1,
    blocks: [{}],
    field_selection: { block: ['timestamp'] },
  })
  const block = result.data?.flatMap((batch) => batch.blocks ?? [])[0]
  if (!block?.timestamp) throw new Error(`HYPERSYNC_BLOCK_TIME_MISSING_${number}`)
  const time = Number(block.timestamp)
  return time < 1e12 ? time * 1000 : time
}

let low = 54_773_010
let high = end
while (low < high) {
  const middle = Math.floor((low + high) / 2)
  if ((await timestamp(middle)) < cutoff) low = middle + 1
  else high = middle
}
const start = low
const startTime = new Date(await timestamp(start)).toISOString()
const endTime = new Date(await timestamp(end)).toISOString()
let count = 0
let pages = 0
let finished = 0
const selected = new Set([
  'AccountCreated',
  'CollateralDeposit',
  'CollateralWithdrawal',
  'MakerOrderFilled',
  'MakerOrderFilledV2',
  'TakerOrderFilled',
  'TakerOrderFilledV2',
  'PositionLiquidated',
  'PositionOpened',
  'PositionOpenedV2',
  'PositionIncreased',
  'PositionIncreasedV2',
  'PositionDecreased',
  'PositionClosed',
  'PositionInverted',
])
const topics = exchangeEvents.filter((event) => selected.has(event.name)).map((event) => toEventSelector(event))
const chunk = 100_000
const ranges = []
for (let from = start; from <= end; from += chunk) ranges.push([from, Math.min(end + 1, from + chunk)])
let nextRange = 0
const begun = performance.now()
async function worker() {
  while (nextRange < ranges.length) {
    const [from, to] = ranges[nextRange++]
    let cursor = from
    while (cursor < to) {
      const result = await query({
        from_block: cursor,
        to_block: to,
        logs: [allCount ? { address: [exchange] } : { address: [exchange], topics: [topics] }],
        field_selection: {
          log: allCount
            ? ['block_number']
            : [
                'block_number',
                'block_hash',
                'transaction_hash',
                'transaction_index',
                'log_index',
                'data',
                'topic0',
                'topic1',
                'topic2',
                'topic3',
              ],
        },
        join_mode: 'JoinNothing',
      })
      for (const batch of result.data ?? []) count += batch.logs?.length ?? 0
      pages++
      if (!Number.isInteger(result.next_block) || result.next_block <= cursor)
        throw new Error(`HYPERSYNC_CURSOR_STALLED_${cursor}`)
      cursor = result.next_block
    }
    finished++
    if (finished % 10 === 0)
      console.log(JSON.stringify({ ranges: finished, totalRanges: ranges.length, logs: count, pages }))
  }
}
await Promise.all(Array.from({ length: 12 }, () => worker()))
const seconds = (performance.now() - begun) / 1000
console.log(
  JSON.stringify({
    chainId: 143,
    exchange,
    scope: allCount ? 'all_exchange_signatures_count_only' : '15_metric_signatures_full_log_fields',
    startBlock: start,
    endBlock: end,
    startTime,
    endTime,
    topics: allCount ? null : topics.length,
    logs: count,
    pages,
    seconds: Number(seconds.toFixed(3)),
    logsPerSecond: Number((count / seconds).toFixed(1)),
  }),
)
