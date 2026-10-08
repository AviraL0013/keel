import type { WireFill } from './decoder.js'
import { verifyStrategyCommandReceipt, type VerifiedStrategyOperation } from './strategy-receipts.js'
import { decodeEventLog } from 'viem'
import { strategyLifecycleEvents } from './strategy-lifecycle-abi.js'
import { matchesStrategyReceiptStamp, strategyReceiptHash, validStrategyOrderIdentity } from './strategy-identity.js'

export type StrategyLifecycleBlock = {
  block: Record<string, unknown>
  receipts: Record<string, unknown>[]
}
export type VerifiedStrategyMakerFill = {
  transactionHash: string
  blockHash: string
  block: number
  transactionIndex: number
  logIndex: number
  transactionLogIndex: number
  accountId: number
  marketId: number
  contractMarketId: number
  venueOrderId: number
  contractOrderId: number
  placementRequestId: string
  placementTransactionHash: string
  placementLogIndex: number
  sizeRaw: string
  priceRaw: string
  grossFeeRaw: string
  builderFeeRaw: string
  remainingSizeRaw: string
  removed: boolean
}
export type StrategyMakerFillProof =
  { status: 'VERIFIED'; fill: VerifiedStrategyMakerFill } | { status: 'UNKNOWN'; reason: string }

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const uint = (value: unknown): number | undefined => {
  if (!['string', 'number', 'bigint'].includes(typeof value) || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(String(value))) return
  const n = Number(BigInt(String(value)))
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}
const positiveWire = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const rawAmount = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)
function fail(reason: string): never {
  throw new Error(reason)
}

type NormalizedLog = {
  raw: Record<string, unknown>
  block: number
  blockHash: string
  hash: string
  tx: number
  index: number
  local: number
}
/** Enumerate every block, transaction and receipt, including empty blocks and foreign logs.
 * The configured RPC is the trust boundary; this is not a receipt-trie inclusion proof.
 * Candidate receipts or topic-filtered eth_getLogs cannot satisfy this contract.
 */
function completeBlocks(blocks: StrategyLifecycleBlock[], from: number, to: number) {
  if (!Array.isArray(blocks) || blocks.length !== to - from + 1 || blocks.length > 128)
    fail('STRATEGY_SLOT_COVERAGE_INCOMPLETE')
  const result: NormalizedLog[] = []
  const hashes = new Set<string>()
  let previousHash: string | undefined
  let receipts = 0
  for (const [offset, value] of blocks.entries()) {
    if (!object(value) || !object(value.block) || !Array.isArray(value.receipts)) fail('STRATEGY_SLOT_BLOCK_INVALID')
    const header = value.block,
      number = uint(header.number),
      blockHash = strategyReceiptHash(header.hash)
    if (
      number !== from + offset ||
      !blockHash ||
      !strategyReceiptHash(header.parentHash) ||
      (previousHash !== undefined && strategyReceiptHash(header.parentHash) !== previousHash) ||
      !Array.isArray(header.transactions) ||
      value.receipts.length !== header.transactions.length ||
      (receipts += value.receipts.length) > 2048
    )
      fail('STRATEGY_SLOT_COVERAGE_INCOMPLETE')
    previousHash = blockHash
    let nextLog = 0
    for (const [txIndex, tx] of header.transactions.entries()) {
      const receipt = value.receipts[txIndex]
      if (!object(tx) || !object(receipt)) fail('STRATEGY_SLOT_RECEIPT_MISSING')
      const hash = strategyReceiptHash(tx.hash)
      if (
        !hash ||
        hashes.has(hash) ||
        uint(tx.blockNumber) !== number ||
        strategyReceiptHash(tx.blockHash) !== blockHash ||
        uint(tx.transactionIndex) !== txIndex ||
        uint(receipt.transactionIndex) !== txIndex ||
        uint(receipt.blockNumber) !== number ||
        strategyReceiptHash(receipt.blockHash) !== blockHash ||
        strategyReceiptHash(receipt.transactionHash) !== hash ||
        !['0x0', '0x1'].includes(String(receipt.status)) ||
        !Array.isArray(receipt.logs) ||
        (receipt.status === '0x0' && receipt.logs.length !== 0)
      )
        fail('STRATEGY_SLOT_RECEIPT_INVALID')
      hashes.add(hash)
      // Logs may arrive shuffled. Validate complete block-global indices before deriving local ordinals.
      const sorted = [...receipt.logs].sort((a, b) => (uint(a?.logIndex) ?? -1) - (uint(b?.logIndex) ?? -1))
      for (const [local, log] of sorted.entries()) {
        if (
          !object(log) ||
          log.removed === true ||
          uint(log.logIndex) !== nextLog ||
          uint(log.blockNumber) !== number ||
          uint(log.transactionIndex) !== txIndex ||
          strategyReceiptHash(log.blockHash) !== blockHash ||
          strategyReceiptHash(log.transactionHash) !== hash ||
          !address(log.address) ||
          typeof log.data !== 'string' ||
          !/^0x(?:[0-9a-f]{2})*$/i.test(log.data) ||
          !Array.isArray(log.topics) ||
          log.topics.some((topic) => !strategyReceiptHash(topic)) ||
          ++nextLog > 50_000 ||
          result.length >= 50_000
        )
          fail('STRATEGY_SLOT_LOG_INVALID')
        result.push({ raw: log, block: number!, blockHash, hash, tx: txIndex, index: nextLog - 1, local })
      }
    }
  }
  return { logs: result }
}

