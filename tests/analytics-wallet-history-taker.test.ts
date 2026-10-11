import { encodeAbiParameters, toEventSelector, type AbiEvent, type AbiParameters, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { exchangeEvents } from '../packages/analytics/src/exchange-events.js'
import { EXCHANGE, type ChainLog, type DecodedExchangeEvent } from '../packages/analytics/src/decoder.js'
import {
  attributeTakerFills,
  settlementEvidence,
  walletTakerTrades,
  type WalletReceiptEvidence,
} from '../server/src/infrastructure/analytics/wallet-completion.js'

const blockHash = `0x${'a'.repeat(64)}` as Hex
const transactionHash = `0x${'b'.repeat(64)}` as Hex
const secondTransactionHash = `0x${'c'.repeat(64)}` as Hex
const wallet = '0x0000000000000000000000000000000000000025'
const other = '0x0000000000000000000000000000000000000035'
const timestamp = BigInt(Math.floor(Date.now() / 1000) - 10)
const markets = new Map([[1, { marketId: 1, priceDecimals: 2, sizeDecimals: 2 }]])

function log(name: string, index: number, values: Record<string, bigint> = {}, block = 100n): ChainLog {
  const event = exchangeEvents.find((candidate) => candidate.name === name) as AbiEvent | undefined
  if (!event) throw Error(`Unknown test event: ${name}`)
  return {
    address: EXCHANGE,
    blockNumber: `0x${block.toString(16)}`,
    blockHash,
    transactionHash,
    transactionIndex: '0x1',
    logIndex: `0x${index.toString(16)}`,
    topics: [toEventSelector(event)],
    data: encodeAbiParameters(
      event.inputs as AbiParameters,
      event.inputs.map((input) => values[input.name ?? ''] ?? 0n) as never,
    ),
  }
}

const receipt = (logs: ChainLog[], block = 100n): WalletReceiptEvidence => ({
  status: 'success',
  blockNumber: block,
  blockHash,
  blockTimestamp: timestamp,
  transactionHash,
  transactionIndex: 1,
  logs,
})

const open = (index: number, accountId = 4581n, size = 193n) =>
  log('PositionOpenedV2', index, {
    perpId: 1n,
    accountId,
    positionType: 1n,
    pricePNS: 829910n,
    lotLNS: size,
    insFeeCNS: 8289n,
    protFeeCNS: 48573n,
  })
const taker = (index: number, size = 193n) =>
  log('TakerOrderFilledV2', index, {
    entryPricePNS: 829910n,
    lotLNS: size,
    feeCNS: 56862n,
    builderId: 6n,
    builderFeeCNS: 1602n,
  })
const maker = (index: number, accountId: bigint, size: bigint) =>
  log('MakerOrderFilledV2', index, {
    perpId: 1n,
    accountId,
    lotLNS: size,
    pricePNS: 829910n,
  })
const increased = (index: number, accountId: bigint, size: bigint) =>
  log('PositionIncreasedV2', index, {
    perpId: 1n,
    accountId,
    positionType: 0n,
    startLotLNS: 500n,
    endLotLNS: 500n + size,
    pricePNS: 829691n, // new weighted entry is not the fill price
  })

describe('strict public taker attribution', () => {
  it('attributes the recorded maker then taker receipt shape with exact decimals and fees', async () => {
    const evidence = receipt([increased(47, 4704n, 193n), maker(48, 4704n, 193n), open(49), taker(50)])
    const result = attributeTakerFills(evidence, markets)
    expect(result.unresolvedLogIndexes).toEqual([])
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]).toMatchObject({
      accountId: 4581n,
      marketId: 1,
      action: 'open',
      side: 'short',
      sizeRaw: 193n,
      priceRaw: 829910n,
      feeMicros: 56862n,
      builderFeeMicros: 1602n,
      realizedPnlMicros: null,
    })
    const trades = await walletTakerTrades(wallet, result.fills, async (id, block, hash) => ({
      accountId: String(id),
      address: wallet,
      block: String(block),
      blockHash: hash,
      asOf: new Date(Number(timestamp) * 1000).toISOString(),
      source: 'monad_exchange',
    }))
    expect(trades[0]?.trade).toMatchObject({
      size: '1.93',
      price: '8299.10',
      notional: '16017.263000',
      fee: '0.056862',
      realizedPnl: null,
    })
  })

  it('counts one taker settlement after multiple maker partial fills', () => {
    const result = attributeTakerFills(
      receipt([
        increased(74, 4704n, 20n),
        maker(75, 4704n, 20n),
        increased(76, 4703n, 40n),
        maker(77, 4703n, 40n),
        increased(78, 812n, 133n),
        maker(79, 812n, 133n),
        open(80),
        taker(81),
      ]),
      markets,
    )
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.sizeRaw).toBe(193n)
  })

  it('uses the exact reduction delta and keeps failed or ambiguous pairs unresolved', () => {
    const reduction = log('PositionDecreased', 29, {
      perpId: 1n,
      accountId: 812n,
      positionType: 0n,
      startLotLNS: 22n,
      endLotLNS: 1n,
      deltaPnlCNS: 1n,
      fundingCNS: -2n,
    })
    const fill = log('TakerOrderFilledV2', 30, { entryPricePNS: 829910n, lotLNS: 21n, feeCNS: 5229n })
    const result = attributeTakerFills(receipt([reduction, fill]), markets)
    expect(result.fills[0]).toMatchObject({ action: 'reduce', sizeRaw: 21n, realizedPnlMicros: -1n })
    expect(attributeTakerFills(receipt([reduction, taker(30, 22n)]), markets).unresolvedLogIndexes).toEqual([30])
    expect(attributeTakerFills(receipt([open(49), maker(50, 4581n, 193n), taker(51)]), markets).fills).toEqual([])
    const close = log('PositionClosed', 49, { perpId: 1n, accountId: 4581n, pricePNS: 829910n })
    expect(attributeTakerFills(receipt([close, taker(50)]), markets).unresolvedLogIndexes).toEqual([50])
  })

  it('accepts an increase with weighted entry only when lot and charged fees match', () => {
    const position = log('PositionIncreasedV2', 10, {
      perpId: 1n,
      accountId: 4581n,
      positionType: 1n,
      startLotLNS: 100n,
      endLotLNS: 101n,
      pricePNS: 800000n,
      insFeeCNS: 5n,
      protFeeCNS: 7n,
    })
    const fill = log('TakerOrderFilledV2', 11, {
      entryPricePNS: 829910n,
      lotLNS: 1n,
      feeCNS: 12n,
    })
    expect(attributeTakerFills(receipt([position, fill]), markets).fills[0]).toMatchObject({
      action: 'increase',
      sizeRaw: 1n,
      priceRaw: 829910n,
    })
    const differentFee = log('TakerOrderFilledV2', 11, {
      entryPricePNS: 829910n,
      lotLNS: 1n,
      feeCNS: 13n,
    })
    expect(attributeTakerFills(receipt([position, differentFee]), markets).unresolvedLogIndexes).toEqual([11])
  })

  it('rejects duplicate, reordered, foreign-block and reverted receipt logs', () => {
    expect(() => attributeTakerFills(receipt([open(49), open(49), taker(50)]), markets)).toThrow(
      'ANALYTICS_RECEIPT_LOG_MISMATCH',
    )
    expect(() => attributeTakerFills(receipt([taker(50), open(49)]), markets)).toThrow('ANALYTICS_RECEIPT_LOG_MISMATCH')
    expect(() =>
      attributeTakerFills(receipt([open(49), { ...taker(50), blockHash: transactionHash }]), markets),
    ).toThrow('ANALYTICS_RECEIPT_LOG_MISMATCH')
    expect(() => attributeTakerFills({ ...receipt([open(49), taker(50)]), status: 'reverted' }, markets)).toThrow(
      'ANALYTICS_RECEIPT_UNVERIFIED',
    )
  })

  it('proves ownership at each fill block and refuses a mismatched proof', async () => {
    const first = attributeTakerFills(receipt([open(49), taker(50)]), markets).fills
    const secondLogs = [
      log(
        'PositionOpenedV2',
        49,
        {
          perpId: 1n,
          accountId: 4581n,
          positionType: 1n,
          pricePNS: 829910n,
          lotLNS: 193n,
          insFeeCNS: 8289n,
          protFeeCNS: 48573n,
        },
        101n,
      ),
      { ...taker(50), blockNumber: '0x65' as Hex },
    ].map((item) => ({ ...item, transactionHash: secondTransactionHash }))
    const second = attributeTakerFills(
      { ...receipt(secondLogs, 101n), transactionHash: secondTransactionHash },
      markets,
    ).fills
    const calls: bigint[] = []
    const ownerAt = async (id: bigint, block: bigint, hash: string) => {
      calls.push(block)
      return {
        accountId: String(id),
        address: block === 100n ? wallet : other,
        block: String(block),
        blockHash: hash,
        asOf: new Date(Number(timestamp) * 1000).toISOString(),
        source: 'monad_exchange' as const,
      }
    }
    expect((await walletTakerTrades(wallet, [...first, ...second], ownerAt)).map((item) => item.block)).toEqual([100n])
    expect(calls).toEqual([100n, 101n])
    await expect(
      walletTakerTrades(wallet, first, async (id, block, hash) => ({
        ...(await ownerAt(id, block, hash)),
        block: '99',
      })),
    ).rejects.toThrow('ANALYTICS_HISTORY_OWNER_MISMATCH')
  })
})

it('extracts gross settlement fields and leaves unwinding PnL unavailable', () => {
  const event = (eventName: string, args: Record<string, string>): DecodedExchangeEvent => ({
    eventName,
    args,
    block: 100n,
    blockHash,
    txHash: transactionHash,
    txIndex: 1,
    logIndex: 1,
  })
  for (const eventName of ['PositionClosed', 'PositionDecreased', 'PositionInverted', 'PositionDeleveragedV2'])
    expect(
      settlementEvidence(event(eventName, { accountId: '25', perpId: '1', deltaPnlCNS: '-1000001', fundingCNS: '2' }))
        ?.grossRealizedMicros,
    ).toBe(-999999n)
  expect(
    settlementEvidence(
      event('PositionLiquidated', { posAccountId: '25', perpId: '1', deltaPnlCNS: '-1', fundingCNS: '0' }),
    )?.grossRealizedMicros,
  ).toBe(-1n)
  expect(
    settlementEvidence(event('PositionUnwoundV2', { accountId: '25', perpId: '1' }))?.grossRealizedMicros,
  ).toBeNull()
})
