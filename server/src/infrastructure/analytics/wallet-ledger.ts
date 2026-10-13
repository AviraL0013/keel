import type { DecodedExchangeEvent } from '../../../../packages/analytics/src/decoder.js'
import type { DerivedEvent } from '../../../../packages/analytics/src/aggregate.js'

export interface WalletLedgerInput {
  event: DecodedExchangeEvent
  derived: DerivedEvent | null
  at: Date
}

export interface WalletLedgerRow {
  blockNumber: string
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
  occurredAt: Date
  accountId: string
  marketId: number
  side: 'long' | 'short' | null
  action: string
  priceRaw: string | null
  sizeRaw: string | null
  feeMicros: string | null
  realizedPnlMicros: string | null
  fillVerified: boolean
}

const unsupported = new Set([
  'PositionInverted',
  'PositionDeleveraged',
  'PositionDeleveragedV2',
  'PositionUnwound',
  'PositionUnwoundV2',
])

/** One row per account position change; adjacent fill proves execution details. */
export function walletLedgerRows(items: WalletLedgerInput[]): WalletLedgerRow[] {
  const byLog = new Map<string, WalletLedgerInput>()
  for (const item of items) {
    const event = item.event
    byLog.set(`${event.block}:${event.txHash.toLowerCase()}:${event.logIndex}`, item)
  }
  const rows: WalletLedgerRow[] = []
  for (const item of items) {
    const { event, derived } = item
    const position = derived?.kind === 'position' ? derived : null
    const liquidation = derived?.kind === 'liquidation' ? derived : null
    if (!position && !liquidation && !unsupported.has(event.eventName)) continue
    const rawAccount = event.args.accountId ?? event.args.posAccountId
    const rawMarket = event.args.perpId
    if (
      typeof rawAccount !== 'string' ||
      !/^\d+$/.test(rawAccount) ||
      typeof rawMarket !== 'string' ||
      !/^\d+$/.test(rawMarket)
    )
      throw new Error('WALLET_LEDGER_EVENT_INVALID')
    const marketId = Number(rawMarket)
    if (BigInt(rawAccount) <= 0n || !Number.isSafeInteger(marketId) || marketId <= 0)
      throw new Error('WALLET_LEDGER_EVENT_INVALID')
    let priceRaw: string | null = null
    let sizeRaw: string | null = null
    let feeMicros: string | null = null
    let fillVerified = false
    if (liquidation) {
      priceRaw = liquidation.priceRaw.toString()
      sizeRaw = liquidation.lotRaw.toString()
      fillVerified = true
    } else if (position && !unsupported.has(event.eventName)) {
      const adjacent = byLog.get(`${event.block}:${event.txHash.toLowerCase()}:${event.logIndex + 1}`)
      const fill = adjacent?.derived
      const maker =
        fill?.kind === 'fill' && fill.accountId === position.accountId && fill.marketId === position.marketId
      const taker = fill?.kind === 'taker_fee'
      const rawPrice = maker ? fill.priceRaw : taker ? adjacent?.event.args.entryPricePNS : null
      const rawSize = maker ? fill.sizeRaw : taker ? adjacent?.event.args.lotLNS : null
      const expected =
        position.action === 'open'
          ? event.args.lotLNS
          : position.action === 'increase'
            ? event.args.startLotLNS &&
              event.args.endLotLNS &&
              (BigInt(String(event.args.endLotLNS)) - BigInt(String(event.args.startLotLNS))).toString()
            : position.action === 'reduce'
              ? event.args.startLotLNS &&
                event.args.endLotLNS &&
                (BigInt(String(event.args.startLotLNS)) - BigInt(String(event.args.endLotLNS))).toString()
              : null
      const eventPrice = event.args.pricePNS
      if (
        (maker || taker) &&
        rawPrice !== null &&
        rawPrice !== undefined &&
        rawSize !== null &&
        rawSize !== undefined &&
        BigInt(String(rawPrice)) > 0n &&
        BigInt(String(rawSize)) > 0n &&
        (eventPrice === undefined || BigInt(String(eventPrice)) === BigInt(String(rawPrice))) &&
        (expected === null || expected === undefined || BigInt(String(expected)) === BigInt(String(rawSize)))
      ) {
        priceRaw = String(rawPrice)
        sizeRaw = String(rawSize)
        feeMicros = fill.feeMicros.toString()
        fillVerified = true
      }
    }
    rows.push({
      blockNumber: event.block.toString(),
      blockHash: event.blockHash,
      transactionHash: event.txHash,
      transactionIndex: event.txIndex,
      logIndex: event.logIndex,
      occurredAt: item.at,
      accountId: rawAccount,
      marketId,
      side: position?.side ?? liquidation?.side ?? null,
      action: unsupported.has(event.eventName) ? 'unsupported' : (position?.action ?? 'liquidation'),
      priceRaw,
      sizeRaw,
      feeMicros,
      realizedPnlMicros: position?.realizedPnlMicros?.toString() ?? liquidation?.realizedPnlMicros.toString() ?? null,
      fillVerified,
    })
  }
  return rows
}
