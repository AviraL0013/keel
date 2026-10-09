/** Read-only local verification of public market stats, wallet views and recent Exchange logs. */
import { toEventSelector, type AbiEvent } from 'viem'
import { formatMoney } from '../packages/ausd/src/money.js'
import { deriveEvent } from '../packages/analytics/src/aggregate.js'
import { decodeExchangeLog, EXCHANGE, type ChainLog } from '../packages/analytics/src/decoder.js'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.js'
import { PerplPublicAnalytics, marketSummary } from '../server/src/infrastructure/analytics/perpl-public.js'
import { WalletChainAnalytics } from '../server/src/infrastructure/analytics/wallet-chain.js'

const publicData = new PerplPublicAnalytics()
const ctx = await publicData.context()
const markets = publicData.precision(ctx.value)
const btc = ctx.value.markets.find((market) => market.id === 1)!
const end = Date.now()
const start = end - 24 * 60 * 60 * 1000
const candles = await publicData.volumeCandles(btc, '1h', start, end)
const candleMicros = candles.reduce((sum, candle) => sum + candle.micros, 0n)
const walletAddress = '0x5D8FfA5F7c6A42470B4eC61a8CdAbB799fd3765A'
const rpcUrl = process.env.EYELER_ANALYTICS_RPC_URL
if (!rpcUrl) throw new Error('EYELER_ANALYTICS_RPC_URL_REQUIRED')
const profile = await new WalletChainAnalytics(rpcUrl).profile(walletAddress, ctx.value)
if (!profile) throw new Error('MAINNET_WALLET_NOT_FOUND')
const headResponse = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  signal: AbortSignal.timeout(20_000),
})
if (!headResponse.ok) throw new Error(`RPC_HTTP_${headResponse.status}`)
const head = BigInt(((await headResponse.json()) as { result: string }).result)
const fromBlock = head - 32n
const toBlock = head - 12n
const topics = exchangeEvents.map((event) => toEventSelector(event as AbiEvent))
const logsResponse = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'eth_getLogs',
    params: [
      {
        address: EXCHANGE,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        topics: [topics],
      },
    ],
  }),
  signal: AbortSignal.timeout(20_000),
})
if (!logsResponse.ok) throw new Error(`RPC_HTTP_${logsResponse.status}`)
const body = (await logsResponse.json()) as { result?: ChainLog[]; error?: { code: number; message: string } }
if (body.error || !body.result) throw new Error(`RPC_${body.error?.code ?? 'EMPTY'}`)
const derived = body.result
  .map(decodeExchangeLog)
  .filter((event) => event !== null)
  .map((event) => deriveEvent(event, markets))
  .filter((event) => event !== null)
console.log(
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    contextBlock: ctx.block,
    btc24hContextVolume: marketSummary(btc).volume24h,
    btc24hCandleVolume: formatMoney(candleMicros),
    btcCandleCount: candles.length,
    walletBlock: profile.block,
    walletBalance: profile.data.margin.balance,
    walletOpenPositions: profile.data.positions.length,
    recentBlocks: [fromBlock.toString(), toBlock.toString()],
    recentRawLogs: body.result.length,
    recentDerivedFills: derived.filter((event) => event.kind === 'fill').length,
    recentDerivedFlows: derived.filter((event) => event.kind === 'flow').length,
  }),
)
