import { decodeEventLog, getAddress, type Abi, type Hex } from 'viem'
import { exchangeEvents } from './exchange-events.js'

export const EXCHANGE = getAddress('0x34B6552d57a35a1D042CcAe1951BD1C370112a6F')
export interface ChainLog {
  address: string
  blockNumber: Hex
  blockHash: Hex
  transactionHash: Hex
  transactionIndex: Hex
  logIndex: Hex
  data: Hex
  topics: Hex[]
  removed?: boolean
}
export interface DecodedExchangeEvent {
  block: bigint
  blockHash: Hex
  txHash: Hex
  txIndex: number
  logIndex: number
  eventName: string
  args: Record<string, string | boolean>
}

/** Exact SDK event ABI. Unknown signatures remain raw-only and never affect derived metrics. */
export function decodeExchangeLog(log: ChainLog): DecodedExchangeEvent | null {
  if (getAddress(log.address) !== EXCHANGE || log.removed || !log.topics.length) return null
  try {
    const event = decodeEventLog({ abi: exchangeEvents as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
    if (!event.eventName || !event.args || Array.isArray(event.args)) return null
    const args: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(event.args)) {
      if (typeof value === 'bigint') args[key] = value.toString()
      else if (typeof value === 'number' && Number.isSafeInteger(value)) args[key] = value.toString()
      else if (typeof value === 'boolean' || typeof value === 'string') args[key] = value
      else return null
    }
    return {
      block: BigInt(log.blockNumber),
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      txIndex: Number(BigInt(log.transactionIndex)),
      logIndex: Number(BigInt(log.logIndex)),
      eventName: event.eventName,
      args,
    }
  } catch {
    return null
  }
}
