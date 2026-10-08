import { readFile } from 'node:fs/promises'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Abi, type AbiEvent } from 'viem'
import { verifyStrategyCommandReceipt } from '../../packages/perpl/src/strategy-receipts.js'
import { type StrategyLifecycleBlock } from '../../packages/perpl/src/strategy-lifecycle.js'
import type { WireFill } from '../../packages/perpl/src/decoder.js'

// Independent official SDK vectors, not the implementation's declarations.
const lifecycleAbi = JSON.parse(await readFile('packages/perpl/fixtures/strategy-lifecycle-abi.json', 'utf8')) as Abi
const commandAbi = JSON.parse(
  (await readFile('packages/perpl/fixtures/strategy-command-abi.json', 'utf8')).replace(/^\uFEFF/, ''),
) as Abi
export const exchange = '0x0000000000000000000000000000000000000001'
export const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const descriptor = {
  orderDescId: 45n,
  perpId: 16n,
  orderType: 0,
  orderId: 0n,
  pricePNS: 990n,
  lotLNS: 100n,
  expiryBlock: 0n,
  postOnly: true,
  fillOrKill: false,
  immediateOrCancel: false,
  maxMatches: 1n,
  leverageHdths: 100n,
  lastExecutionBlock: 111n,
  amountCNS: 0n,
  maxNegPnlCollatBPS: 0n,
}
export const requestValues = (order = descriptor) => [
  order.perpId,
  642n,
  order.orderDescId,
  order.orderId,
  order.orderType,
  order.pricePNS,
  order.lotLNS,
  order.expiryBlock,
  order.postOnly,
  order.fillOrKill,
  order.immediateOrCancel,
  order.maxMatches,
  order.leverageHdths,
  order.lastExecutionBlock,
  order.amountCNS,
  order.maxNegPnlCollatBPS,
  100n,
]
type EventVector = { name: string; values: unknown[]; address?: string }
export const event = (name: string, values: unknown[]): EventVector => ({ name, values })
export const maker = (size = 30n, account = 642n, builder?: number): EventVector =>
  builder === undefined
    ? event('MakerOrderFilled', [16n, account, 75n, 990n, size, 3n, 0n, 0n, 100n])
    : event('MakerOrderFilledV2', [16n, account, 75n, 990n, size, 3n, 0n, 0n, 100n, BigInt(builder), 0n])

export function block(
  number: number,
  transactions: Array<{ events: EventVector[]; input?: string }>,
): StrategyLifecycleBlock {
  let globalIndex = 0
  const txs = transactions.map((value, index) => ({
    hash: hash(number * 100 + index),
    to: exchange,
    input: value.input ?? '0x',
    blockHash: hash(number),
    blockNumber: `0x${number.toString(16)}`,
    transactionIndex: `0x${index.toString(16)}`,
  }))
  const receipts = transactions.map((value, index) => ({
    status: '0x1',
    to: exchange,
    transactionHash: txs[index].hash,
    blockHash: hash(number),
    blockNumber: `0x${number.toString(16)}`,
    transactionIndex: `0x${index.toString(16)}`,
    logs: value.events.map((vector) => {
      const entry = lifecycleAbi.find((item) => item.type === 'event' && item.name === vector.name) as AbiEvent
      if (!entry) throw Error(`Unknown independent fixture event: ${vector.name}`)
      return {
        address: vector.address ?? exchange,
        data: encodeAbiParameters(entry.inputs, vector.values),
        topics: encodeEventTopics({ abi: [entry], eventName: entry.name }),
        logIndex: `0x${(globalIndex++).toString(16)}`,
        removed: false,
        blockHash: hash(number),
        blockNumber: `0x${number.toString(16)}`,
        transactionIndex: `0x${index.toString(16)}`,
        transactionHash: txs[index].hash,
      }
    }),
  }))
  return {
    block: { number: `0x${number.toString(16)}`, hash: hash(number), parentHash: hash(number - 1), transactions: txs },
    receipts,
  }
}
export function slotFixture(extra: EventVector[] = [maker()], builder?: number) {
  const extension =
    builder === undefined
      ? '0x'
      : encodeAbiParameters(
          [{ type: 'uint16' }, { type: 'bytes' }],
          [1, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(builder), 0n])],
        )
  const input = encodeFunctionData({
    abi: commandAbi,
    functionName: 'execFwdPositionOpsV2',
    args: [
      [
        {
          accountId: 642n,
          feePer100K: 0n,
          orderDesc: descriptor,
          execTriggerOrder: false,
          triggerPricePNS: 0n,
          triggerPriceCondition: 0,
          triggerRequestId: 0n,
          triggerPositionId: 0n,
        },
      ],
      extension === '0x' ? [] : [extension],
    ],
  })
  const placed = block(110, [
    {
      events: [
        extension === '0x'
          ? event('OrderRequest', requestValues())
          : event('OrderRequestV2', [...requestValues(), extension]),
        event('OrderPlaced', [75n, 100n, 0n, 0n, 100n]),
        event('OrderBatchCompleted', [0n]),
      ],
      input,
    },
  ])
  // Admission parser correctly closes a batch and binds exactly one placement outcome.
  const tx = (placed.block.transactions as Record<string, unknown>[])[0]
  const operation = verifyStrategyCommandReceipt(exchange, String(tx.hash), tx, placed.receipts[0])[0]
  if (operation?.outcome !== 'PLACED') throw Error('Independent placement vector did not verify')
  const identity = {
    accountId: 642,
    marketId: 116,
    contractMarketId: 16,
    venueOrderId: 90075,
    contractOrderId: 75,
    placementRequestId: '45',
    type: 1,
    creationBlock: 110,
    creationTransactionIndex: 0,
    creationTxHash: String(tx.hash),
  }
  const admission = { ...operation, venueOrderId: 90075, identity }
  const filled = block(112, [{ events: extra }])
  const candidate: WireFill = {
    acc: 642,
    mkt: 116,
    oid: 90075,
    t: 1,
    l: 1,
    p: 990,
    s: 30,
    f: '3',
    at: { b: 112, tx: 0, l: extra.length - 1, txid: hash(11200).slice(2) },
  }
  const blocks = [placed, block(111, []), filled]
  return { admission, candidate, blocks }
}
