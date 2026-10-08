import { writeFile, mkdir } from 'node:fs/promises'
import { captureStrategyWindow } from '../packages/strategies/src/recording.js'

const days = Number(process.argv[2] ?? '30')
if (!Number.isSafeInteger(days) || days < 2 || days > 30) throw Error('RECORDING_DAYS_INVALID')
const to = Math.floor(Date.now() / 3_600_000) * 3_600_000
try {
  const fixture = await captureStrategyWindow(to - days * 86_400_000, to)
  await mkdir('reports/strategies', { recursive: true })
  const output = `reports/strategies/perpl-btc-${fixture.candles[0]!.t}-${to}.json`
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(
    JSON.stringify({
      output,
      candles: fixture.candles.length,
      funding: fixture.funding.length,
      capturedAt: fixture.retrievedAt,
    }),
  )
} catch (error) {
  // Public fixed-origin transport errors are reduced to codes; never print URLs from an exception.
  const code =
    error instanceof Error && /^PERPL_RECORDING_[A-Z_]+(?:_\d+)?$/.test(error.message)
      ? error.message
      : 'PUBLIC_RECORDING_FAILED'
  console.error(code)
  process.exitCode = 1
}
