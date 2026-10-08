import { validateStrategyLifecycleBlocks, type StrategyLifecycleBlock } from './strategy-lifecycle.js'
import { strategyReceiptHash } from './strategy-identity.js'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): number | undefined => {
  if (!['string', 'number'].includes(typeof value) || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(String(value))) return
  const n = Number(BigInt(String(value)))
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

/** Unmounted, read-only proof source. No signed transactions, API enrollment, retries or fallback RPC.
 * Finality must be supplied by the configured RPC; unsupported tags remain unavailable.
 * Bounds deliberately refuse long histories until durable replay checkpoints are implemented.
 */
export class StrategyLifecycleReader {
  constructor(
    private readonly rpcUrl: string,
    private readonly chainId: number,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async read(
    from: number,
    to: number,
  ): Promise<{ blocks: StrategyLifecycleBlock[]; finalized: { block: number; hash: string } }> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to < from || to - from >= 128)
      throw new Error('PERPL_SLOT_SCAN_LIMIT')
    if (![143, 10143].includes(this.chainId)) throw new Error('PERPL_SLOT_CHAIN_MISMATCH')
    const deadline = AbortSignal.timeout(120_000)
    let id = 0
    const rpc = async (
      method: 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getTransactionReceipt',
      params: unknown[],
    ) => {
      if (deadline.aborted) throw new Error('PERPL_SLOT_SCAN_TIMEOUT')
      const response = await this.transport(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) throw new Error(`PERPL_SLOT_HISTORY_HTTP_${response.status}`)
      const payload: unknown = await response.json()
      if (
        !object(payload) ||
        payload.error ||
        !Object.hasOwn(payload, 'result') ||
        (payload.id !== undefined && payload.id !== id)
      )
        throw new Error('PERPL_SLOT_HISTORY_RPC_INVALID')
      return payload.result
    }
    if (integer(await rpc('eth_chainId', [])) !== this.chainId) throw new Error('PERPL_SLOT_CHAIN_MISMATCH')
    const head = await rpc('eth_getBlockByNumber', ['finalized', false])
    const finalizedBlock = object(head) ? integer(head.number) : undefined
    const finalizedHash = object(head) ? strategyReceiptHash(head.hash) : undefined
    if (finalizedBlock === undefined || finalizedBlock < to || !finalizedHash)
      throw new Error('PERPL_SLOT_FINALITY_UNAVAILABLE')
    const blocks: StrategyLifecycleBlock[] = []
    let count = 0
    for (let number = from; number <= to; number++) {
      const block = await rpc('eth_getBlockByNumber', [`0x${number.toString(16)}`, true])
      if (!object(block) || !Array.isArray(block.transactions)) throw new Error('PERPL_SLOT_BLOCK_UNAVAILABLE')
      const receipts: Record<string, unknown>[] = []
      if ((count += block.transactions.length) > 2048) throw new Error('PERPL_SLOT_SCAN_LIMIT')
      for (const tx of block.transactions) {
        if (!object(tx) || !strategyReceiptHash(tx.hash)) throw new Error('PERPL_SLOT_HISTORY_INVALID')
        const receipt = await rpc('eth_getTransactionReceipt', [tx.hash])
        if (!object(receipt)) throw new Error('PERPL_SLOT_RECEIPT_UNAVAILABLE')
        receipts.push(receipt)
      }
      blocks.push({ block, receipts })
    }
    validateStrategyLifecycleBlocks(blocks, from, to)
    const tip = await rpc('eth_getBlockByNumber', [`0x${to.toString(16)}`, false])
    if (
      !object(tip) ||
      integer(tip.number) !== to ||
      strategyReceiptHash(tip.hash) !== strategyReceiptHash(blocks.at(-1)!.block.hash)
    )
      throw new Error('PERPL_SLOT_HISTORY_REORG')
    const finalizedCanonical =
      finalizedBlock === to ? tip : await rpc('eth_getBlockByNumber', [`0x${finalizedBlock.toString(16)}`, false])
    if (
      !object(finalizedCanonical) ||
      integer(finalizedCanonical.number) !== finalizedBlock ||
      strategyReceiptHash(finalizedCanonical.hash) !== finalizedHash
    )
      throw new Error('PERPL_SLOT_HISTORY_REORG')
    return { blocks, finalized: { block: finalizedBlock, hash: finalizedHash } }
  }
}
