/** Manual, read-only fetch of official Perpl ABI; generated output is reviewed and committed. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const url = 'https://raw.githubusercontent.com/PerplFoundation/dex-sdk/main/crates/sdk/abi/dex/Exchange.json'
const names = new Set([
  'AccountCreated',
  'CollateralDeposit',
  'CollateralWithdrawal',
  'MakerOrderFilled',
  'MakerOrderFilledV2',
  'TakerOrderFilled',
  'TakerOrderFilledV2',
  'PositionOpened',
  'PositionOpenedV2',
  'PositionIncreased',
  'PositionIncreasedV2',
  'PositionDecreased',
  'PositionClosed',
  'PositionLiquidated',
  'PositionInverted',
  'PositionDeleveraged',
  'PositionDeleveragedV2',
  'PositionUnwound',
  'PositionUnwoundV2',
  'FundingEventCompleted',
  'MarkUpdated',
  'PositionCollateralDecreased',
  'IncreasePositionCollateral',
  'ExchangeInitialized',
  'Initialized',
  'Upgraded',
])
const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
if (!response.ok) throw new Error(`ABI_HTTP_${response.status}`)
const raw = await response.text()
const sourceHash = createHash('sha256').update(raw).digest('hex')
const parsed = JSON.parse(raw) as { abi: Array<{ type: string; name?: string }> }
const events = parsed.abi.filter((entry) => entry.type === 'event' && entry.name && names.has(entry.name))
if (events.length !== names.size) throw new Error('ABI_EVENTS_MISSING')
const text = `// Official Perpl Exchange event entries: ${url}\n// Source SHA-256: ${sourceHash}\n// Generated 2026-10-07; review changes before updating.\nexport const exchangeEvents = ${JSON.stringify(events, null, 2)} as const\n`
await writeFile(new URL('../packages/analytics/src/exchange-events.ts', import.meta.url), text)
const readNames = new Set(['getAccountByAddr', 'getAccountById', 'getPositionV2'])
const reads = parsed.abi.filter((entry) => entry.type === 'function' && entry.name && readNames.has(entry.name))
if (reads.length !== readNames.size) throw new Error('ABI_READS_MISSING')
await writeFile(
  new URL('../packages/analytics/src/exchange-reads.ts', import.meta.url),
  `// Official Perpl Exchange view ABI: ${url}\n// Source SHA-256: ${sourceHash}\nexport const exchangeReads = ${JSON.stringify(reads, null, 2)} as const\n`,
)
console.log(`Captured ${events.length} events; source SHA-256 ${sourceHash}`)
