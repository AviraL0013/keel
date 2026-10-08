import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Abi, type AbiEvent } from 'viem'
import { verifyStrategyCommandReceipt } from '../packages/perpl/src/strategy-receipts.js'
import { verifyStrategyMakerFill, type StrategyLifecycleBlock } from '../packages/perpl/src/strategy-lifecycle.js'
import { StrategyLifecycleReader } from '../packages/perpl/src/strategy-lifecycle-reader.js'
import type { WireFill } from '../packages/perpl/src/decoder.js'

// Independent official SDK vectors, not the implementation's declarations.
const lifecycleAbi = JSON.parse(await readFile('packages/perpl/fixtures/strategy-lifecycle-abi.json', 'utf8')) as Abi
const commandAbi = JSON.parse(
  (await readFile('packages/perpl/fixtures/strategy-command-abi.json', 'utf8')).replace(/^\uFEFF/, ''),
) as Abi
const exchange = '0x0000000000000000000000000000000000000001'
const foreign = '0x0000000000000000000000000000000000000002'
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
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
const requestValues = (order = descriptor) => [
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
const event = (name: string, values: unknown[]): EventVector => ({ name, values })
const maker = (size = 30n, account = 642n, builder?: number): EventVector =>
  builder === undefined
    ? event('MakerOrderFilled', [16n, account, 75n, 990n, size, 3n, 0n, 0n, 100n])
    : event('MakerOrderFilledV2', [16n, account, 75n, 990n, size, 3n, 0n, 0n, 100n, BigInt(builder), 0n])

function block(number: number, transactions: Array<{ events: EventVector[]; input?: string }>): StrategyLifecycleBlock {
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
function fixture(extra: EventVector[] = [maker()], builder?: number) {
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
const verify = (value: ReturnType<typeof fixture>) =>
  verifyStrategyMakerFill(exchange, value.admission, value.candidate, value.blocks)

describe('gapless strategy maker slot lifetime proof', () => {
  it('verifies a partial maker fill after lb from complete blocks, separating API oid and contract slot', () => {
    expect(verify(fixture())).toMatchObject({
      status: 'VERIFIED',
      fill: {
        accountId: 642,
        marketId: 116,
        contractMarketId: 16,
        venueOrderId: 90075,
        contractOrderId: 75,
        placementRequestId: '45',
        sizeRaw: '30',
        priceRaw: '990',
        grossFeeRaw: '3',
        builderFeeRaw: '0',
        remainingSizeRaw: '70',
        removed: false,
        block: 112,
      },
    })
  })
  it('subtracts preceding partial fills and retains the generation through an exact change', () => {
    const change = { ...descriptor, orderType: 6, orderId: 75n, orderDescId: 46n, lotLNS: 80n }
    const value = fixture([
      maker(20n),
      event('OrderRequest', requestValues(change)),
      event('OrderChanged', [75n, 990n, 80n, 0n, 0n, 100n]),
      event('OrderBatchCompleted', [0n]),
      maker(),
    ])
    expect(verify(value), JSON.stringify(verify(value))).toMatchObject({
      status: 'VERIFIED',
      fill: { remainingSizeRaw: '50' },
    })
  })
  it('uses the complete receipt to derive transaction-local index including foreign emitters', () => {
    const value = fixture([{ ...event('OrderBatchCompleted', [0n]), address: foreign }, maker()])
    value.blocks[2] = block(112, [
      { events: [event('OrderBatchCompleted', [0n])] },
      { events: [{ ...event('OrderBatchCompleted', [0n]), address: foreign }, maker()] },
    ])
    value.candidate.at = { b: 112, tx: 1, l: 1, txid: hash(11201).slice(2) }
    expect(verify(value)).toMatchObject({ status: 'VERIFIED', fill: { logIndex: 2, transactionLogIndex: 1 } })
    value.candidate.at.l = 2
    expect(verify(value).status).toBe('UNKNOWN')
  })
  it('does not borrow a same-account reposted slot after a full fill in the same transaction', () => {
    const replacement = { ...descriptor, orderDescId: 46n }
    const value = fixture([
      maker(100n),
      event('OrderRequest', requestValues(replacement)),
      event('OrderPlaced', [75n, 100n, 0n, 0n, 100n]),
      event('OrderBatchCompleted', [0n]),
      maker(),
    ])
    expect(verify(value).status).toBe('UNKNOWN')
  })
  it('pins the exact placement log when a slot is removed and replaced within its creation transaction', () => {
    const value = fixture()
    const creation = value.blocks[0].receipts[0]
    const logs = creation.logs as Record<string, unknown>[]
    const bad = structuredClone(logs[1])
    bad.logIndex = '0x3'
    logs.push(bad)
    expect(verify(value).status).toBe('UNKNOWN')
  })
  const removals: Array<[string, unknown[]]> = [
    ['OrderCancelledByAdmin', [16n, 642n, 75n, 0n]],
    ['OrderCancelledByLiquidator', [16n, 642n, 75n, 0n]],
    ...[
      'ClearingExpiredOrder',
      'ClearingFrozenAccountOrder',
      'ClearingInvalidCloseOrder',
      'ClearingSelfMatchingOrder',
    ].map((name) => [name, [16n, 642n, 75n, 0n, 1n, 0n, 0n]] as [string, unknown[]]),
    ['MakerOrderSettlementFailed', [16n, 642n, 75n, 0, 990n, 100n, 0n, 1n, 0n, 1n, 0n, 0n]],
  ]
  it.each(removals)('refuses an old lifetime after %s followed by same-account replacement', (name, values) => {
    const replacement = { ...descriptor, orderDescId: 46n }
    expect(
      verify(
        fixture([
          event(name, values),
          event('OrderRequest', requestValues(replacement)),
          event('OrderPlaced', [75n, 100n, 0n, 0n, 100n]),
          event('OrderBatchCompleted', [0n]),
          maker(),
        ]),
      ).status,
    ).toBe('UNKNOWN')
  })
  it('respects normal cancel context and never borrows a prior transaction or completed batch context', () => {
    const cancel = { ...descriptor, orderType: 4, orderId: 75n, orderDescId: 46n }
    const value = fixture([
      event('OrderRequest', requestValues(cancel)),
      event('OrderCancelled', [0n, 0n, 100n]),
      maker(),
    ])
    expect(verify(value).status).toBe('UNKNOWN')
    expect(verify(fixture([event('OrderCancelled', [0n, 0n, 100n]), maker()])).status).toBe('UNKNOWN')
    expect(
      verify(
        fixture([
          event('OrderRequest', requestValues(cancel)),
          event('OrderBatchCompleted', [0n]),
          event('OrderCancelled', [0n, 0n, 100n]),
          maker(),
        ]),
      ).status,
    ).toBe('UNKNOWN')
  })
  it('tracks the clearing flag on current request context, even when it names another maker slot', () => {
    const events = [
      event('OrderRequest', requestValues({ ...descriptor, orderDescId: 88n })),
      event('ClearingRemainingOrderLockBeyondBalance', [16n, 999n, 76n, 990n, 30n, 0n, 0n, 1n, 0n, 0n]),
      maker(20n),
      maker(),
    ]
    expect(verify(fixture(events)).status).toBe('UNKNOWN')
    events.splice(3, 0, event('OrderBatchCompleted', [0n]))
    // Removal already happened before the reset, so later fill cannot own the old generation.
    expect(verify(fixture(events)).status).toBe('UNKNOWN')
  })
  it('verifies the partial-sized fill that clears the remaining lock, recording removal', () => {
    const value = fixture([
      event('OrderRequest', requestValues({ ...descriptor, orderDescId: 88n })),
      event('ClearingRemainingOrderLockBeyondBalance', [16n, 642n, 75n, 990n, 30n, 0n, 0n, 1n, 0n, 0n]),
      maker(),
    ])
    expect(verify(value)).toMatchObject({ status: 'VERIFIED', fill: { removed: true, remainingSizeRaw: '0' } })
  })
  it('requires complete block and receipt inventory, parent linkage, canonical stamps and all event indices', () => {
    const variants: Array<(value: ReturnType<typeof fixture>) => void> = [
      (value) => {
        value.blocks.splice(1, 1)
      },
      (value) => {
        value.blocks[1].block.parentHash = hash(1)
      },
      (value) => {
        value.blocks[2].receipts = []
      },
      (value) => {
        value.blocks[2].receipts.push(value.blocks[2].receipts[0])
      },
      (value) => {
        value.blocks[2].receipts[0].blockHash = hash(1)
      },
      (value) => {
        ;(value.blocks[2].receipts[0].logs as Record<string, unknown>[])[0].removed = true
      },
      (value) => {
        ;(value.blocks[2].receipts[0].logs as Record<string, unknown>[])[0].logIndex = '0x1'
      },
      (value) => {
        value.blocks[1].block.transactions = [hash(11100)]
      },
    ]
    for (const corrupt of variants) {
      const value = fixture()
      corrupt(value)
      expect(verify(value).status).toBe('UNKNOWN')
    }
  })
  it('refuses foreign API identity, unsafe integers, taker classification, mismatched builder or gross fees', () => {
    for (const change of [
      { oid: 75 },
      { acc: 643 },
      { mkt: 16 },
      { l: 2 },
      { t: 2 },
      { s: 31 },
      { p: 991 },
      { f: '4' },
      { f: '-3' },
      { bfa: '1' },
      { s: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const value = fixture()
      Object.assign(value.candidate, change)
      expect(verify(value).status).toBe('UNKNOWN')
    }
    expect(verify(fixture([maker(30n, 642n, 25)], 25)).status).toBe('VERIFIED')
    expect(verify(fixture([maker(30n, 642n, 24)], 25)).status).toBe('UNKNOWN')
    expect(verify(fixture([maker()], 25)).status).toBe('UNKNOWN')
  })
  it('retains unknown event and unsupported expiry barriers rather than asserting a continuous lifetime', () => {
    const value = fixture()
    // Unknown Exchange event is inserted into an otherwise complete, properly stamped block.
    value.blocks[1] = block(111, [{ events: [event('OrderBatchCompleted', [0n])] }])
    const raw = (value.blocks[1].receipts[0].logs as Record<string, unknown>[])[0]
    raw.topics = [hash(999)]
    expect(verify(value).status).toBe('UNKNOWN')
    const expired = fixture()
    expired.admission.expiryBlock = '112'
    expect(verify(expired).status).toBe('UNKNOWN')
  })
  it('is deterministic on restart/replay and refuses altered saved placement proof', () => {
    const value = fixture()
    expect(verify(value).status).toBe('VERIFIED')
    expect(verify(structuredClone(value))).toEqual(verify(value))
    value.admission.outcomeLogIndex = 0
    expect(verify(value).status).toBe('UNKNOWN')
  })
  it('verifies a full-sized final fill without interpreting it as a capital or PnL credit', () => {
    const value = fixture([maker(100n)])
    value.candidate.s = 100
    const proof = verify(value)
    expect(proof).toMatchObject({ status: 'VERIFIED', fill: { remainingSizeRaw: '0', removed: true } })
    expect(proof).not.toHaveProperty('pnl')
    expect(proof).not.toHaveProperty('capitalCredit')
  })
  it.each(['request', 'batch', 'transaction'])(
    'resets clearing state at %s boundary before the watched fill',
    (boundary) => {
      const first = [
        event('OrderRequest', requestValues({ ...descriptor, orderDescId: 88n })),
        event('ClearingRemainingOrderLockBeyondBalance', [16n, 999n, 76n, 990n, 30n, 0n, 0n, 1n, 0n, 0n]),
      ]
      const value = fixture()
      if (boundary === 'transaction') {
        value.blocks[2] = block(112, [{ events: first }, { events: [maker()] }])
        value.candidate.at = { b: 112, tx: 1, l: 0, txid: hash(11201).slice(2) }
      } else {
        const reset =
          boundary === 'request'
            ? event('OrderRequest', requestValues({ ...descriptor, orderDescId: 89n }))
            : event('OrderBatchCompleted', [0n])
        value.blocks[2] = block(112, [{ events: [...first, reset, maker()] }])
        value.candidate.at.l = 3
      }
      expect(verify(value)).toMatchObject({ status: 'VERIFIED', fill: { remainingSizeRaw: '70', removed: false } })
    },
  )
  it('reads fake finalized blocks and every receipt, then proves the original generation without any write method', async () => {
    const value = fixture([maker(20n), maker()])
    const methods: string[] = []
    const transport = async (_url: string | URL | Request, init?: RequestInit) => {
      const { method, params, id } = JSON.parse(String(init?.body))
      methods.push(method)
      let result: unknown
      if (method === 'eth_chainId') result = '0x8f'
      else if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'finalized' ? 112 : Number(BigInt(params[0]))
        result = value.blocks.find((entry) => Number(BigInt(String(entry.block.number))) === number)?.block
      } else if (method === 'eth_getTransactionReceipt')
        result = value.blocks
          .flatMap((entry) => entry.receipts)
          .find((receipt) => receipt.transactionHash === params[0])
      else throw Error(`Forbidden fake RPC method: ${method}`)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
    }
    const inventory = await new StrategyLifecycleReader(
      'https://fixture-rpc.invalid',
      143,
      transport as typeof fetch,
    ).read(110, 112)
    const proof = verifyStrategyMakerFill(exchange, value.admission, value.candidate, inventory.blocks)
    expect(proof).toMatchObject({ status: 'VERIFIED', fill: { remainingSizeRaw: '50' } })
    expect(inventory.finalized).toEqual({ block: 112, hash: hash(112) })
    expect(
      methods.every((method) => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt'].includes(method)),
    ).toBe(true)
  })
})
