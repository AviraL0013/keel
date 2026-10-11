import { describe, expect, it } from 'vitest'
import { HyperSyncRequestPacer } from '../server/src/infrastructure/analytics/hypersync-pacer.js'
import { HyperSyncRollupSource } from '../server/src/infrastructure/analytics/hypersync-rollups.js'
import { HyperSyncHttp } from '../server/src/infrastructure/analytics/wallet-ondemand.js'

describe('HyperSync free-tier pacing', () => {
  it('defaults below the 15 requests per minute ceiling', async () => {
    let now = 0
    const pacer = new HyperSyncRequestPacer(
      undefined,
      () => now,
      async (ms) => {
        now += ms
      },
    )
    await Promise.all([pacer.wait(), pacer.wait()])
    expect(now).toBe(4_200)
  })

  it('spaces concurrent requests from the rollup and wallet readers', async () => {
    let now = 0
    const waits: number[] = []
    const starts: number[] = []
    const pacer = new HyperSyncRequestPacer(
      5_000,
      () => now,
      async (ms) => {
        waits.push(ms)
        now += ms
      },
    )
    const fetcher = async () => {
      starts.push(now)
      return new Response(JSON.stringify({ next_block: 2, data: [] }), { status: 200 })
    }
    const wallet = new HyperSyncHttp('test-token', 'https://monad.hypersync.xyz', fetcher, pacer)
    const rollup = new HyperSyncRollupSource('test-token', fetcher, pacer)
    await Promise.all([wallet.query(1, 2), rollup.readOwners(1, 2)])
    expect(starts).toEqual([0, 5_000])
    expect(waits).toEqual([5_000])
  })

  it('counts height reads against the same request budget', async () => {
    let now = 0
    const starts: number[] = []
    const pacer = new HyperSyncRequestPacer(
      5_000,
      () => now,
      async (ms) => {
        now += ms
      },
    )
    const fetcher = async (url: string) => {
      starts.push(now)
      return new Response(JSON.stringify(url.endsWith('/height') ? { height: 2 } : { data: [] }))
    }
    const wallet = new HyperSyncHttp('test-token', 'https://monad.hypersync.xyz', fetcher, pacer)
    const rollup = new HyperSyncRollupSource('test-token', fetcher, pacer)
    await Promise.all([wallet.height(), rollup.height()])
    expect(starts).toEqual([0, 5_000])
  })

  it('holds all queued readers for at least a minute after HTTP 429', async () => {
    let now = 0
    const pacer = new HyperSyncRequestPacer(
      5_000,
      () => now,
      async (ms) => {
        now += ms
      },
    )
    await pacer.wait()
    pacer.cooldown(60_000)
    await pacer.wait()
    expect(now).toBe(60_000)
  })
})
