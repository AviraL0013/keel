import { readFileSync } from 'node:fs'
import { encodeAbiParameters, toEventSelector, type AbiEvent, type AbiParameters, type Hex } from 'viem'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.js'
import { EXCHANGE, type ChainLog } from '../packages/analytics/src/decoder.js'
import { PerplPublicAnalytics } from '../server/src/infrastructure/analytics/perpl-public.js'
import { WalletChainAnalytics } from '../server/src/infrastructure/analytics/wallet-chain.js'
import { WalletReceiptReader } from '../server/src/infrastructure/analytics/wallet-receipt.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'
import { databaseFixture } from './helpers/database.js'

const address = '0x1234567890abcdef1234567890abcdef12345678'
const other = '0x2222222222222222222222222222222222222222'
const block = 111000005n
const blockHash = `0x${'a'.repeat(64)}` as Hex
const transactionHash = `0x${'b'.repeat(64)}` as Hex
const context = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')).context

function eventLog(name: string, index: number, values: Record<string, bigint>): ChainLog {
  const event = exchangeEvents.find((candidate) => candidate.name === name) as AbiEvent
  return {
    address: EXCHANGE,
    blockNumber: `0x${block.toString(16)}`,
    blockHash,
    transactionHash,
    transactionIndex: '0x1',
    logIndex: `0x${index.toString(16)}`,
    topics: [toEventSelector(event)],
    data: encodeAbiParameters(
      event.inputs as AbiParameters,
      event.inputs.map((input) => values[input.name ?? ''] ?? 0n) as never,
    ),
  }
}

it('serves an indexed taker fill only after complete receipt and exact-block wallet proof', async () => {
  const db = await databaseFixture()
  try {
    await db.store.pool.query('INSERT INTO analytics_blocks(block_number,block_hash,occurred_at) VALUES($1,$2,now())', [
      block.toString(),
      blockHash,
    ])
    await db.store.pool.query('INSERT INTO analytics_accounts(account_id,address,created_block) VALUES(1,$1,$2)', [
      address,
      block.toString(),
    ])
    for (const [index, name] of [
      [2, 'PositionOpenedV2'],
      [3, 'TakerOrderFilledV2'],
    ] as const) {
      await db.store.pool.query(
        `INSERT INTO analytics_raw_events(block_number,transaction_hash,log_index,transaction_index,block_hash,event_name,data,topics)
         VALUES($1,$2,$3,1,$4,$5,'0x','[]')`,
        [block.toString(), transactionHash, index, blockHash, name],
      )
    }
    await db.store.pool.query(
      `INSERT INTO analytics_position_events(block_number,transaction_hash,log_index,account_id,market_id,side,action,
        size_raw,realized_pnl_micros,protocol_fee_micros,occurred_at)
       VALUES($1,$2,2,1,1,'long','open',193,NULL,0,now())`,
      [block.toString(), transactionHash],
    )
    const logs = [
      eventLog('PositionOpenedV2', 2, {
        perpId: 1n,
        accountId: 1n,
        positionType: 0n,
        pricePNS: 829910n,
        lotLNS: 193n,
        insFeeCNS: 8289n,
        protFeeCNS: 48573n,
      }),
      eventLog('TakerOrderFilledV2', 3, {
        entryPricePNS: 829910n,
        lotLNS: 193n,
        feeCNS: 56862n,
        builderFeeCNS: 1602n,
      }),
    ]
    const receipts = {
      read: async () => ({
        status: 'success' as const,
        blockNumber: block,
        blockHash,
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000) - 10),
        transactionHash,
        transactionIndex: 1,
        logs,
      }),
    } as unknown as WalletReceiptReader
    const publicData = new PerplPublicAnalytics('https://fixture.invalid', async () => Response.json(context))
    for (const owner of [address, other]) {
      const app = Fastify()
      const wallet = {
        ownerAt: async () => ({
          accountId: '1',
          address: owner,
          block: block.toString(),
          blockHash,
          asOf: new Date().toISOString(),
          source: 'monad_exchange',
        }),
      } as unknown as WalletChainAnalytics
      registerAnalyticsRoutes(app, db.store.pool, { publicData, wallet, receipts })
      try {
        const response = await app.inject(`/analytics/v1/wallets/${address}/trades`)
        expect(response.statusCode).toBe(200)
        expect(response.json().data.items).toHaveLength(owner === address ? 1 : 0)
        if (owner === address) {
          expect(response.json().data.items[0]).toMatchObject({ action: 'open', fee: '0.056862' })
        }
        expect(response.json().stale).toBe(true)
      } finally {
        await app.close()
      }
    }
  } finally {
    await db.db.close()
  }
}, 30_000)
