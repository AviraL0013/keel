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
  if (!['string', 'number', 'bigint'].includes(typeof value) || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(String(value)))
    return undefined
  try {
    const n = Number(BigInt(String(value)))
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined
  } catch {
    return undefined
  }
}

/** Command admission, not a fill or a balance credit.
 * The contract may skip an individual command while its transaction succeeds.
 * The official SDK replaces context on each request and clears it at batch end.
 * Match complete calldata; skipped descriptors must not shift outcome ownership.
 * Nonempty extensions and trigger execution remain unsupported.
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
      !decoded.args[0].length ||
      (decoded.args[1].length !== 0 && decoded.args[1].length !== decoded.args[0].length) ||
      decoded.args[1].some((extension) => extension !== '0x')
    )
      return []
    const envelopes = decoded.args[0]
    const commands = new Map<string, (typeof envelopes)[number]>()
    for (const envelope of envelopes) {
      const command = envelope.orderDesc
      const key = `${envelope.accountId}:${command.orderDescId}`
      if (
        commands.has(key) ||
        !integer(envelope.accountId) ||
        !integer(command.perpId) ||
        integer(command.leverageHdths) === undefined ||
        !integer(command.lastExecutionBlock) ||
        command.orderDescId <= 0n ||
        envelope.execTriggerOrder ||
        envelope.triggerPricePNS !== 0n ||
        envelope.triggerPriceCondition !== 0 ||
        envelope.triggerRequestId !== 0n ||
        envelope.triggerPositionId !== 0n
      )
        return []
      commands.set(key, envelope)
    }
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
    type Log = (typeof logs)[number]
    type Segment = { envelope: (typeof envelopes)[number]; context: Log; logs: Log[] }
    const segments: Segment[] = []
    const seen = new Set<string>()
    let current: Segment | undefined
    for (const log of logs.sort((a, b) => a.index - b.index)) {
      if (['OrderRequest', 'OrderRequestV2'].includes(log.name)) {
        const key = `${log.args.accountId}:${log.args.orderDescId}`
        const envelope = commands.get(key)
        if (
          !envelope ||
          seen.has(key) ||
          Object.entries(envelope.orderDesc).some(([key, value]) => log.args[key] !== value) ||
          (log.name === 'OrderRequestV2' && log.args.extension !== '0x')
        )
          return []
        seen.add(key)
        current = { envelope, context: log, logs: [] }
        segments.push(current)
      } else if (log.name === 'OrderBatchCompleted') {
        current = undefined
      } else {
        current?.logs.push(log)
      }
    }
    return segments.map(({ envelope, context, logs }): VerifiedStrategyOperation => {
      const command = envelope.orderDesc
      const operation: VerifiedStrategyOperation = {
        accountId: integer(envelope.accountId)!,
        requestId: command.orderDescId.toString(),
        marketId: integer(command.perpId)!,
        type: command.orderType + 1,
        orderId: command.orderId.toString(),
        sizeRaw: command.lotLNS.toString(),
        priceRaw: command.pricePNS.toString(),
        leverageHundredths: integer(command.leverageHdths)!,
        postOnly: command.postOnly,
        fillOrKill: command.fillOrKill,
        immediateOrCancel: command.immediateOrCancel,
        expiryBlock: command.expiryBlock.toString(),
        amountRaw: command.amountCNS.toString(),
        maxNegPnlCollatBps: command.maxNegPnlCollatBPS.toString(),
        feePer100K: envelope.feePer100K.toString(),
        lastExecutionBlock: integer(command.lastExecutionBlock)!,
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
      if (!name || logs.length !== 1) return operation
      const outcome = logs[0]
      if (outcome.name === 'OrderPostFailed' && [0, 1].includes(command.orderType)) {
        return {
          ...operation,
          outcome: 'REJECTED',
          rejectionReason: String(outcome.args.reason),
          outcomeLogIndex: outcome.index,
        }
      }
      if (outcome.name !== name) return operation
      const oid = integer(name === 'OrderCancelled' ? command.orderId : outcome.args.orderId)
      if (
        !oid ||
        (name !== 'OrderPlaced' && BigInt(oid) !== command.orderId) ||
        (name !== 'OrderCancelled' && outcome.args.lotLNS !== command.lotLNS) ||
        (name === 'OrderChanged' &&
          (outcome.args.pricePNS !== command.pricePNS || outcome.args.expiryBlock !== command.expiryBlock))
      )
        return operation
      return {
        ...operation,
        outcome: name === 'OrderPlaced' ? 'PLACED' : name === 'OrderChanged' ? 'CHANGED' : 'CANCELED',
        venueOrderId: oid,
        outcomeLogIndex: outcome.index,
      }
    })
  } catch {
    return []
  }
}
