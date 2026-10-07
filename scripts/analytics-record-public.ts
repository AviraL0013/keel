/** Capture public, unsigned Perpl responses for offline analytics tests. */
import { writeFile } from 'node:fs/promises'
const base = 'https://app.perpl.xyz/api'
async function read(path: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`PERPL_HTTP_${response.status}`)
  return response.json()
}
const context = await read('/v1/pub/context')
const now = Date.now()
const from = now - 24 * 60 * 60 * 1000
const [funding, candles] = await Promise.all([
  read(`/v1/market-data/1/funding/${from}-${now}`),
  read(`/v1/market-data/1/candles/3600/${from}-${now}`),
])
const fixture = { capturedAt: new Date().toISOString(), context, funding, candles }
await writeFile(
  new URL('../packages/analytics/fixtures/mainnet-public.json', import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`,
)
console.log('Captured unsigned context, BTC funding and BTC hourly candles')
