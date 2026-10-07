/** Capture a small, public Monad mainnet log sample for offline decoder tests. */
import { writeFile } from 'node:fs/promises'
import { toEventSelector, type AbiEvent } from 'viem'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.js'

const rpcUrl = process.env.EYELER_ANALYTICS_RPC_URL
if (!rpcUrl) throw new Error('EYELER_ANALYTICS_RPC_URL_REQUIRED')
const exchange = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F'
let nextId = 0
async function rpc<T>(
  method: 'eth_blockNumber' | 'eth_getLogs' | 'eth_getBlockByNumber',
  params: unknown[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } }
  if (body.error || body.result === undefined)
    throw new Error(`RPC_${body.error?.code ?? 'EMPTY'}: ${body.error?.message ?? ''}`)
  return body.result
}

const names = new Set([
  'AccountCreated',
  'CollateralDeposit',
  'CollateralWithdrawal',
  'PositionOpenedV2',
  'PositionIncreasedV2',
  'PositionDecreased',
  'PositionClosed',
  'PositionLiquidated',
  'MakerOrderFilledV2',
])
const topics = exchangeEvents
  .filter((event) => names.has(event.name))
  .map((event) => toEventSelector(event as AbiEvent))
const head = BigInt(await rpc<string>('eth_blockNumber', []))
const logs: Array<Record<string, unknown>> = []
for (let end = head - 20n; end > head - 2000n && logs.length < 12; end -= 20n) {
  const start = end - 19n
  const page = await rpc<Array<Record<string, unknown>>>('eth_getLogs', [
    {
      address: exchange,
      fromBlock: `0x${start.toString(16)}`,
      toBlock: `0x${end.toString(16)}`,
      topics: [topics],
    },
  ])
  logs.push(...page.slice(0, Math.max(0, 12 - logs.length)))
}
if (!logs.length) throw new Error('NO_MAINNET_LOGS_IN_SAMPLE_WINDOW')
const blocks: Record<string, string> = {}
for (const hex of new Set(logs.map((log) => String(log.blockNumber)))) {
  const block = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [hex, false])
  blocks[hex] = block.timestamp
}
const fixture = { capturedAt: new Date().toISOString(), chainId: 143, exchange, head: head.toString(), blocks, logs }
await writeFile(
  new URL('../packages/analytics/fixtures/mainnet-logs.json', import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`,
)
console.log(`Captured ${logs.length} public logs across ${Object.keys(blocks).length} blocks at head ${head}`)
