import { decodeEventLog, decodeFunctionData, parseAbi } from 'viem'

export const forwardedOrderAbi = parseAbi([
  'function execFwdPositionOpsV2((uint256 accountId,uint256 feePer100K,(uint256 orderDescId,uint256 perpId,uint8 orderType,uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS) orderDesc,bool execTriggerOrder,uint256 triggerPricePNS,uint8 triggerPriceCondition,uint256 triggerRequestId,uint256 triggerPositionId)[] forwardedOrders,bytes[] extensions)',
])
// Official Perpl SDK Exchange ABI. These events have no indexed arguments.
// Keep the independent SDK fixture and provenance in docs/strategies/order-proof.md.
const events = parseAbi([
  'event OrderRequest(uint256 perpId,uint256 accountId,uint256 orderDescId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS,uint256 gasLeft)',
  'event OrderRequestV2(uint256 perpId,uint256 accountId,uint256 orderDescId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS,uint256 gasLeft,bytes extension)',
  'event OrderPlaced(uint256 orderId,uint256 lotLNS,uint256 lockedBalanceCNS,int256 amountCNS,uint256 balanceCNS)',
  'event OrderChanged(uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,uint256 lockedBalanceCNS,uint256 balanceCNS)',
  'event OrderCancelled(uint256 lockedBalanceCNS,int256 amountCNS,uint256 balanceCNS)',
  'event OrderPostFailed(uint256 reason)',
  'event OrderBatchCompleted(uint256 gasLeft)',
])
export type VerifiedStrategyOperation = {
  accountId: number
  requestId: string
  marketId: number
  type: number
  orderId: string
  sizeRaw: string
  priceRaw: string
  leverageHundredths: number
  postOnly: boolean
  fillOrKill: boolean
  immediateOrCancel: boolean
  expiryBlock: string
  amountRaw: string
  maxNegPnlCollatBps: string
  feePer100K: string
  lastExecutionBlock: number
  block: number
  txHash: string
  requestLogIndex: number
  outcome: 'PLACED' | 'CHANGED' | 'CANCELED' | 'REJECTED' | 'UNVERIFIED'
  venueOrderId?: number
  outcomeLogIndex?: number
  rejectionReason?: string
}
const hashPattern = /^0x[0-9a-f]{64}$/i
function integer(value: unknown): number | undefined {
  try {
    const n = Number(BigInt(String(value)))
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined
  } catch {
    return undefined
  }
}

/** Command admission, not a fill or a balance credit.
 * The contract may skip an individual command while its transaction succeeds.
 * Anonymous outcome events cannot be attributed safely in an ambiguous batch.
 * Until execution ordering is independently verified, only a singleton,
 * non-triggered forwarded command with one matching request context is accepted.
 */
