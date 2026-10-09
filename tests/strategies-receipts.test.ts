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
  function historyFixture(
    order = descriptor,
    target = false,
    suppliedProof?: ReturnType<typeof receipt>,
    rows?: object[],
  ) {
    const proof = suppliedProof ?? receipt(order, target ? log('OrderCancelled', [0n, 1n, 100n], 1) : undefined)
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
                d: rows ?? [
                  {
                    acc: 642,
                    mkt: Number(order.perpId),
                    rq: target ? '44' : order.orderDescId.toString(),
                    oid: 75,
                    scid: 75,
                    t: 1,
                    st: target ? 5 : 2,
                    sr: 0,
                    os: 100,
                    fs: 0,
                    c: { b: target ? 109 : 110, tx: 0, txid: target ? 'b'.repeat(64) : hash.slice(2) },
                    at: { b: 110, tx: 0, l: proof.result.logs.length - 1, txid: hash.slice(2) },
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
  it('bridges distinct API market/order IDs through signed creation identity, never from contract slot equality', async () => {
    const row = {
      acc: 642,
      mkt: 116,
      oid: 90075,
      scid: 75,
      rq: '45',
      t: 1,
      st: 2,
      sr: 0,
      os: 100,
      fs: 0,
      c: { b: 110, tx: 0, txid: hash.slice(2) },
      at: { b: 110, tx: 0, l: 1, txid: hash.slice(2) },
    }
    const value = await historyFixture(descriptor, false, undefined, [row]).history.strategyCommandEvidence(
      642,
      '45',
      116,
      undefined,
      undefined,
      { contractMarketId: 16 },
    )
    expect(value.operations).toMatchObject([
      {
        marketId: 16,
        contractOrderId: 75,
        venueOrderId: 90075,
        identity: {
          accountId: 642,
          marketId: 116,
          contractMarketId: 16,
          venueOrderId: 90075,
          contractOrderId: 75,
          creationBlock: 110,
          creationTransactionIndex: 0,
          creationTxHash: hash,
          placementRequestId: '45',
          type: 1,
        },
      },
    ])
    for (const change of [
      { scid: 76 },
      { c: { ...row.c, txid: 'b'.repeat(64) } },
      { c: undefined },
      { scid: undefined },
    ]) {
      const bad = await historyFixture(descriptor, false, undefined, [
        { ...row, ...change },
      ]).history.strategyCommandEvidence(642, '45', 116, undefined, undefined, { contractMarketId: 16 })
      expect(bad.operations.every((op) => op.venueOrderId === undefined)).toBe(true)
    }
  })
  it('does not fabricate market mapping when durable contract terms are absent', async () => {
    expect((await historyFixture().history.strategyCommandEvidence(642, '45', 16)).operations).toEqual([])
  })
  it('binds CANCEL to the original API lifetime and transaction-local outcome, rejecting reused slots and global stamps', async () => {
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
    const proof = receipt(cancel)
    proof.result.logs = [
      { ...log('OrderBatchCompleted', [1n], 40), address: '0x0000000000000000000000000000000000000002' },
      request(cancel, 'OrderRequest', 41),
      log('OrderCancelled', [0n, 1n, 100n], 42),
    ]
    const targetIdentity = {
      accountId: 642,
      marketId: 116,
      contractMarketId: 16,
      venueOrderId: 90075,
      contractOrderId: 75,
      placementRequestId: '44',
      type: 1,
      creationBlock: 109,
      creationTransactionIndex: 0,
      creationTxHash: `0x${'b'.repeat(64)}`,
    }
    const row = {
      acc: 642,
      mkt: 116,
      oid: 90075,
      scid: 75,
      rq: '44',
      t: 1,
      st: 5,
      sr: 0,
      os: 100,
      fs: 0,
      c: { b: 109, tx: 0, txid: 'b'.repeat(64) },
      at: { b: 110, tx: 0, l: 2, txid: hash.slice(2) },
    }
    const read = (rows: object[]) =>
      historyFixture(cancel, true, proof, rows).history.strategyCommandEvidence(642, '46', 116, 90075, undefined, {
        contractMarketId: 16,
        targetIdentity,
      })
    expect((await read([row])).operations).toMatchObject([
      {
        outcome: 'CANCELED',
        contractOrderId: 75,
        venueOrderId: 90075,
        outcomeLogIndex: 42,
        outcomeTransactionLogIndex: 2,
        identity: targetIdentity,
      },
    ])
    for (const change of [{ scid: 76 }, { c: { ...row.c, b: 108 } }, { at: { ...row.at, l: 42 } }, { oid: 90076 }]) {
      expect((await read([{ ...row, ...change }])).operations.every((op) => op.venueOrderId === undefined)).toBe(true)
    }
  })
  it('reads OPEN history and a CANCEL target carrying its original request ID', async () => {
    expect(
      await historyFixture().history.strategyCommandEvidence(642, '45', 16, undefined, undefined, {
        contractMarketId: 16,
      }),
    ).toMatchObject({
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
    const targetIdentity = {
      accountId: 642,
      marketId: 16,
      contractMarketId: 16,
      venueOrderId: 75,
      contractOrderId: 75,
      placementRequestId: '44',
      type: 1,
      creationBlock: 109,
      creationTransactionIndex: 0,
      creationTxHash: `0x${'b'.repeat(64)}`,
    }
    expect(
      await historyFixture(cancel, true).history.strategyCommandEvidence(642, '46', 16, 75, undefined, {
        contractMarketId: 16,
        targetIdentity,
      }),
    ).toMatchObject({
      history: [{ rq: '44' }],
      operations: [{ requestId: '46', outcome: 'CANCELED' }],
    })
  })
  it('keeps another market visible for superseded request detection and fails closed on unavailable receipts', async () => {
    expect(
      (
        await historyFixture({ ...descriptor, perpId: 17n }).history.strategyCommandEvidence(
          642,
          '45',
          16,
          undefined,
          undefined,
          { contractMarketId: 16 },
        )
      ).operations,
    ).toMatchObject([{ marketId: 17 }])
    const f = historyFixture()
    f.fail()
    await expect(
      f.history.strategyCommandEvidence(642, '45', 16, undefined, undefined, { contractMarketId: 16 }),
    ).rejects.toThrow('PERPL_RECONCILIATION_RPC_INVALID')
  })
  it('returns only the owned requested command from a mixed-account forwarded receipt', async () => {
    const proof = receipt()
    proof.tx.input = encodeFunctionData({
      abi,
      functionName: 'execFwdPositionOpsV2',
      args: [[{ ...envelope(), accountId: 643n }, envelope()], []],
    })
    proof.result.logs = [
      request(descriptor, 'OrderRequest', 0, 643n),
      log('OrderPlaced', [76n, 100n, 1n, -1n, 99n], 1),
      request(descriptor, 'OrderRequest', 2),
      log('OrderPlaced', [75n, 100n, 1n, -1n, 99n], 3),
    ]
    const evidence = await historyFixture(descriptor, false, proof).history.strategyCommandEvidence(
      642,
      '45',
      16,
      undefined,
      undefined,
      { contractMarketId: 16 },
    )
    expect(evidence.operations).toHaveLength(1)
    expect(evidence.operations[0]).toMatchObject({
      accountId: 642,
      requestId: '45',
      venueOrderId: 75,
      requestLogIndex: 2,
      outcomeLogIndex: 3,
    })
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
function request(order = descriptor, name = 'OrderRequest', index = 0, accountId = 642n, extension = '0x') {
  const values = [
    order.perpId,
    accountId,
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
  return log(name, name === 'OrderRequestV2' ? [...values, extension] : values, index)
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
  it('keeps block-global indices separate from transaction ordinals including other emitters', () => {
    const value = receipt()
    const foreign = { ...log('OrderBatchCompleted', [1n], 40), address: '0x0000000000000000000000000000000000000002' }
    value.result.logs = [
      log('OrderPlaced', [75n, 100n, 1n, -1n, 99n], 42),
      foreign,
      request(descriptor, 'OrderRequest', 41),
    ]
    expect(verify(value)).toMatchObject([
      {
        requestLogIndex: 41,
        outcomeLogIndex: 42,
        requestTransactionLogIndex: 1,
        outcomeTransactionLogIndex: 2,
        transactionIndex: 0,
        contractOrderId: 75,
      },
    ])
    expect(verify(value)[0]).not.toHaveProperty('venueOrderId')
    value.result.logs[0].logIndex = '0x29'
    expect(verify(value)).toEqual([])
  })
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
        contractOrderId: 75,
      },
    ])
    const v2 = receipt()
    v2.result.logs[0] = request(descriptor, 'OrderRequestV2')
    expect(verify(v2)).toHaveLength(1)
  })
  it('proves CHANGE and CANCEL against the exact request target, not its original rq', () => {
    const change = { ...descriptor, orderType: 6, orderId: 75n, postOnly: false, leverageHdths: 0n }
    expect(verify(receipt(change, log('OrderChanged', [75n, 990n, 100n, 0n, 1n, 99n], 1)))).toMatchObject([
      { type: 7, outcome: 'CHANGED', contractOrderId: 75 },
    ])
    const cancel = { ...change, orderType: 4, lotLNS: 0n, pricePNS: 0n }
    expect(verify(receipt(cancel, log('OrderCancelled', [0n, 1n, 100n], 1)))).toMatchObject([
      { type: 5, outcome: 'CANCELED', contractOrderId: 75 },
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
  it('does not borrow a different order, admin cancel, trigger or skipped batch outcome', () => {
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
    expect(verify(batch)).toMatchObject([{ requestId: '45', outcome: 'PLACED', contractOrderId: 75 }])
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
  it('rejects empty, whitespace and non-scalar receipt indices instead of coercing them to zero', () => {
    for (const invalid of ['', ' ', '\t', [], [0], {}, null, '+0', '0x', '-1', 0.5]) {
      const value = receipt()
      value.result.transactionIndex = invalid as string
      for (const entry of value.result.logs) entry.transactionIndex = invalid as string
      value.result.logs[0].logIndex = invalid as string
      expect(verify(value)).toEqual([])
    }
  })
})

// Perpl SDK state/exchange.rs processes request contexts in log-index order,
// replaces them on each request, and clears them on OrderBatchCompleted.
describe('forwarded batch strategy command attribution', () => {
  const change = {
    ...descriptor,
    orderDescId: 46n,
    orderType: 6,
    orderId: 75n,
    postOnly: false,
    leverageHdths: 0n,
  }
  const cancel = { ...change, orderDescId: 47n, orderType: 4, lotLNS: 0n, pricePNS: 0n }
  const placed = (id: bigint, index: number) => log('OrderPlaced', [id, 100n, 1n, -1n, 99n], index)
  const changed = (index: number) => log('OrderChanged', [75n, 990n, 100n, 0n, 1n, 99n], index)
  const canceled = (index: number) => log('OrderCancelled', [0n, 1n, 100n], index)
  function batch(commands: ReturnType<typeof envelope>[], logs: ReturnType<typeof log>[]) {
    const value = receipt()
    value.tx.input = encodeFunctionData({ abi, functionName: 'execFwdPositionOpsV2', args: [commands, []] })
    value.result.logs = logs
    return value
  }

  it('proves separate POST, CHANGE and CANCEL segments in receipt log order', () => {
    const value = batch(
      [envelope(), envelope(change), envelope(cancel)],
      [
        request(),
        placed(75n, 1),
        request(change, 'OrderRequestV2', 2),
        changed(3),
        request(cancel, 'OrderRequestV2', 4),
        canceled(5),
        log('OrderBatchCompleted', [100n], 6),
      ].reverse(),
    )
    expect(verify(value)).toMatchObject([
      { requestId: '45', outcome: 'PLACED', requestLogIndex: 0, outcomeLogIndex: 1, contractOrderId: 75 },
      { requestId: '46', outcome: 'CHANGED', requestLogIndex: 2, outcomeLogIndex: 3, contractOrderId: 75 },
      { requestId: '47', outcome: 'CANCELED', requestLogIndex: 4, outcomeLogIndex: 5, contractOrderId: 75 },
    ])
  })

  it('matches complete calldata rather than pairing skipped descriptors by ordinal', () => {
    const own = { ...descriptor, orderDescId: 48n, perpId: 17n }
    expect(verify(batch([envelope(), envelope(own)], [request(own), placed(76n, 1)]))).toMatchObject([
      { requestId: '48', marketId: 17, outcome: 'PLACED', contractOrderId: 76 },
    ])
    const forged = batch([envelope(), envelope(own)], [request({ ...own, maxMatches: 2n }), placed(76n, 1)])
    expect(verify(forged)).toEqual([])
  })

  it('keeps a skipped or failed POST separate from the next command success', () => {
    const next = { ...descriptor, orderDescId: 48n }
    for (const failure of [[], [log('OrderPostFailed', [32n], 1)]]) {
      expect(
        verify(
          batch(
            [envelope(), envelope(next)],
            [request(), ...failure, request(next, 'OrderRequest', failure.length + 1), placed(76n, failure.length + 2)],
          ),
        ),
      ).toMatchObject([
        { requestId: '45', outcome: failure.length ? 'REJECTED' : 'UNVERIFIED' },
        { requestId: '48', outcome: 'PLACED', contractOrderId: 76 },
      ])
    }
  })

  it('isolates unknown, trigger and conflicting events to their own segment', () => {
    const next = { ...descriptor, orderDescId: 48n }
    const unknown = placed(75n, 2)
    unknown.topics = [`0x${'f'.repeat(64)}`]
    for (const extra of [unknown, log('TriggerOrderRequest', [1n, 0, 0n, 0n], 2), placed(77n, 2)]) {
      expect(
        verify(
          batch(
            [envelope(), envelope(next)],
            [request(), placed(75n, 1), extra, request(next, 'OrderRequest', 3), placed(76n, 4)],
          ),
        ),
      ).toMatchObject([
        { requestId: '45', outcome: 'UNVERIFIED' },
        { requestId: '48', outcome: 'PLACED', contractOrderId: 76 },
      ])
    }
  })

  it('clears context at batch completion and never borrows an outcome across it', () => {
    expect(
      verify(
        batch(
          [envelope(), envelope(cancel)],
          [
            request(),
            log('OrderBatchCompleted', [100n], 1),
            placed(75n, 2),
            request(cancel, 'OrderRequest', 3),
            canceled(4),
          ],
        ),
      ),
    ).toMatchObject([
      { requestId: '45', outcome: 'UNVERIFIED' },
      { requestId: '47', outcome: 'CANCELED', contractOrderId: 75 },
    ])
    expect(verify(batch([envelope()], [placed(75n, 0), request(descriptor, 'OrderRequest', 1)]))).toMatchObject([
      { requestId: '45', outcome: 'UNVERIFIED' },
    ])
  })

  it('refuses duplicate request identity in calldata or multiple contexts', () => {
    expect(
      verify(batch([envelope(), envelope({ ...descriptor, pricePNS: 991n })], [request(), placed(75n, 1)])),
    ).toEqual([])
    expect(
      verify(batch([envelope()], [request(), placed(75n, 1), request(descriptor, 'OrderRequest', 2), placed(76n, 3)])),
    ).toEqual([])
  })

  it('keeps equal request IDs on different accounts distinct', () => {
    const other = { ...envelope(), accountId: 643n }
    expect(
      verify(
        batch(
          [envelope(), other],
          [request(), placed(75n, 1), request(descriptor, 'OrderRequest', 2, 643n), placed(76n, 3)],
        ),
      ),
    ).toMatchObject([
      { accountId: 642, requestId: '45', contractOrderId: 75 },
      { accountId: 643, requestId: '45', contractOrderId: 76 },
    ])
  })

  // Independent manual ABI words from the pinned official extension.rs example:
  // uint16 version, bytes offset, bytes length, uint256 builder, uint256 fee.
  const builderExtension = (builder = 25n, fee = 0n, version = 1n) =>
    `0x${[version, 64n, 64n, builder, fee].map((word) => word.toString(16).padStart(64, '0')).join('')}` as `0x${string}`
  const attributed = (extension: `0x${string}`, eventExtension = extension, name = 'OrderRequestV2') => {
    const value = batch([envelope()], [request(descriptor, name, 0, 642n, eventExtension), placed(75n, 1)])
    value.tx.input = encodeFunctionData({
      abi,
      functionName: 'execFwdPositionOpsV2',
      args: [[envelope()], [extension]],
    })
    return value
  }
  it('proves builder 25 attribution even when its fee is zero', () => {
    expect(verify(attributed(builderExtension()))).toMatchObject([
      { outcome: 'PLACED', builderId: 25, builderFeePer100K: '0' },
    ])
    expect(verify(attributed(builderExtension(0n)))).toMatchObject([
      { outcome: 'PLACED', builderId: 0, builderFeePer100K: '0' },
    ])
    expect(verify(attributed(builderExtension(255n, 1000n)))).toMatchObject([
      { builderId: 255, builderFeePer100K: '1000' },
    ])
  })
  it('binds distinct builder envelopes by command array index without ordinal log pairing', () => {
    const first = builderExtension(),
      second = builderExtension(26n)
    const value = batch(
      [envelope(), envelope(change)],
      [
        request(descriptor, 'OrderRequestV2', 0, 642n, first),
        placed(75n, 1),
        request(change, 'OrderRequestV2', 2, 642n, second),
        changed(3),
      ],
    )
    value.tx.input = encodeFunctionData({
      abi,
      functionName: 'execFwdPositionOpsV2',
      args: [
        [envelope(), envelope(change)],
        [first, second],
      ],
    })
    expect(verify(value)).toMatchObject([
      { requestId: '45', builderId: 25, outcome: 'PLACED' },
      { requestId: '46', builderId: 26, outcome: 'CHANGED' },
    ])
    value.result.logs[2] = request(change, 'OrderRequestV2', 2, 642n, first)
    expect(verify(value)).toEqual([])
  })
  it('rejects mismatched, missing, unsupported and noncanonical builder extensions', () => {
    for (const extension of [
      '0x01',
      builderExtension(256n),
      builderExtension(25n, 1001n),
      builderExtension(25n, 0n, 2n),
      `${builderExtension()}${'00'.repeat(32)}`,
      `0x${'00'.repeat(257)}`,
    ] as `0x${string}`[])
      expect(verify(attributed(extension))).toEqual([])
    expect(verify(attributed(builderExtension(), builderExtension(26n)))).toEqual([])
    expect(verify(attributed(builderExtension(), '0x'))).toEqual([])
    expect(verify(attributed(builderExtension(), builderExtension(), 'OrderRequest'))).toEqual([])
  })

  it('keeps malformed extensions, triggered envelopes and unrelated calldata unverified', () => {
    const value = batch([envelope()], [request(), placed(75n, 1)])
    value.tx.input = encodeFunctionData({ abi, functionName: 'execFwdPositionOpsV2', args: [[envelope()], ['0x01']] })
    expect(verify(value)).toEqual([])
    const triggered = { ...envelope(), execTriggerOrder: true }
    expect(verify(batch([triggered], [request(), placed(75n, 1)]))).toEqual([])
    expect(verify(batch([envelope(change)], [request(), placed(75n, 1)]))).toEqual([])
    value.tx.input = encodeFunctionData({
      abi,
      functionName: 'execFwdPositionOpsV2',
      args: [[envelope(), envelope(change)], ['0x']],
    })
    expect(verify(value)).toEqual([])
  })
})