/** Internal reader validates its inventory before exposing it to lifecycle replay. */
export function validateStrategyLifecycleBlocks(blocks: StrategyLifecycleBlock[], from: number, to: number): void {
  completeBlocks(blocks, from, to)
}

const removals = new Set([
  'OrderCancelledByAdmin',
  'OrderCancelledByLiquidator',
  'ClearingExpiredOrder',
  'ClearingFrozenAccountOrder',
  'ClearingInvalidCloseOrder',
  'ClearingSelfMatchingOrder',
  'MakerOrderSettlementFailed',
])
// Pinned SDK handlers update positions/account balances, not an OpenLong/OpenShort resting slot.
// PositionClosed's adjacent-fill removal rule applies only to unsupported Close* orders.
const neutral = new Set([
  'OrderPostFailed',
  'OrderDoesNotExist',
  'OrderDescIdTooLow',
  'PositionOpened',
  'PositionOpenedV2',
  'PositionIncreased',
  'PositionIncreasedV2',
  'PositionDecreased',
  'PositionClosed',
  'RecycleFeeToAccount',
])

/** Prove one authenticated maker fill belongs to the original placement generation.
 * No capital, inventory, PnL or funding credit is made here. Unknown transitions fail closed.
 * Supported lifetime: post-only OpenLong/OpenShort, no expiry, zero requested builder fee.
 */
