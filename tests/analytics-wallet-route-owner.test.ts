import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PerplPublicAnalytics } from '../server/src/infrastructure/analytics/perpl-public.js'
import { WalletChainAnalytics } from '../server/src/infrastructure/analytics/wallet-chain.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'
import { databaseFixture } from './helpers/database.js'

const address = '0x1234567890abcdef1234567890abcdef12345678'
const other = '0x2222222222222222222222222222222222222222'
const block = 111000000
const blockHash = `0x${'a'.repeat(64)}`
const transactionHash = `0x${'b'.repeat(64)}`
const context = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')).context

let db: Awaited<ReturnType<typeof databaseFixture>>
beforeAll(async () => {
  db = await databaseFixture()
  await db.store.pool.query('INSERT INTO analytics_blocks(block_number,block_hash,occurred_at) VALUES($1,$2,now())', [
    block,
    blockHash,
  ])
  await db.store.pool.query('INSERT INTO analytics_accounts(account_id,address,created_block) VALUES(1,$1,$2)', [
    address,
    block,
  ])
  for (const index of [1, 2]) {
    await db.store.pool.query(
      `INSERT INTO analytics_raw_events(block_number,transaction_hash,log_index,transaction_index,block_hash,data,topics)
       VALUES($1,$2,$3,0,$4,'0x','[]')`,
      [block, transactionHash, index, blockHash],
    )
  }
  await db.store.pool.query(
    `INSERT INTO analytics_fills(block_number,transaction_hash,log_index,account_id,market_id,price_raw,size_raw,
      notional_micros,fee_micros,builder_fee_micros,occurred_at)
     VALUES($1,$2,1,1,1,100,1,1000000,1000,0,now())`,
    [block, transactionHash],
  )
  await db.store.pool.query(
    `INSERT INTO analytics_position_events(block_number,transaction_hash,log_index,account_id,market_id,side,action,
      size_raw,realized_pnl_micros,protocol_fee_micros,occurred_at)
     VALUES($1,$2,2,1,1,'long','open',1,NULL,0,now())`,
    [block, transactionHash],
  )
})
afterAll(async () => {
  await db.db.close()
})

async function trades(ownerAddress: string) {
  const app = Fastify()
  const publicData = new PerplPublicAnalytics('https://fixture.invalid', async () => Response.json(context))
  const wallet = {
    ownerAt: async () => ({
      accountId: '1',
      address: ownerAddress,
      block: String(block),
      blockHash,
      asOf: new Date().toISOString(),
      source: 'monad_exchange',
    }),
  } as unknown as WalletChainAnalytics
  registerAnalyticsRoutes(app, db.store.pool, { publicData, wallet })
  try {
    return await app.inject(`/analytics/v1/wallets/${address}/trades`)
  } finally {
    await app.close()
  }
}

it('includes a maker trade only when exact-block owner proof matches the requested wallet', async () => {
  const matching = await trades(address)
  expect(matching.statusCode).toBe(200)
  expect(matching.json().data.items).toHaveLength(1)

  const transferred = await trades(other)
  expect(transferred.statusCode).toBe(200)
  expect(transferred.json().data.items).toHaveLength(0)
  expect(transferred.json().stale).toBe(true)
})
