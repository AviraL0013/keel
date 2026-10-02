import type { ApiKeySigner } from './index.js'
import type { WireFill, WireOrder, WirePosition, Stamp } from './decoder.js'
import { createNonce } from './signer.js'
import { parsePerplRequestIds } from './request-id.js'
import { decodeEventLog, decodeFunctionData, parseAbi } from 'viem'
import { encodeAmount } from './units.js'
import Decimal from 'decimal.js'

export type AccountEvent = {
  id: number
  m?: number
  p?: number
  r?: string | number
  o?: number
  et: number
  a: string
  at: Stamp
}
const forwardAbi = parseAbi([
  'function execFwdPositionOpsV2((uint256 accountId,uint256 feePer100K,(uint256 orderDescId,uint256 perpId,uint8 orderType,uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS) orderDesc,bool execTriggerOrder,uint256 triggerPricePNS,uint8 triggerPriceCondition,uint256 triggerRequestId,uint256 triggerPositionId)[] forwardedOrders,bytes[] extensions)',
])
const collateralAbi = parseAbi([
  'event IncreasePositionCollateral(uint256 perpId,uint256 accountId,uint256 positionDepositCNS,uint256 amountCNS,uint256 balanceCNS)',
])
export class PerplHistory {
  constructor(
    private readonly baseUrl: string,
    private readonly signer: ApiKeySigner,
    private readonly transport: typeof fetch = fetch,
    private readonly rpcUrl?: string,
    private readonly exchangeAddress?: string,
  ) {}
  async read<T extends { at?: Stamp }>(
    resource: 'account-history' | 'order-history' | 'position-history' | 'fills',
    predicate: (item: T) => boolean,
    minBlock?: number,
  ): Promise<T[]> {
    let page: string | undefined
    const result: T[] = []
    const seen = new Set<string>()
    for (let count = 0; count < 100; count++) {
      const query = new URLSearchParams({ count: '100' })
      if (page) query.set('page', page)
      const target = `/v1/trading/${resource}?${query}`
      const timestamp = String(Date.now()),
        nonce = createNonce()
      const signature = await this.signer.sign('GET', target, '', timestamp, nonce)
      const response = await this.transport(`${this.baseUrl.replace(/\/$/, '')}${target}`, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'X-API-Key': this.signer.apiKey,
          'X-API-Timestamp': timestamp,
          'X-API-Nonce': nonce,
          'X-API-Signature': signature,
        },
      })
      if (!response.ok) throw new Error(`PERPL_HISTORY_HTTP_${response.status}`)
      const data = parsePerplRequestIds(await response.text()) as { d?: T[]; np?: string }
      if (!Array.isArray(data.d)) throw new Error('PERPL_HISTORY_INVALID')
      result.push(...data.d.filter(predicate))
      // Perpl returns newest-to-oldest pages. Keep the boundary page because
      // other events in the same block may be on its next page.
      if (
        minBlock !== undefined &&
        minBlock > 0 &&
        data.d.length > 0 &&
        data.d.every((item) => Number.isSafeInteger(item.at?.b)) &&
        data.d.at(-1)!.at!.b! < minBlock
      )
        return result
      if (!data.np) return result
      if (seen.has(data.np)) throw new Error('PERPL_HISTORY_CURSOR_LOOP')
      seen.add(data.np)
      page = data.np
    }
    throw new Error('PERPL_HISTORY_SCAN_LIMIT')
  }
  private async rpc(
    method: 'eth_getTransactionByHash' | 'eth_getTransactionReceipt',
    hash: string,
  ): Promise<Record<string, unknown>> {
    if (!this.rpcUrl) throw new Error('PERPL_RECONCILIATION_RPC_UNAVAILABLE')
    const response = await this.transport(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [hash] }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`PERPL_RECONCILIATION_RPC_HTTP_${response.status}`)
    const data = (await response.json()) as { result?: Record<string, unknown>; error?: unknown }
    if (data.error || !data.result) throw new Error('PERPL_RECONCILIATION_RPC_INVALID')
    return data.result
  }
  private async collateralReceipt(
    event: AccountEvent,
    requestId: string,
    accountId: number,
    marketId: number,
    positionId: number,
    amountRaw: string,
  ): Promise<number | undefined> {
    if (!this.rpcUrl || !this.exchangeAddress || !/^[0-9a-f]{64}$/i.test(event.at.txid ?? '')) return undefined
    const hash = `0x${event.at.txid}`
    const [tx, receipt] = await Promise.all([
      this.rpc('eth_getTransactionByHash', hash),
      this.rpc('eth_getTransactionReceipt', hash),
    ])
    if (
      String(tx.to).toLowerCase() !== this.exchangeAddress.toLowerCase() ||
      String(receipt.status) !== '0x1' ||
      String(receipt.transactionHash).toLowerCase() !== hash.toLowerCase()
    )
      return undefined
    let block: number
    try {
      block = Number(BigInt(String(receipt.blockNumber)))
    } catch {
      return undefined
    }
    if (!Number.isSafeInteger(block) || (event.at.b !== undefined && block !== event.at.b)) return undefined
    let forwarded: ReturnType<typeof decodeFunctionData<typeof forwardAbi>>
    try {
      forwarded = decodeFunctionData({ abi: forwardAbi, data: String(tx.input) as `0x${string}` })
    } catch {
      return undefined
    }
    if (forwarded.functionName !== 'execFwdPositionOpsV2') return undefined
    const match = forwarded.args[0].some(
      (item) =>
        item.accountId === BigInt(accountId) &&
        item.orderDesc.orderDescId === BigInt(requestId) &&
        item.orderDesc.perpId === BigInt(marketId) &&
        item.orderDesc.orderType === 5 &&
        item.orderDesc.amountCNS === BigInt(amountRaw) &&
        item.triggerPositionId === BigInt(positionId),
    )
    if (!match || !Array.isArray(receipt.logs)) return undefined
    const matchedLog = receipt.logs.some((raw) => {
      const log = raw as { address?: string; topics?: `0x${string}`[]; data?: `0x${string}` }
      if (log.address?.toLowerCase() !== this.exchangeAddress!.toLowerCase() || !log.topics?.length || !log.data)
        return false
      try {
        const decoded = decodeEventLog({
          abi: collateralAbi,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          data: log.data,
        })
        return (
          decoded.args.accountId === BigInt(accountId) &&
          decoded.args.perpId === BigInt(marketId) &&
          decoded.args.amountCNS === BigInt(amountRaw)
        )
      } catch {
        return false
      }
    })
    return matchedLog ? block : undefined
  }
  async verifiedRequestOperations(accountId: number, requestedId: string, minBlock?: number) {
    if (!this.rpcUrl || !this.exchangeAddress) return []
    const orders = await this.read<WireOrder>(
      'order-history',
      (item) =>
        item.acc === accountId &&
        String(item.rq) === requestedId &&
        [4, 10].includes(item.st) &&
        /^[0-9a-f]{64}$/i.test(item.at.txid ?? ''),
      minBlock,
    )
    const operations: Array<{
      requestId: string
      type: number
      marketId: number
      positionId?: number
      sizeRaw?: string
      amountRaw?: string
      block: number
      txHash: string
    }> = []
    for (const order of orders) {
      const txHash = `0x${order.at.txid}`
      const [tx, receipt] = await Promise.all([
        this.rpc('eth_getTransactionByHash', txHash),
        this.rpc('eth_getTransactionReceipt', txHash),
      ])
      let block: number
      try {
        block = Number(BigInt(String(receipt.blockNumber)))
      } catch {
        continue
      }
      if (!Number.isSafeInteger(block)) continue
      if (
        String(tx.to).toLowerCase() !== this.exchangeAddress.toLowerCase() ||
        String(receipt.status) !== '0x1' ||
        String(receipt.transactionHash).toLowerCase() !== txHash.toLowerCase() ||
        (order.at.b !== undefined && BigInt(block) !== BigInt(order.at.b))
      )
        continue
      try {
        const decoded = decodeFunctionData({ abi: forwardAbi, data: String(tx.input) as `0x${string}` })
        if (decoded.functionName !== 'execFwdPositionOpsV2') continue
        for (const item of decoded.args[0]) {
          if (
            item.accountId !== BigInt(accountId) ||
            item.orderDesc.orderDescId !== BigInt(requestedId) ||
            item.orderDesc.perpId !== BigInt(order.mkt) ||
            Number(item.orderDesc.orderType) + 1 !== order.t ||
            (order.lp !== undefined && item.triggerPositionId !== BigInt(order.lp))
          )
            continue
          operations.push({
            requestId: requestedId,
            type: Number(item.orderDesc.orderType) + 1,
            marketId: Number(item.orderDesc.perpId),
            positionId: Number(item.triggerPositionId),
            sizeRaw: item.orderDesc.lotLNS.toString(),
            amountRaw: item.orderDesc.amountCNS.toString(),
            block,
            txHash,
          })
        }
      } catch {
        continue
      }
    }
    return operations
  }
  async evidence(
    accountId: number,
    requestId: string,
    marketId: number,
    positionId: number,
    collateral?: { amount: number; decimals: number; minBlock: number },
    minBlock = collateral?.minBlock,
  ) {
    const amountRaw = collateral
      ? encodeAmount(new Decimal(collateral.amount).toFixed(), collateral.decimals)
      : undefined
    const [orders, positions, accounts, fills] = await Promise.all([
      this.read<WireOrder>(
        'order-history',
        (item) => item.acc === accountId && String(item.rq) === requestId && item.mkt === marketId,
        minBlock,
      ),
      this.read<WirePosition>(
        'position-history',
        (item) => item.acc === accountId && item.pid === positionId && item.mkt === marketId,
        minBlock,
      ),
      this.read<AccountEvent>(
        'account-history',
        (item) =>
          item.id === accountId &&
          item.m === marketId &&
          (String(item.r) === requestId ||
            (amountRaw !== undefined &&
              item.et === 3 &&
              item.p === positionId &&
              item.a === `-${amountRaw}` &&
              (item.at.b ?? 0) >= collateral!.minBlock)),
        minBlock,
      ),
      this.read<WireFill>('fills', (item) => item.acc === accountId && item.mkt === marketId, minBlock),
    ])
    let collateralSuccess: { txHash: string; block: number } | undefined
    if (amountRaw !== undefined)
      for (const event of accounts.filter(
        (item) => item.et === 3 && item.p === positionId && item.a === `-${amountRaw}`,
      )) {
        if (!positions.some((item) => item.at.txid === event.at.txid && item.pid === positionId)) continue
        const block = await this.collateralReceipt(event, requestId, accountId, marketId, positionId, amountRaw)
        if (block !== undefined) {
          collateralSuccess = { txHash: `0x${event.at.txid}`, block }
          break
        }
      }
    return {
      orders,
      positions,
      accounts,
      fills: fills.filter((fill) => orders.some((order) => order.oid === fill.oid)),
      collateralSuccess,
    }
  }
}