export function verifyStrategyMakerFill(
  exchange: string,
  admission: VerifiedStrategyOperation,
  candidate: WireFill,
  blocks: StrategyLifecycleBlock[],
): StrategyMakerFillProof {
  try {
    const identity = admission?.identity
    if (
      !address(exchange) ||
      !validStrategyOrderIdentity(identity) ||
      admission.outcome !== 'PLACED' ||
      admission.accountId !== identity.accountId ||
      admission.marketId !== identity.contractMarketId ||
      admission.type !== identity.type ||
      admission.requestId !== identity.placementRequestId ||
      admission.venueOrderId !== identity.venueOrderId ||
      admission.contractOrderId !== identity.contractOrderId ||
      admission.txHash !== identity.creationTxHash ||
      admission.block !== identity.creationBlock ||
      admission.transactionIndex !== identity.creationTransactionIndex ||
      admission.orderId !== '0' ||
      admission.expiryBlock !== '0' ||
      !admission.postOnly ||
      admission.fillOrKill ||
      admission.immediateOrCancel ||
      admission.feePer100K !== '0' ||
      admission.amountRaw !== '0' ||
      admission.maxNegPnlCollatBps !== '0' ||
      admission.block > admission.lastExecutionBlock ||
      (admission.builderId !== undefined && admission.builderFeePer100K !== '0')
    )
      fail('STRATEGY_SLOT_PLACEMENT_UNVERIFIED')
    if (
      !candidate ||
      candidate.acc !== identity.accountId ||
      candidate.mkt !== identity.marketId ||
      candidate.oid !== identity.venueOrderId ||
      candidate.t !== identity.type ||
      candidate.l !== 1 ||
      !positiveWire(candidate.p) ||
      !positiveWire(candidate.s) ||
      !rawAmount(candidate.f) ||
      (candidate.bfa !== undefined && !rawAmount(candidate.bfa)) ||
      !candidate.at ||
      !positiveWire(candidate.at.b) ||
      candidate.at.b < admission.block ||
      uint(candidate.at.tx) === undefined ||
      uint(candidate.at.l) === undefined ||
      !strategyReceiptHash(candidate.at.txid)
    )
      fail('STRATEGY_MAKER_FILL_UNVERIFIED')
    const { logs } = completeBlocks(blocks, admission.block, candidate.at.b)
    const first = blocks[0]
    const txs = first.block.transactions as Record<string, unknown>[]
    const tx = txs[identity.creationTransactionIndex],
      receipt = first.receipts[identity.creationTransactionIndex]
    if (!tx || !receipt) fail('STRATEGY_SLOT_PLACEMENT_UNVERIFIED')
    const actual = verifyStrategyCommandReceipt(exchange, admission.txHash, tx, receipt).find(
      (item) => item.accountId === admission.accountId && item.requestId === admission.requestId,
    )
    if (
      !actual ||
      actual.outcome !== 'PLACED' ||
      Object.keys(actual).some(
        (key) => actual[key as keyof VerifiedStrategyOperation] !== admission[key as keyof VerifiedStrategyOperation],
      ) ||
      Object.hasOwn(actual, 'builderId') !== Object.hasOwn(admission, 'builderId') ||
      Object.hasOwn(actual, 'builderFeePer100K') !== Object.hasOwn(admission, 'builderFeePer100K')
    )
      fail('STRATEGY_SLOT_PLACEMENT_UNVERIFIED')
    type Context = {
      account: bigint
      perp: bigint
      slot: bigint
      type: number
      size: bigint
      price: bigint
      expiry: bigint
      clearing: boolean
    }
    let context: Context | undefined, currentTx: string | undefined
    let placed = false,
      remaining = 0n,
      limit = 0n
    for (const log of logs) {
      // Begin at the exact admitted request, not merely its creation transaction.
      if (
        log.block === admission.block &&
        (log.tx < identity.creationTransactionIndex ||
          (log.tx === identity.creationTransactionIndex && log.index < admission.requestLogIndex))
      )
        continue
      if (log.hash !== currentTx) {
        currentTx = log.hash
        context = undefined
      }
      const isCandidate = matchesStrategyReceiptStamp(candidate.at, log.block, log.tx, log.hash, log.local)
      if (String(log.raw.address).toLowerCase() !== exchange.toLowerCase()) {
        if (isCandidate) fail('STRATEGY_MAKER_FILL_UNVERIFIED')
        continue
      }
      let name: string, args: Record<string, unknown>
      try {
        const decoded = decodeEventLog({
          abi: strategyLifecycleEvents,
          data: log.raw.data as `0x${string}`,
          topics: log.raw.topics as [`0x${string}`, ...`0x${string}`[]],
          strict: true,
        })
        name = decoded.eventName
        args = decoded.args
      } catch {
        fail('STRATEGY_SLOT_TRANSITION_UNSUPPORTED')
      }
      if (isCandidate && !['MakerOrderFilled', 'MakerOrderFilledV2'].includes(name!))
        fail('STRATEGY_MAKER_FILL_UNVERIFIED')
      if (['OrderRequest', 'OrderRequestV2'].includes(name!)) {
        if (
          !uint(args!.perpId) ||
          !uint(args!.accountId) ||
          uint(args!.orderId) === undefined ||
          uint(args!.orderId)! > 65535 ||
          uint(args!.orderType) === undefined
        )
          fail('STRATEGY_SLOT_CONTEXT_UNVERIFIED')
        context = {
          account: args!.accountId as bigint,
          perp: args!.perpId as bigint,
          slot: args!.orderId as bigint,
          type: Number(args!.orderType),
          size: args!.lotLNS as bigint,
          price: args!.pricePNS as bigint,
          expiry: args!.expiryBlock as bigint,
          clearing: false,
        }
      } else if (name! === 'OrderBatchCompleted') context = undefined
      else if (name! === 'OrderPlaced') {
        if (!context || ![0, 1, 2, 3].includes(context.type)) fail('STRATEGY_SLOT_CONTEXT_UNVERIFIED')
        if (context!.perp === BigInt(identity.contractMarketId) && args!.orderId === BigInt(identity.contractOrderId)) {
          if (
            placed ||
            log.hash !== admission.txHash ||
            log.index !== admission.outcomeLogIndex ||
            log.local !== admission.outcomeTransactionLogIndex ||
            context!.account !== BigInt(identity.accountId) ||
            args!.lotLNS !== BigInt(admission.sizeRaw)
          )
            fail('STRATEGY_SLOT_GENERATION_CHANGED')
          placed = true
          remaining = args!.lotLNS as bigint
          limit = BigInt(admission.priceRaw)
        }
      } else if (name! === 'OrderChanged' || name! === 'OrderCancelled') {
        if (
          !context ||
          context.type !== (name! === 'OrderChanged' ? 6 : 4) ||
          context.slot === 0n ||
          (name! === 'OrderChanged' && args!.orderId !== context.slot)
        )
          fail('STRATEGY_SLOT_CONTEXT_UNVERIFIED')
        if (context!.perp === BigInt(identity.contractMarketId) && context!.slot === BigInt(identity.contractOrderId)) {
          if (!placed || context!.account !== BigInt(identity.accountId)) fail('STRATEGY_SLOT_GENERATION_CHANGED')
          if (name! === 'OrderCancelled') fail('STRATEGY_SLOT_GENERATION_ENDED')
          if (
            args!.expiryBlock !== 0n ||
            args!.lotLNS !== context!.size ||
            args!.pricePNS !== context!.price ||
            args!.expiryBlock !== context!.expiry ||
            !uint(args!.lotLNS) ||
            !uint(args!.pricePNS)
          )
            fail('STRATEGY_SLOT_TRANSITION_UNSUPPORTED')
          remaining = args!.lotLNS as bigint
          limit = args!.pricePNS as bigint
        }
      } else if (removals.has(name!)) {
        if (args!.perpId === BigInt(identity.contractMarketId) && args!.orderId === BigInt(identity.contractOrderId))
          fail('STRATEGY_SLOT_GENERATION_ENDED')
      } else if (name! === 'ClearingRemainingOrderLockBeyondBalance') {
        if (!context) fail('STRATEGY_SLOT_CONTEXT_UNVERIFIED')
        context!.clearing = true
      } else if (['MakerOrderFilled', 'MakerOrderFilledV2'].includes(name!)) {
        const ownSlot =
          args!.perpId === BigInt(identity.contractMarketId) && args!.orderId === BigInt(identity.contractOrderId)
        if (!ownSlot) {
          if (isCandidate) fail('STRATEGY_MAKER_FILL_UNVERIFIED')
          continue
        }
        if (!placed || args!.accountId !== BigInt(identity.accountId)) fail('STRATEGY_SLOT_GENERATION_CHANGED')
        const size = args!.lotLNS as bigint,
          price = args!.pricePNS as bigint,
          fee = args!.feeCNS as bigint
        const builderFee = name! === 'MakerOrderFilledV2' ? (args!.builderFeeCNS as bigint) : 0n
        if (
          size <= 0n ||
          size > remaining ||
          price <= 0n ||
          (identity.type === 1 ? price > limit : price < limit) ||
          builderFee !== 0n ||
          (name! === 'MakerOrderFilledV2'
            ? args!.builderId !== BigInt(admission.builderId ?? 0)
            : admission.builderId !== undefined)
        )
          fail('STRATEGY_MAKER_FILL_UNVERIFIED')
        const removed = size === remaining || context?.clearing === true
        remaining = removed ? 0n : remaining - size
        if (isCandidate) {
          if (
            size !== BigInt(candidate.s) ||
            price !== BigInt(candidate.p!) ||
            fee !== BigInt(candidate.f) ||
            builderFee !== BigInt(candidate.bfa ?? '0')
          )
            fail('STRATEGY_MAKER_FILL_UNVERIFIED')
          return {
            status: 'VERIFIED',
            fill: {
              transactionHash: log.hash,
              blockHash: log.blockHash,
              block: log.block,
              transactionIndex: log.tx,
              logIndex: log.index,
              transactionLogIndex: log.local,
              accountId: identity.accountId,
              marketId: identity.marketId,
              contractMarketId: identity.contractMarketId,
              venueOrderId: identity.venueOrderId,
              contractOrderId: identity.contractOrderId,
              placementRequestId: identity.placementRequestId,
              placementTransactionHash: admission.txHash,
              placementLogIndex: admission.outcomeLogIndex!,
              sizeRaw: size.toString(),
              priceRaw: price.toString(),
              grossFeeRaw: fee.toString(),
              builderFeeRaw: builderFee.toString(),
              remainingSizeRaw: remaining.toString(),
              removed,
            },
          }
        }
        if (removed) fail('STRATEGY_SLOT_GENERATION_ENDED')
      } else if (['TakerOrderFilled', 'TakerOrderFilledV2'].includes(name!)) {
        if (!context) fail('STRATEGY_SLOT_CONTEXT_UNVERIFIED')
      } else if (!neutral.has(name!)) fail('STRATEGY_SLOT_TRANSITION_UNSUPPORTED')
    }
    return { status: 'UNKNOWN', reason: 'STRATEGY_MAKER_FILL_MISSING' }
  } catch (error) {
    return {
      status: 'UNKNOWN',
      reason:
        error instanceof Error && error.message.startsWith('STRATEGY_')
          ? error.message
          : 'STRATEGY_SLOT_HISTORY_UNVERIFIED',
    }
  }
}
