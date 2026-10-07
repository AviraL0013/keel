/** Read-only 20-block check for Exchange initialization logs at the configured start. */
import { toEventSelector, type AbiEvent } from 'viem'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.js'

const rpcUrl = process.env.EYELER_ANALYTICS_RPC_URL ?? ''
if (!rpcUrl) throw new Error('EYELER_ANALYTICS_RPC_URL_REQUIRED')
const exchange = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F'
let id = 0
async function rpc<T>(method: 'eth_blockNumber' | 'eth_getLogs', params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } }
  if (body.error || body.result === undefined) throw new Error(`RPC_${body.error?.code ?? 'EMPTY'}`)
  return body.result
}
if (!process.env.EYELER_ANALYTICS_START_BLOCK || !/^\d+$/.test(process.env.EYELER_ANALYTICS_START_BLOCK))
  throw new Error('EYELER_ANALYTICS_START_BLOCK_REQUIRED')
const start = BigInt(process.env.EYELER_ANALYTICS_START_BLOCK)
const head = BigInt(await rpc<string>('eth_blockNumber', []))
const topics = exchangeEvents
  .filter((event) => ['ExchangeInitialized', 'Initialized', 'Upgraded'].includes(event.name))
  .map((event) => toEventSelector(event as AbiEvent))
const logs = await rpc<Array<{ blockNumber: string; transactionHash: string; topics: string[] }>>('eth_getLogs', [
  {
    address: exchange,
    fromBlock: `0x${start.toString(16)}`,
    toBlock: `0x${(start + 19n < head ? start + 19n : head).toString(16)}`,
    topics: [topics],
  },
])
console.log(
  JSON.stringify({
    chainId: 143,
    exchange,
    head: head.toString(),
    start: start.toString(),
    initializationLogs: logs.map((log) => ({
      block: BigInt(log.blockNumber).toString(),
      transactionHash: log.transactionHash,
      topic: log.topics[0],
    })),
  }),
)
