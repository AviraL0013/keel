/** Offline cached-route p95 check; exercises Fastify serialization without internet. */
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import Fastify from 'fastify'
import { PerplPublicAnalytics } from '../server/src/infrastructure/analytics/perpl-public.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'

const fixture = JSON.parse(await readFile('packages/analytics/fixtures/mainnet-public.json', 'utf8')) as {
  context: unknown
}
const fetcher = async () => new Response(JSON.stringify(fixture.context), { status: 200 })
const app = Fastify()
registerAnalyticsRoutes(app, null, {
  publicData: new PerplPublicAnalytics('https://fixture.invalid/api', fetcher as typeof fetch),
})
await app.ready()
try {
  await app.inject('/analytics/v1/markets')
  const samples: number[] = []
  for (let batch = 0; batch < 20; batch++) {
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const start = performance.now()
        const response = await app.inject('/analytics/v1/markets')
        if (response.statusCode !== 200) throw new Error(`LOAD_HTTP_${response.statusCode}`)
        samples.push(performance.now() - start)
      }),
    )
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
  console.log(
    JSON.stringify({
      route: '/analytics/v1/markets',
      requests: samples.length,
      concurrency: 20,
      p95Ms: Number(p95.toFixed(2)),
      targetMs: 250,
      pass: p95 < 250,
    }),
  )
  if (p95 >= 250) process.exitCode = 1
} finally {
  await app.close()
}