export function verifyStrategyCommandReceipt(
  exchange: string,
  hash: string,
  tx: Record<string, unknown>,
  receipt: Record<string, unknown>,
): VerifiedStrategyOperation[] {
  if (
    !hashPattern.test(hash) ||
    !/^0x[0-9a-f]{40}$/i.test(exchange) ||
    String(tx.to).toLowerCase() !== exchange.toLowerCase() ||
    String(receipt.to).toLowerCase() !== exchange.toLowerCase() ||
    String(tx.hash).toLowerCase() !== hash.toLowerCase() ||
    String(receipt.transactionHash).toLowerCase() !== hash.toLowerCase() ||
    receipt.status !== '0x1' ||
    !Array.isArray(receipt.logs)
  )
    return []
  const block = integer(receipt.blockNumber),
    transactionIndex = integer(receipt.transactionIndex)
  if (!block || transactionIndex === undefined) return []
  try {
    const decoded = decodeFunctionData({ abi: forwardedOrderAbi, data: String(tx.input) as `0x${string}` })
    if (
      decoded.functionName !== 'execFwdPositionOpsV2' ||
      decoded.args[0].length !== 1 ||
      decoded.args[1].some((extension) => extension !== '0x')
    )
      return []
    const envelope = decoded.args[0][0],
      command = envelope.orderDesc
    if (
      envelope.execTriggerOrder ||
      envelope.triggerPricePNS !== 0n ||
      envelope.triggerPriceCondition !== 0 ||
      envelope.triggerRequestId !== 0n ||
      envelope.triggerPositionId !== 0n
    )
      return []
    const indices = new Set<number>()
    const logs: Array<{ name: string; args: Record<string, unknown>; index: number }> = []
    for (const raw of receipt.logs) {
      if (!raw || typeof raw !== 'object') return []
      const log = raw as Record<string, unknown>
      if (String(log.address).toLowerCase() !== exchange.toLowerCase()) continue
      const index = integer(log.logIndex)
      if (
        index === undefined ||
        indices.has(index) ||
        log.removed === true ||
        integer(log.blockNumber) !== block ||
        integer(log.transactionIndex) !== transactionIndex ||
        String(log.transactionHash).toLowerCase() !== hash.toLowerCase()
      )
        return []
      indices.add(index)
      try {
        const event = decodeEventLog({
          abi: events,
          data: String(log.data) as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          strict: true,
        })
        logs.push({ name: event.eventName, args: event.args, index })
      } catch {
        logs.push({ name: 'UNRECOGNIZED', args: {}, index })
      }
    }
    const contexts = logs.filter((log) => ['OrderRequest', 'OrderRequestV2'].includes(log.name))
    if (contexts.length !== 1) return []
    const context = contexts[0]
    if (
      context.args.accountId !== envelope.accountId ||
      Object.entries(command).some(([key, value]) => context.args[key] !== value) ||
      (context.name === 'OrderRequestV2' && context.args.extension !== '0x')
    )
      return []
    const accountId = integer(envelope.accountId),
      marketId = integer(command.perpId)
    const leverage = integer(command.leverageHdths),
      lb = integer(command.lastExecutionBlock)
    if (!accountId || !marketId || leverage === undefined || !lb || command.orderDescId <= 0n) return []
    const operation: VerifiedStrategyOperation = {
      accountId,
      requestId: command.orderDescId.toString(),
      marketId,
      type: command.orderType + 1,
      orderId: command.orderId.toString(),
      sizeRaw: command.lotLNS.toString(),
      priceRaw: command.pricePNS.toString(),
      leverageHundredths: leverage,
      postOnly: command.postOnly,
      fillOrKill: command.fillOrKill,
      immediateOrCancel: command.immediateOrCancel,
      expiryBlock: command.expiryBlock.toString(),
      amountRaw: command.amountCNS.toString(),
      maxNegPnlCollatBps: command.maxNegPnlCollatBPS.toString(),
      feePer100K: envelope.feePer100K.toString(),
      lastExecutionBlock: lb,
      block,
      txHash: hash.toLowerCase(),
      requestLogIndex: context.index,
      outcome: 'UNVERIFIED',
    }
    const name = [0, 1].includes(command.orderType)
      ? 'OrderPlaced'
      : command.orderType === 6
        ? 'OrderChanged'
        : command.orderType === 4
          ? 'OrderCancelled'
          : undefined
    const outcomes = logs.filter((log) => log.name === name || log.name === 'OrderPostFailed')
    if (
      !name ||
      outcomes.length !== 1 ||
      outcomes[0].index <= context.index ||
      logs.some(
        (log) => !['OrderRequest', 'OrderRequestV2', 'OrderBatchCompleted', name, 'OrderPostFailed'].includes(log.name),
      )
    )
      return [operation]
    const outcome = outcomes[0]
    if (outcome.name === 'OrderPostFailed' && [0, 1].includes(command.orderType)) {
      return [
        {
          ...operation,
          outcome: 'REJECTED',
          rejectionReason: String(outcome.args.reason),
          outcomeLogIndex: outcome.index,
        },
      ]
    }
    const oid = integer(name === 'OrderCancelled' ? command.orderId : outcome.args.orderId)
    if (
      !oid ||
      (name !== 'OrderPlaced' && BigInt(oid) !== command.orderId) ||
      (name !== 'OrderCancelled' && outcome.args.lotLNS !== command.lotLNS) ||
      (name === 'OrderChanged' &&
        (outcome.args.pricePNS !== command.pricePNS || outcome.args.expiryBlock !== command.expiryBlock))
    )
      return [operation]
    return [
      {
        ...operation,
        outcome: name === 'OrderPlaced' ? 'PLACED' : name === 'OrderChanged' ? 'CHANGED' : 'CANCELED',
        venueOrderId: oid,
        outcomeLogIndex: outcome.index,
      },
    ]
  } catch {
    return []
  }
}
