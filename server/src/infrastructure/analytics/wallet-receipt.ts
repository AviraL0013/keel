import { createPublicClient, http, toHex, type Hex } from 'viem'
import { monad } from 'viem/chains'
import type { WalletReceiptEvidence } from './wallet-completion.js'

/** A receipt is usable only while its block is finalized and still canonical. */
export class WalletReceiptReader {
  private readonly client

  constructor(rpcUrl: string) {
    this.client = createPublicClient({ chain: monad, transport: http(rpcUrl, { timeout: 8_000, retryCount: 0 }) })
  }

  async read(hash: Hex): Promise<WalletReceiptEvidence> {
    const chainId = await this.client.getChainId()
    if (chainId !== 143) throw Error('ANALYTICS_RECEIPT_CHAIN_MISMATCH')
    const receipt = await this.client.getTransactionReceipt({ hash })
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.status !== 'success')
      throw Error('ANALYTICS_RECEIPT_UNVERIFIED')
    const finalized = await this.client.getBlock({ blockTag: 'finalized' })
    if (receipt.blockNumber > finalized.number) throw Error('ANALYTICS_RECEIPT_NOT_FINALIZED')
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber })
    if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw Error('ANALYTICS_RECEIPT_REORG')
    const logs = receipt.logs.map((log) => {
      if (log.logIndex === null || log.transactionIndex === null || log.blockNumber === null || log.blockHash === null)
        throw Error('ANALYTICS_RECEIPT_LOG_INCOMPLETE')
      return {
        address: log.address,
        blockNumber: toHex(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: toHex(log.transactionIndex),
        logIndex: toHex(log.logIndex),
        data: log.data,
        topics: [...log.topics],
        removed: log.removed,
      }
    })
    const stillCanonical = await this.client.getBlock({ blockNumber: receipt.blockNumber })
    if (stillCanonical.hash.toLowerCase() !== block.hash.toLowerCase()) throw Error('ANALYTICS_RECEIPT_REORG')
    return {
      status: 'success',
      blockNumber: receipt.blockNumber,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
      transactionHash: receipt.transactionHash,
      transactionIndex: receipt.transactionIndex,
      logs,
    }
  }
}
