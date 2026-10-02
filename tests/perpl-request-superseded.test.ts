import { describe, expect, it, vi } from 'vitest'
import { PerplLiveAdapter } from '../packages/perpl/src/live.js'
import type { Action } from '../packages/domain/src/index.js'
import { PerplHistory } from '../packages/perpl/src/history.js'
import { encodeFunctionData, parseAbi } from 'viem'

const action: Action = {
  id: 'action',
  bookId: 'book',
  decisionId: 'decision',
  kind: 'DEFEND',
  amount: 1,
  status: 'UNKNOWN',
  idempotencyKey: 'once',
  venueReference: '642:45',
  venueProgress: {
    requestId: '45',
    clientSequence: 1,
    admitted: true,
    requestedLastExecBlock: 120,
    response: 'TIMEOUT',
  },
}

const context = {
  accountId: 642,
  marketId: 16,
  positionId: 77,
  collateralDecimals: 6,
  position: { bookId: 'book', side: 'LONG', status: 'OPEN', size: 1, entryPrice: 100 },
  headBlock: 100,
  orderTtlBlocks: 20,
  sizeDecimals: 0,
  priceDecimals: 0,
  leverageHundredths: 500,
}

function adapter(lfr: string, operationType: number, amountRaw = '1000000') {
  const order = {
    acc: 642,
    mkt: 16,
    oid: 8,
    rq: '45',
    st: 4,
    sr: 0,
    t: operationType,
    os: 1,
    fs: 1,
    lp: 77,
    at: { b: 115, txid: 'a'.repeat(64) },
  }
  const history = {
    evidence: vi.fn(async () => ({
      orders: [],
      positions: [],
      accounts: [],
      fills: [],
      collateralSuccess: operationType === 6 ? { txHash: `0x${order.at.txid}`, block: 115 } : undefined,
    })),
    verifiedRequestOperations: vi.fn(async () => [
      {
        requestId: '45',
        type: order.t,
        marketId: order.mkt,
        positionId: order.lp,
        amountRaw,
        txHash: `0x${order.at.txid}`,
      },
    ]),
  }
  const client = { stateSnapshot: () => ({ accounts: [{ id: 642, lfr }] }) }
  return {
    live: new PerplLiveAdapter(
      client as never,
      async () => context as never,
      history as never,
      async () => undefined,
    ),
    history,
  }
}

describe('Perpl request ID supersession', () => {
  it('fails an unknown DEFEND when signed history proves the ID executed as a close', async () => {
    const { live } = adapter('45', 3)
    expect(await live.reconcile(action)).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_REQUEST_ID_SUPERSEDED',
      venueProgress: { supersededBy: { requestId: '45', type: 3, marketId: 16, positionId: 77 } },
    })
  })

  it('does not fail before the account reaches that request ID', async () => {
    const { live, history } = adapter('44', 3)
    expect((await live.reconcile(action)).status).toBe('UNKNOWN')
    expect(history.verifiedRequestOperations).not.toHaveBeenCalled()
  })

  it('does not supersede the same operation', async () => {
    const { live } = adapter('45', 6)
    expect((await live.reconcile(action)).status).toBe('CONFIRMED')
  })

  it('fails the same type when the verified amount differs', async () => {
    const { live } = adapter('45', 6, '999999')
    expect(await live.reconcile(action)).toMatchObject({ status: 'FAILED', error: 'PERPL_REQUEST_ID_SUPERSEDED' })
  })

  it('accepts a completed signed order only when its on-chain call and receipt match', async () => {
    const exchange = '0x1964c32f0be608e7d29302aff5e61268e72080cc'
    const txHash = `0x${'a'.repeat(64)}`
    const abi = parseAbi([
      'function execFwdPositionOpsV2((uint256 accountId,uint256 feePer100K,(uint256 orderDescId,uint256 perpId,uint8 orderType,uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS) orderDesc,bool execTriggerOrder,uint256 triggerPricePNS,uint8 triggerPriceCondition,uint256 triggerRequestId,uint256 triggerPositionId)[] forwardedOrders,bytes[] extensions)',
    ])
    const input = encodeFunctionData({
      abi,
      functionName: 'execFwdPositionOpsV2',
      args: [
        [
          {
            accountId: 642n,
            feePer100K: 0n,
            orderDesc: {
              orderDescId: 45n,
              perpId: 16n,
              orderType: 2,
              orderId: 0n,
              pricePNS: 0n,
              lotLNS: 1n,
              expiryBlock: 0n,
              postOnly: false,
              fillOrKill: false,
              immediateOrCancel: true,
              maxMatches: 1n,
              leverageHdths: 0n,
              lastExecutionBlock: 120n,
              amountCNS: 0n,
              maxNegPnlCollatBPS: 0n,
            },
            execTriggerOrder: false,
            triggerPricePNS: 0n,
            triggerPriceCondition: 0,
            triggerRequestId: 0n,
            triggerPositionId: 77n,
          },
        ],
        [],
      ],
    })
    let receiptStatus = '0x1'
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://rpc') {
        const { method } = JSON.parse(String(init?.body)) as { method: string }
        return new Response(
          JSON.stringify({
            result:
              method === 'eth_getTransactionByHash'
                ? { to: exchange, input }
                : { status: receiptStatus, transactionHash: txHash, blockNumber: '0x73' },
          }),
        )
      }
      return new Response(
        JSON.stringify({
          d: [
            {
              acc: 642,
              mkt: 16,
              oid: 8,
              rq: '45',
              st: 4,
              sr: 0,
              t: 3,
              os: 1,
              fs: 1,
              lp: 77,
              at: { b: 115, txid: txHash.slice(2) },
            },
          ],
        }),
      )
    }) as typeof fetch
    const history = new PerplHistory(
      'https://perpl',
      { apiKey: 'fake', sign: async () => 'fake' },
      transport,
      'https://rpc',
      exchange,
    )
    expect(await history.verifiedRequestOperations(642, '45')).toMatchObject([
      { requestId: '45', type: 3, marketId: 16, positionId: 77, sizeRaw: '1', txHash },
    ])
    receiptStatus = '0x0'
    expect(await history.verifiedRequestOperations(642, '45')).toEqual([])
  })
})
