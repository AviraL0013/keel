import { describe, expect, it } from 'vitest'
import type { DecodedExchangeEvent } from '../packages/analytics/src/decoder.js'
import type { DerivedEvent } from '../packages/analytics/src/aggregate.js'
import { walletLedgerRows } from '../server/src/infrastructure/analytics/wallet-ledger.js'

const hash = `0x${'1'.repeat(64)}` as const
const blockHash = `0x${'2'.repeat(64)}` as const
function event(logIndex: number, eventName: string, args: Record<string, string>): DecodedExchangeEvent {
  return { block: 123n, blockHash, txHash: hash, txIndex: 2, logIndex, eventName, args }
}
const at = new Date('2026-10-13T00:00:00.000Z')

describe('compact wallet ledger', () => {
  it('links adjacent maker and taker fills but keeps unsupported settlement visible', () => {
    const open: DerivedEvent = {
      kind: 'position',
      accountId: '7',
      marketId: 1,
      side: 'long',
      action: 'open',
      sizeRaw: 10n,
      entryPriceRaw: 100n,
      leverageHundredths: 100n,
      collateralMicros: 1000000n,
      realizedPnlMicros: null,
      protocolFeeMicros: 1n,
    }
    const rows = walletLedgerRows([
      { event: event(3, 'PositionOpenedV2', { accountId: '7', perpId: '70', lotLNS: '10' }), derived: open, at },
      {
        event: event(4, 'MakerOrderFilledV2', {}),
        derived: {
          kind: 'fill',
          accountId: '7',
          marketId: 1,
          priceRaw: 100n,
          sizeRaw: 10n,
          notionalMicros: 1000000n,
          feeMicros: 40n,
          builderFeeMicros: 0n,
        },
        at,
      },
      {
        event: event(5, 'PositionClosed', { accountId: '7', perpId: '1' }),
        derived: {
          ...open,
          action: 'close',
          sizeRaw: null,
          entryPriceRaw: null,
          leverageHundredths: null,
          collateralMicros: null,
          realizedPnlMicros: -300n,
        },
        at,
      },
      {
        event: event(6, 'TakerOrderFilledV2', { entryPricePNS: '90', lotLNS: '10' }),
        derived: {
          kind: 'taker_fee',
          feeMicros: 20n,
          builderFeeMicros: 0n,
        },
        at,
      },
      { event: event(7, 'PositionInverted', { accountId: '7', perpId: '1' }), derived: null, at },
    ])
    expect(rows.map((row) => [row.action, row.fillVerified, row.sizeRaw, row.realizedPnlMicros])).toEqual([
      ['open', true, '10', null],
      ['close', true, '10', '-300'],
      ['unsupported', false, null, null],
    ])
    expect(rows[0].feeMicros).toBe('40')
    expect(rows[0].marketId).toBe(1)
    expect(rows[1].feeMicros).toBe('20')
  })

  it('does not claim a fill when adjacent lot differs', () => {
    const rows = walletLedgerRows([
      {
        event: event(3, 'PositionOpened', { accountId: '7', perpId: '1', lotLNS: '10' }),
        derived: {
          kind: 'position',
          accountId: '7',
          marketId: 1,
          side: 'long',
          action: 'open',
          sizeRaw: 10n,
          entryPriceRaw: 100n,
          leverageHundredths: 100n,
          collateralMicros: 1000000n,
          realizedPnlMicros: null,
          protocolFeeMicros: 1n,
        },
        at,
      },
      {
        event: event(4, 'TakerOrderFilled', { entryPricePNS: '100', lotLNS: '11' }),
        derived: {
          kind: 'taker_fee',
          feeMicros: 20n,
          builderFeeMicros: 0n,
        },
        at,
      },
    ])
    expect(rows[0].fillVerified).toBe(false)
    expect(rows[0].priceRaw).toBeNull()
  })

  it('does not link a close to an adjacent fill at another price', () => {
    const rows = walletLedgerRows([
      {
        event: event(3, 'PositionClosed', { accountId: '7', perpId: '1', pricePNS: '100' }),
        derived: {
          kind: 'position',
          accountId: '7',
          marketId: 1,
          side: 'long',
          action: 'close',
          sizeRaw: null,
          entryPriceRaw: null,
          leverageHundredths: null,
          collateralMicros: null,
          realizedPnlMicros: 50n,
          protocolFeeMicros: null,
        },
        at,
      },
      {
        event: event(4, 'TakerOrderFilled', { entryPricePNS: '101', lotLNS: '10' }),
        derived: {
          kind: 'taker_fee',
          feeMicros: 2n,
          builderFeeMicros: 0n,
        },
        at,
      },
    ])
    expect(rows[0].fillVerified).toBe(false)
    expect(rows[0].realizedPnlMicros).toBe('50')
  })
})
