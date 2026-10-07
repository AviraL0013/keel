/** Record public view-call evidence for one account observed in mainnet log fixture. */
import { writeFile } from 'node:fs/promises'
import { createPublicClient, http } from 'viem'
import { monad } from 'viem/chains'
import { EXCHANGE } from '../packages/analytics/src/decoder.js'
import { exchangeReads } from '../packages/analytics/src/exchange-reads.js'

const rpcUrl = process.env.EYELER_ANALYTICS_RPC_URL
if (!rpcUrl) throw new Error('EYELER_ANALYTICS_RPC_URL_REQUIRED')
const client = createPublicClient({
  chain: monad,
  transport: http(rpcUrl, { timeout: 20_000, retryCount: 0 }),
})
const blockNumber = (await client.getBlockNumber()) - 12n
const account = await client.readContract({
  address: EXCHANGE,
  abi: exchangeReads,
  functionName: 'getAccountById',
  args: [25n],
  blockNumber,
})
if (account.accountId !== 25n || account.accountAddr === '0x0000000000000000000000000000000000000000')
  throw new Error('ACCOUNT_VIEW_MISMATCH')
const position = await client.readContract({
  address: EXCHANGE,
  abi: exchangeReads,
  functionName: 'getPositionV2',
  args: [100n, 25n],
  blockNumber,
})
const byAddress = await client.readContract({
  address: EXCHANGE,
  abi: exchangeReads,
  functionName: 'getAccountByAddr',
  args: [account.accountAddr],
  blockNumber,
})
if (byAddress.accountId !== account.accountId) throw new Error('ACCOUNT_ADDRESS_MISMATCH')
const fixture = { capturedAt: new Date().toISOString(), blockNumber: blockNumber.toString(), account, position }
await writeFile(
  new URL('../packages/analytics/fixtures/mainnet-wallet.json', import.meta.url),
  `${JSON.stringify(fixture, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
)
console.log(`Captured public account ${account.accountId} at finalized block ${blockNumber}`)
