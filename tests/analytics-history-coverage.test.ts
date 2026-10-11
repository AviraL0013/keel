import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChainLog } from '../packages/analytics/src/decoder.js'
import { AnalyticsRepository } from '../server/src/infrastructure/analytics/repository.js'
import { AnalyticsIndexer } from '../server/src/workers/analytics-indexer.js'
import { databaseFixture } from './helpers/database.js'

const start = 54773010n
const creationTransaction = '0x22d1d74e137c3a82ac4b702fd90024811b184fcdcf8fd4d1473097b4d8a619f3'
const creationHash = '0x920c331560f77c8e4bdf1d011d0f7c9da4aad9bbd39b4ddb1190cb7bd27029ff'
const base = {
  address: '0x34b6552d57a35a1d042ccae1951bd1c370112a6f',
  blockNumber: '0x343c512',
  blockHash: creationHash,
  transactionHash: creationTransaction,
  transactionIndex: '0xc',
  removed: false,
}
// Recorded public Exchange-creation transaction logs at block 54773010.
const creationLogs: ChainLog[] = [
  {
    ...base,
    logIndex: '0x1c',
    data: '0x',
    topics: [
      '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',
      '0x0000000000000000000000005726c05fd268997aa474529f345067b9b075056d',
    ],
  },
  {
    ...base,
    logIndex: '0x1e',
    data: '0x000000000000000000000000141ace3283da8fd356b5f079b228146e783e50a600000000000000000000000000000000efe302beaa2b3e6e1b18d08d69a9012a00000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000e8d4a5100000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000000000000000000000000000000000000000000001',
    topics: ['0x7b1f94d30e47df15616bc31716546ce84737fcf471dff8cd336c68fb810d7e6f'],
  },
  {
    ...base,
    logIndex: '0x1f',
    data: '0x0000000000000000000000000000000000000000000000000000000000000001',
    topics: ['0x7f26b83ff96e1f2b6a682f133852f6798a09c465da95921460cefb3847402498'],
  },
]
const context = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')).context
const config = {
  databaseUrl: ':memory:',
  rpcUrl: 'https://fake.invalid',
  perplApiUrl: 'https://fake.invalid/api',
  startBlock: start,
  historyVerified: true,
  confirmationDepth: 12n,
  chunkSize: 20n,
  pollMs: 1000,
}

function provider() {
  let mode: 'normal' | 'missing-anchor' | 'missing-header' | 'duplicate' | 'conflict' | 'outside' | 'forbidden' =
    'normal'
  let reorg = false
  const ranges: number[] = []
  const batchSizes: number[] = []
  const last = start + 119n
  const timestamp = `0x${Math.floor(Date.now() / 1000).toString(16)}`
  const answer = (request: { id: number; method: string; params: unknown[] }) => {
    let result: unknown
    if (request.method === 'eth_chainId') result = '0x8f'
    else if (request.method === 'eth_blockNumber') result = `0x${(last + 12n).toString(16)}`
    else if (request.method === 'eth_getLogs') {
      const filter = request.params[0] as { fromBlock: string; toBlock: string }
      const from = BigInt(filter.fromBlock)
      const to = BigInt(filter.toBlock)
      ranges.push(Number(to - from + 1n))
      if (to - from + 1n > 20n) return { jsonrpc: '2.0', id: request.id, error: { code: -32614 } }
      result = from === start && mode !== 'missing-anchor' ? [...creationLogs] : []
      if (from === start && mode === 'duplicate') result = [...creationLogs, creationLogs[0]]
      if (from === start && mode === 'conflict') result = [...creationLogs, { ...creationLogs[0], data: '0x01' }]
      if (mode === 'outside') result = [{ ...creationLogs[0], blockNumber: `0x${(to + 1n).toString(16)}` }]
    } else if (request.method === 'eth_getBlockByNumber') {
      const number = BigInt(request.params[0] as string)
      result = {
        number: request.params[0],
        hash:
          reorg && number === last
            ? `0x${'e'.repeat(64)}`
            : number === start
              ? creationHash
              : `0x${number.toString(16).padStart(64, '0')}`,
        timestamp,
      }
    } else throw new Error('UNEXPECTED_FAKE_RPC')
    return { jsonrpc: '2.0', id: request.id, result }
  }
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith('/v1/pub/context')) return Response.json(context)
    const request = JSON.parse(String(init?.body))
    if (Array.isArray(request)) {
      batchSizes.push(request.length)
      return Response.json((mode === 'missing-header' ? request.slice(1) : request).map(answer).reverse())
    }
    if (mode === 'forbidden' && request.method === 'eth_getLogs') return new Response('', { status: 403 })
    return Response.json(answer(request))
  })
  return {
    ranges,
    batchSizes,
    setMode: (value: typeof mode) => (mode = value),
    reorg: () => (reorg = true),
  }
}

