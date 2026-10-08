import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { profileFromViews } from '../server/src/infrastructure/analytics/wallet-chain.js'
import type { PublicContext } from '../server/src/infrastructure/analytics/perpl-public.js'

const snapshot = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-wallet.json', 'utf8')) as {
  blockNumber: string
  account: {
    accountId: string
    balanceCNS: string
    lockedBalanceCNS: string
    accountAddr: string
    positions: { bank1: string; bank2: string; bank3: string; bank4: string }
  }
  position: [
    {
      accountId: string
      positionType: number
      depositCNS: string
      pricePNS: string
      lotLNS: string
      entryBlock: string
      pnlCNS: string
      priceResiduePNSQ16: string
    },
    string,
    boolean,
  ]
}
const context = (
  JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')) as {
    context: PublicContext
  }
).context

describe('wallet profile from finalized Exchange views', () => {
  const account = {
    ...snapshot.account,
    accountId: BigInt(snapshot.account.accountId),
    balanceCNS: BigInt(snapshot.account.balanceCNS),
    lockedBalanceCNS: BigInt(snapshot.account.lockedBalanceCNS),
    positions: {
      bank1: BigInt(snapshot.account.positions.bank1),
      bank2: BigInt(snapshot.account.positions.bank2),
      bank3: BigInt(snapshot.account.positions.bank3),
      bank4: BigInt(snapshot.account.positions.bank4),
    },
  }
  const position = {
    ...snapshot.position[0],
    accountId: BigInt(snapshot.position[0].accountId),
    depositCNS: BigInt(snapshot.position[0].depositCNS),
    pricePNS: BigInt(snapshot.position[0].pricePNS),
    lotLNS: BigInt(snapshot.position[0].lotLNS),
    entryBlock: BigInt(snapshot.position[0].entryBlock),
    pnlCNS: BigInt(snapshot.position[0].pnlCNS),
    priceResiduePNSQ16: BigInt(snapshot.position[0].priceResiduePNSQ16),
  }
  const market = context.markets.find((item) => item.id === 100)!
  const profile = (value = position, valid = true) =>
    profileFromViews(
      account.accountAddr,
      account,
      [{ market, result: [value, BigInt(snapshot.position[1]), valid], openedAt: '2026-10-07T16:00:00.000Z' }],
      Number(snapshot.blockNumber),
      '2026-10-07T16:53:19.283Z',
    )

  it('preserves the independently documented Q16 entry residue for both sides without binary floats', () => {
    expect(profile().data.positions[0]!.entryPrice).toBe('5.15296234588623046875')
    expect(profile({ ...position, positionType: 0, pricePNS: 51530n }).data.positions[0]!.entryPrice).toBe(
      '5.15296234588623046875',
    )
    expect(profile({ ...position, positionType: 0, priceResiduePNSQ16: 0n }).data.positions[0]!.entryPrice).toBe(
      '5.1529',
    )
  })
  it('refuses foreign or malformed positive positions rather than silently returning a complete wallet', () => {
    expect(() => profile({ ...position, accountId: 26n })).toThrow('ANALYTICS_POSITION_ACCOUNT_MISMATCH')
    for (const value of [
      { ...position, priceResiduePNSQ16: 65536n },
      { ...position, priceResiduePNSQ16: -1n },
      { ...position, depositCNS: -1n },
      { ...position, pricePNS: -1n },
    ])
      expect(() => profile(value)).toThrow()
  })
  it('keeps mark, PnL and equity unavailable when the venue mark is not valid', () => {
    const result = profile(position, false)
    expect(result.data.positions[0]!.markPrice).toBeNull()
    expect(result.data.positions[0]!.unrealizedPnl).toBeNull()
    expect(result.data.margin.equity).toBeNull()
  })
  it('uses exact six-decimal margin and venue PnL', () => {
    const market = context.markets.find((item) => item.id === 100)!
    const account = {
      ...snapshot.account,
      accountId: BigInt(snapshot.account.accountId),
      balanceCNS: BigInt(snapshot.account.balanceCNS),
      lockedBalanceCNS: BigInt(snapshot.account.lockedBalanceCNS),
      positions: {
        bank1: BigInt(snapshot.account.positions.bank1),
        bank2: BigInt(snapshot.account.positions.bank2),
        bank3: BigInt(snapshot.account.positions.bank3),
        bank4: BigInt(snapshot.account.positions.bank4),
      },
    }
    const position = {
      ...snapshot.position[0],
      accountId: BigInt(snapshot.position[0].accountId),
      depositCNS: BigInt(snapshot.position[0].depositCNS),
      pricePNS: BigInt(snapshot.position[0].pricePNS),
      lotLNS: BigInt(snapshot.position[0].lotLNS),
      entryBlock: BigInt(snapshot.position[0].entryBlock),
      pnlCNS: BigInt(snapshot.position[0].pnlCNS),
      priceResiduePNSQ16: BigInt(snapshot.position[0].priceResiduePNSQ16),
    }
    const result = profileFromViews(
      account.accountAddr,
      account,
      [
        {
          market,
          result: [position, BigInt(snapshot.position[1]), snapshot.position[2]],
          openedAt: '2026-10-07T16:00:00.000Z',
        },
      ],
      Number(snapshot.blockNumber),
      '2026-10-07T16:53:19.283Z',
    )
    expect(result.data.margin.balance).toBe('1412227.132218')
    expect(result.data.margin.locked).toBe('366352.546064')
    expect(result.data.margin.free).toBe('1045874.586154')
    expect(result.data.positions[0].side).toBe('short')
    expect(result.data.positions[0].unrealizedPnl).toBe('-1.609876')
    expect(result.data.positions[0].liquidationPrice).toBeNull()
    expect(result.data.margin.equity).toBeNull()
    expect(result.coverage?.label).toBe('Wallet positions 1/11')
  })
})
