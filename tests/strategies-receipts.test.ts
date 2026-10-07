import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Abi, type AbiEvent } from 'viem'
import { verifyStrategyCommandReceipt } from '../packages/perpl/src/strategy-receipts.js'
import { PerplHistory } from '../packages/perpl/src/history.js'

// Independent vectors use the official SDK ABI, not the verifier's declarations.
const abi = JSON.parse(
  (await readFile('packages/perpl/fixtures/strategy-command-abi.json', 'utf8')).replace(/^\uFEFF/, ''),
) as Abi
const exchange = '0x0000000000000000000000000000000000000001'
const hash = `0x${'a'.repeat(64)}`
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
  lastExecutionBlock: 120n,
  amountCNS: 0n,
  maxNegPnlCollatBPS: 0n,
}
const envelope = (orderDesc = descriptor) => ({
  accountId: 642n,
  feePer100K: 0n,
  orderDesc,
  execTriggerOrder: false,
  triggerPricePNS: 0n,
  triggerPriceCondition: 0,
  triggerRequestId: 0n,
  triggerPositionId: 0n,
})

describe('signed strategy history and fake RPC', () => {
  function historyFixture(order = descriptor, target = false) {
    const proof = receipt(order, target ? log('OrderCancelled', [0n, 1n, 100n], 1) : undefined)
    let fail = false
    const transport = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === 'https://fake-rpc.invalid') {
        const body = JSON.parse(String(init?.body)) as { method: string }
        return new Response(
          JSON.stringify({
            result: fail ? null : body.method === 'eth_getTransactionByHash' ? proof.tx : proof.result,
          }),
        )
      }
      expect((init?.headers as Record<string, string>)['X-API-Signature']).toBe('fixture-signature')
      return new Response(
        JSON.stringify(
          String(url).includes('/wallet')
            ? { at: { b: 120 }, as: [{ id: 642, b: '100', lb: '0', lfr: order.orderDescId.toString() }] }
            : {
                d: [
                  {
                    acc: 642,
                    mkt: Number(order.perpId),
                    rq: target ? '44' : order.orderDescId.toString(),
                    oid: 75,
                    t: 1,
                    st: target ? 5 : 2,
                    sr: 0,
                    os: 100,
                    fs: 0,
                    at: { b: 110, txid: hash.slice(2) },
                  },
                ],
              },
        ),
      )
    }
    const history = new PerplHistory(
      'https://fake-perpl.invalid',
      { apiKey: 'fixture', sign: async () => 'fixture-signature' },
      transport as typeof fetch,
      'https://fake-rpc.invalid',
      exchange,
    )
    return {
      history,
      fail: () => {
        fail = true
      },
    }
  }
  it('reads OPEN history and a CANCEL target carrying its original request ID', async () => {
    expect(await historyFixture().history.strategyCommandEvidence(642, '45', 16)).toMatchObject({
      historyComplete: true,
      operations: [{ outcome: 'PLACED' }],
      account: { lfr: '45', block: 120 },
    })
    const cancel = {
      ...descriptor,
      orderType: 4,
      orderId: 75n,
      orderDescId: 46n,
      pricePNS: 0n,
      lotLNS: 0n,
      postOnly: false,
      leverageHdths: 0n,
    }
    expect(await historyFixture(cancel, true).history.strategyCommandEvidence(642, '46', 16, 75)).toMatchObject({
      history: [{ rq: '44' }],
      operations: [{ requestId: '46', outcome: 'CANCELED' }],
    })
  })
  it('keeps another market visible for superseded request detection and fails closed on unavailable receipts', async () => {
    expect(
      (await historyFixture({ ...descriptor, perpId: 17n }).history.strategyCommandEvidence(642, '45', 16)).operations,
    ).toMatchObject([{ marketId: 17 }])
    const f = historyFixture()
    f.fail()
    await expect(f.history.strategyCommandEvidence(642, '45', 16)).rejects.toThrow('PERPL_RECONCILIATION_RPC_INVALID')
  })
})
function log(name: string, values: unknown[], index: number) {
  const event = abi.find((item) => item.type === 'event' && item.name === name) as AbiEvent
  return {
    address: exchange,
    topics: encodeEventTopics({ abi: [event], eventName: name }),
    data: encodeAbiParameters(event.inputs, values),
    logIndex: `0x${index.toString(16)}`,
    blockNumber: '0x6e',
    transactionHash: hash,
    transactionIndex: '0x0',
    removed: false,
  }
}
function request(order = descriptor, name = 'OrderRequest') {
  const values = [
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
    1000n,
  ]
  return log(name, name === 'OrderRequestV2' ? [...values, '0x'] : values, 0)
}
function receipt(order = descriptor, outcome = log('OrderPlaced', [75n, 100n, 1n, -1n, 99n], 1)) {
  const tx = {
    hash,
    to: exchange,
    input: encodeFunctionData({ abi, functionName: 'execFwdPositionOpsV2', args: [[envelope(order)], []] }),
  }
  const result = {
    status: '0x1',
    to: exchange,
    transactionHash: hash,
    blockNumber: '0x6e',
    transactionIndex: '0x0',
    logs: [request(order), outcome],
  }
  return { tx, result }
}
const verify = (value: ReturnType<typeof receipt>) =>
  verifyStrategyCommandReceipt(exchange, hash, value.tx, value.result)

