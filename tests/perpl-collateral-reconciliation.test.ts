import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'
import { PerplHistory } from '../packages/perpl/src/history.js'
import { PerplLiveAdapter } from '../packages/perpl/src/live.js'
import type { Action } from '../packages/domain/src/index.js'

const exchange = '0x1964c32f0be608e7d29302aff5e61268e72080cc'
const hash = `0x${'a'.repeat(64)}`
const rq = '1791001362436'
const abi = parseAbi(['function execFwdPositionOpsV2((uint256 accountId,uint256 feePer100K,(uint256 orderDescId,uint256 perpId,uint8 orderType,uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS) orderDesc,bool execTriggerOrder,uint256 triggerPricePNS,uint8 triggerPriceCondition,uint256 triggerRequestId,uint256 triggerPositionId)[] forwardedOrders,bytes[] extensions)'])
const calldata = (requestId = rq) => encodeFunctionData({ abi, functionName: 'execFwdPositionOpsV2', args: [[{
  accountId: 642n, feePer100K: 100000n,
  orderDesc: { orderDescId: BigInt(requestId), perpId: 16n, orderType: 5, orderId: 0n, pricePNS: 0n, lotLNS: 0n, expiryBlock: 0n, postOnly: false, fillOrKill: false, immediateOrCancel: true, maxMatches: 10n, leverageHdths: 1500n, lastExecutionBlock: 65915604n, amountCNS: 22509n, maxNegPnlCollatBPS: 1000n },
  execTriggerOrder: false, triggerPricePNS: 0n, triggerPriceCondition: 0, triggerRequestId: 0n, triggerPositionId: 4206532886529n,
}], []] })
const topic = '0x577ed0a8f65f2feb5a407660b0a3009c2ee155a17d0e34947c58ecdd6c8b3771'
const eventData = encodeAbiParameters(Array.from({ length: 5 }, () => ({ type: 'uint256' as const })), [16n, 642n, 562318n, 22509n, 99434901n])
const action = { id: 'action', bookId: 'book', decisionId: 'decision', kind: 'DEFEND', amount: 0.022509, status: 'UNKNOWN', idempotencyKey: 'decision:DEFEND', venueReference: `642:${rq}:4319844237328`, beforeState: { telemetry: { block: 65915580 } } } as Action

function historyFor(requestId = rq) {
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://rpc') {
      const body = JSON.parse(String(init?.body)) as { method: string }
      const result = body.method === 'eth_getTransactionByHash'
        ? { to: exchange, input: calldata(requestId) }
        : { status: '0x1', transactionHash: hash, blockNumber: '0x3edcac4', logs: [{ address: exchange, topics: [topic], data: eventData }] }
      return new Response(JSON.stringify({ result }), { status: 200 })
    }
    const resource = new URL(url).pathname.split('/').at(-1)
    const at = { b: 65915588, txid: hash.slice(2) }
    const d = resource === 'order-history' ? [{ acc: 642, mkt: 16, rq, st: 7, sr: 32, oid: 4319844237328 }]
      : resource === 'position-history' ? [{ acc: 642, mkt: 16, pid: 4206532886529, c: '22509', at }]
      : resource === 'account-history' ? [{ id: 642, m: 16, p: 4206532886529, et: 3, a: '-22509', at }]
      : []
    return new Response(JSON.stringify({ d }), { status: 200 })
  }) as typeof fetch
  return new PerplHistory('https://perpl/api', { apiKey: 'test', sign: async () => 'signature' }, transport, 'https://rpc', exchange)
}

describe('forwarded DEFEND duplicate outcome', () => {
  it('confirms verified collateral increase despite later duplicate sr:32 failure', async () => {
    const history = historyFor()
    const context = vi.fn(async () => ({ accountId: 642, marketId: 16, positionId: 4206532886529, collateralDecimals: 6 }))
    const adapter = new PerplLiveAdapter({} as never, context as never, history, async () => undefined)
    expect(await adapter.reconcile(action)).toMatchObject({ status: 'CONFIRMED', error: undefined })
  })

  it('keeps DEFEND unresolved when account event transaction has another request ID', async () => {
    const history = historyFor('1791001362437')
    const context = vi.fn(async () => ({ accountId: 642, marketId: 16, positionId: 4206532886529, collateralDecimals: 6 }))
    const adapter = new PerplLiveAdapter({} as never, context as never, history, async () => undefined)
    expect(await adapter.reconcile(action)).toMatchObject({ status: 'UNKNOWN', error: 'COLLATERAL_OUTCOME_UNVERIFIED' })
  })
})
