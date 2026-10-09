import { decodeEventLog, getAddress, toEventSelector, type Abi, type AbiEvent, type Hex } from 'viem'
import { exchangeEvents } from './exchange-events.js'

export const EXCHANGE = getAddress('0x34B6552d57a35a1D042CcAe1951BD1C370112a6F')
// Verified creation receipt 0x22d1d74e137c3a82ac4b702fd90024811b184fcdcf8fd4d1473097b4d8a619f3.
export const EXCHANGE_DEPLOYMENT_BLOCK = 54773010n
const recognizedTopics = new Set(exchangeEvents.map((event) => toEventSelector(event as AbiEvent).toLowerCase()))
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
  if (!recognizedTopics.has(log.topics[0].toLowerCase())) return null
  try {
    const event = decodeEventLog({ abi: exchangeEvents as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
    if (!event.eventName || !event.args || Array.isArray(event.args)) throw new Error('INVALID_EVENT')
    const args: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(event.args)) {
      if (typeof value === 'bigint') args[key] = value.toString()
      else if (typeof value === 'number' && Number.isSafeInteger(value)) args[key] = value.toString()
      else if (typeof value === 'boolean' || typeof value === 'string') args[key] = value
      else throw new Error('INVALID_EVENT_ARGUMENT')
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
    throw new Error('ANALYTICS_RECOGNIZED_LOG_INVALID')
  }
}