describe('receipt-backed strategy command vectors', () => {
  it('proves a post-only POST only with matching request and placement events', () => {
    expect(verify(receipt())).toMatchObject([
      {
        accountId: 642,
        requestId: '45',
        marketId: 16,
        type: 1,
        orderId: '0',
        sizeRaw: '100',
        priceRaw: '990',
        postOnly: true,
        immediateOrCancel: false,
        lastExecutionBlock: 120,
        block: 110,
        txHash: hash,
        outcome: 'PLACED',
        venueOrderId: 75,
      },
    ])
    const v2 = receipt()
    v2.result.logs[0] = request(descriptor, 'OrderRequestV2')
    expect(verify(v2)).toHaveLength(1)
  })
  it('proves CHANGE and CANCEL against the exact request target, not its original rq', () => {
    const change = { ...descriptor, orderType: 6, orderId: 75n, postOnly: false, leverageHdths: 0n }
    expect(verify(receipt(change, log('OrderChanged', [75n, 990n, 100n, 0n, 1n, 99n], 1)))).toMatchObject([
      { type: 7, outcome: 'CHANGED', venueOrderId: 75 },
    ])
    const cancel = { ...change, orderType: 4, lotLNS: 0n, pricePNS: 0n }
    expect(verify(receipt(cancel, log('OrderCancelled', [0n, 1n, 100n], 1)))).toMatchObject([
      { type: 5, outcome: 'CANCELED', venueOrderId: 75 },
    ])
  })
  it('does not turn receipt success, a skipped command or a failed post into admission', () => {
    const skipped = receipt()
    skipped.result.logs = []
    expect(verify(skipped)).toEqual([])
    const noOutcome = receipt()
    noOutcome.result.logs = [request()]
    expect(verify(noOutcome)[0]?.outcome).toBe('UNVERIFIED')
    expect(verify(receipt(descriptor, log('OrderPostFailed', [32n], 1)))[0]?.outcome).toBe('REJECTED')
  })
  it('rejects forged destination, hash, receipt status, stamp or request context', () => {
    for (const field of ['destination', 'hash', 'status', 'stamp', 'context']) {
      const value = receipt()
      if (field === 'destination') value.tx.to = '0x0000000000000000000000000000000000000002'
      if (field === 'hash') value.result.transactionHash = `0x${'b'.repeat(64)}`
      if (field === 'status') value.result.status = '0x0'
      if (field === 'stamp') value.result.logs[1].blockNumber = '0x6f'
      if (field === 'context') value.result.logs[0] = request({ ...descriptor, pricePNS: 991n })
      expect(verify(value)).toEqual([])
    }
  })
  it('does not borrow a different order, admin cancel, trigger or batch outcome', () => {
    const change = { ...descriptor, orderType: 6, orderId: 75n, postOnly: false, leverageHdths: 0n }
    expect(verify(receipt(change, log('OrderChanged', [76n, 990n, 100n, 0n, 1n, 99n], 1)))[0]?.outcome).toBe(
      'UNVERIFIED',
    )
    const cancel = { ...change, orderType: 4, lotLNS: 0n, pricePNS: 0n }
    expect(verify(receipt(cancel, log('OrderCancelledByAdmin', [16n, 642n, 75n, 0n], 1)))[0]?.outcome).toBe(
      'UNVERIFIED',
    )
    const batch = receipt()
    batch.tx.input = encodeFunctionData({
      abi,
      functionName: 'execFwdPositionOpsV2',
      args: [[envelope(), envelope({ ...descriptor, orderDescId: 46n })], []],
    })
    expect(verify(batch)).toEqual([])
    const duplicate = receipt()
    duplicate.result.logs.push(request())
    expect(verify(duplicate)).toEqual([])
    const trigger = receipt()
    trigger.result.logs.push(log('TriggerOrderRequest', [1n, 0, 0n, 0n], 2))
    expect(verify(trigger)[0]?.outcome).toBe('UNVERIFIED')
  })
  it('keeps malformed or duplicated receipt logs from producing proof', () => {
    const duplicate = receipt()
    duplicate.result.logs[1].logIndex = '0x0'
    expect(verify(duplicate)).toEqual([])
    const unknown = receipt()
    unknown.result.logs[1].topics = [`0x${'f'.repeat(64)}`]
    expect(verify(unknown)[0]?.outcome).toBe('UNVERIFIED')
  })
})