afterEach(() => vi.unstubAllGlobals())

it('keeps history incomplete through restart, then verifies only a fresh continuous deployment replay', async () => {
  const { db, store } = await databaseFixture()
  const rpc = provider()
  const repo = new AnalyticsRepository(store.pool)
  try {
    let worker = new AnalyticsIndexer(repo, config)
    expect(await worker.step()).toBe('indexed')
    expect((await repo.checkpoint())?.historyVerified).toBe(false)
    worker = new AnalyticsIndexer(repo, config)
    for (let i = 0; i < 10 && (await repo.checkpoint())?.nextBlock !== start + 120n; i++)
      expect(await worker.step()).toBe('indexed')
    expect((await repo.checkpoint())?.nextBlock).toBe(start + 120n)
    expect((await repo.checkpoint())?.historyVerified).toBe(false)
    expect(await worker.step()).toBe('caught-up')
    expect((await repo.checkpoint())?.historyVerified).toBe(true)
    expect(rpc.batchSizes.every((size) => size <= 20)).toBe(true)
    expect(rpc.ranges).toContain(40)
    expect(rpc.ranges.at(-1)).toBe(20)
    await db.exec(readFileSync('database/migrations/035_analytics_history_proof.sql', 'utf8'))
    expect((await repo.checkpoint())?.historyVerified).toBe(true)
    rpc.reorg()
    expect(await worker.step()).toBe('rewound')
    expect((await repo.checkpoint())?.historyVerified).toBe(false)
    for (let i = 0; i < 10 && (await repo.checkpoint())?.nextBlock !== start + 120n; i++)
      expect(await worker.step()).toBe('indexed')
    expect((await repo.checkpoint())?.nextBlock).toBe(start + 120n)
    expect((await repo.checkpoint())?.historyVerified).toBe(false)
    expect(await worker.step()).toBe('caught-up')
    expect((await repo.checkpoint())?.historyVerified).toBe(true)
  } finally {
    await db.close()
  }
}, 30000)

it('rejects missing deployment logs, out-of-range logs, conflicts and 403 without advancing', async () => {
  const { db, store } = await databaseFixture()
  const rpc = provider()
  const repo = new AnalyticsRepository(store.pool)
  const worker = new AnalyticsIndexer(repo, config)
  try {
    rpc.setMode('missing-anchor')
    await expect(worker.step()).rejects.toThrow('ANALYTICS_DEPLOYMENT_ANCHOR_MISSING')
    rpc.setMode('outside')
    await expect(worker.step()).rejects.toThrow('ANALYTICS_LOG_RANGE_INVALID')
    rpc.setMode('conflict')
    await expect(worker.step()).rejects.toThrow('ANALYTICS_LOG_DUPLICATE_CONFLICT')
    rpc.setMode('missing-header')
    await expect(worker.step()).rejects.toThrow('ANALYTICS_RPC_BATCH_INVALID')
    rpc.setMode('forbidden')
    await expect(worker.step()).rejects.toThrow('ANALYTICS_RPC_HTTP_403')
    expect((await repo.checkpoint())?.nextBlock).toBe(start)
    expect((await repo.checkpoint())?.historyVerified).toBe(false)
    rpc.setMode('duplicate')
    expect(await worker.step()).toBe('indexed')
    const count = await store.pool.query('SELECT count(*)::int AS n FROM analytics_raw_events')
    expect(count.rows[0].n).toBe(3)
  } finally {
    await db.close()
  }
}, 30000)
