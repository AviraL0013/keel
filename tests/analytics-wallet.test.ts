import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { profileFromViews } from '../server/src/infrastructure/analytics/wallet-chain.js'
import type { PublicContext } from '../server/src/infrastructure/analytics/perpl-public.js'

const snapshot = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-wallet.json', 'utf8')) as {
  blockNumber: string
  account: { accountId: string; balanceCNS: string; lockedBalanceCNS: string; accountAddr: string }
  position: [
    {
      accountId: string
      positionType: number
      depositCNS: string
      pricePNS: string
      lotLNS: string
      entryBlock: string
      pnlCNS: string
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
  it('uses exact six-decimal margin and venue PnL', () => {
    const market = context.markets.find((item) => item.id === 100)!
    const account = {
      ...snapshot.account,
      accountId: BigInt(snapshot.account.accountId),
      balanceCNS: BigInt(snapshot.account.balanceCNS),
      lockedBalanceCNS: BigInt(snapshot.account.lockedBalanceCNS),
    }
    const position = {
      ...snapshot.position[0],
      accountId: BigInt(snapshot.position[0].accountId),
      depositCNS: BigInt(snapshot.position[0].depositCNS),
      pricePNS: BigInt(snapshot.position[0].pricePNS),
      lotLNS: BigInt(snapshot.position[0].lotLNS),
      entryBlock: BigInt(snapshot.position[0].entryBlock),
      pnlCNS: BigInt(snapshot.position[0].pnlCNS),
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
  })
})
