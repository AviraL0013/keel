import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { AnalyticsIndexer } from '../server/src/workers/analytics-indexer.js'
import { AnalyticsRepository } from '../server/src/infrastructure/analytics/repository.js'
import { databaseFixture } from './helpers/database.js'
import type { ChainLog } from '../packages/analytics/src/decoder.js'

const sample = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-logs.json', 'utf8')) as {
  logs: ChainLog[]
  blocks: Record<string, string>
}
const context = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')).context
const start = sample.logs.reduce(
  (min, l) => (BigInt(l.blockNumber) < min ? BigInt(l.blockNumber) : min),
  BigInt(sample.logs[0].blockNumber),
)
const end = start + 999n
const config = {
  databaseUrl: ':memory:',
  rpcUrl: 'https://fake.invalid',
  perplApiUrl: 'https://fake.invalid/api',
  startBlock: start,
  historyVerified: false,
  confirmationDepth: 12n,
  chunkSize: 20n,
  pollMs: 1000,
}

function provider() {
  let failAt: bigint | null = null,
    chain = 143,
    reorg = false,
    racing = false,
    endReads = 0
  const calls: string[] = []
  const transport = async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith('/v1/pub/context')) return Response.json(context)
    const request = JSON.parse(String(init?.body))
    calls.push(request.method)
    let result: unknown
    if (request.method === 'eth_chainId') result = `0x${chain.toString(16)}`
    else if (request.method === 'eth_blockNumber') result = `0x${(end + 12n).toString(16)}`
    else if (request.method === 'eth_getLogs') {
      const low = BigInt(request.params[0].fromBlock),
        high = BigInt(request.params[0].toBlock)
      if (failAt === low) return new Response('fixture failure', { status: 503 })
      result = sample.logs.filter((l) => BigInt(l.blockNumber) >= low && BigInt(l.blockNumber) <= high)
    } else if (request.method === 'eth_getBlockByNumber') {
      const number = BigInt(request.params[0])
      const raw = sample.logs.find((l) => BigInt(l.blockNumber) === number)
      // Unrecorded bridge headers/ranges are synthetic transport mechanics,
      // not evidence of real remote coverage or throughput.
      const hash = raw?.blockHash ?? `0x${number.toString(16).padStart(64, '0')}`
      const changed = (reorg && number === end) || (racing && number === start + 19n && ++endReads > 1)
      result = {
        number: request.params[0],
        hash: changed ? `0x${'e'.repeat(64)}` : hash,
        timestamp: sample.blocks[request.params[0]] ?? '0x6ac65e80',
      }
    } else throw Error('UNEXPECTED_FAKE_RPC')
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  }
  vi.stubGlobal('fetch', transport)
  return {
    calls,
    setFail: (b: bigint | null) => {
      failAt = b
    },
    wrongChain: () => {
      chain = 10143
    },
    reorg: () => {
      reorg = true
    },
    race: () => {
      racing = true
    },
  }
}
afterEach(() => vi.unstubAllGlobals())

it('replays 1000 synthetic transport blocks with recorded logs across failures, restart and rewind without duplicates', async () => {
  const { db, store } = await databaseFixture()
  const rpc = provider(),
    repo = new AnalyticsRepository(store.pool)
  try {
    let worker = new AnalyticsIndexer(repo, config)
    for (let i = 0; i < 5; i++) expect(await worker.step()).toBe('indexed')
    const saved = await repo.checkpoint()
    rpc.setFail(start + 100n)
    await expect(worker.step()).rejects.toThrow('ANALYTICS_RPC_HTTP_503')
    expect(await repo.checkpoint()).toEqual(saved)
    rpc.setFail(null)
    worker = new AnalyticsIndexer(repo, config)
    for (let i = 5; i < 50; i++) expect(await worker.step()).toBe('indexed')
    expect(await worker.step()).toBe('caught-up')
    expect((await repo.checkpoint())?.nextBlock).toBe(end + 1n)
    const count = async () =>
      Number((await store.pool.query('SELECT count(*) AS n FROM analytics_raw_events')).rows[0].n)
    expect(await count()).toBe(sample.logs.length)
    rpc.reorg()
    expect(await worker.step()).toBe('rewound')
    while ((await worker.step()) === 'indexed') {
      /* bounded by 64-block rewind */
    }
    expect(await count()).toBe(sample.logs.length)
    expect(await new AnalyticsIndexer(repo, config).step()).toBe('caught-up')
    expect((await repo.checkpoint())?.historyVerified).toBe(false)
  } finally {
    await db.close()
  }
}, 30000)

it('refuses a testnet RPC before advancing a mainnet checkpoint', async () => {
  const { db, store } = await databaseFixture()
  const rpc = provider()
  rpc.wrongChain()
  const repo = new AnalyticsRepository(store.pool)
  try {
    await expect(new AnalyticsIndexer(repo, config).step()).rejects.toThrow('ANALYTICS_RPC_CHAIN_MISMATCH')
    expect(await repo.checkpoint()).toBeNull()
    expect(rpc.calls).toEqual(['eth_chainId'])
  } finally {
    await db.close()
  }
})

it('does not commit a chunk when its boundary hash changes during the read', async () => {
  const { db, store } = await databaseFixture()
  provider().race()
  const repo = new AnalyticsRepository(store.pool)
  try {
    await expect(new AnalyticsIndexer(repo, config).step()).rejects.toThrow('ANALYTICS_CHUNK_REORG')
    expect((await repo.checkpoint())?.nextBlock).toBe(start)
    expect(Number((await store.pool.query('SELECT count(*) AS n FROM analytics_raw_events')).rows[0].n)).toBe(0)
  } finally {
    await db.close()
  }
})
