import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { PerplPublicAnalytics } from '../server/src/infrastructure/analytics/perpl-public.js'
import { WalletChainAnalytics } from '../server/src/infrastructure/analytics/wallet-chain.js'
import { WalletOnDemandAnalytics } from '../server/src/infrastructure/analytics/wallet-ondemand.js'
import { registerAnalyticsRoutes } from '../server/src/interfaces/http/routes/analytics.js'

const address = '0x1234567890abcdef1234567890abcdef12345678'
const context = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')).context
const tx = `0x${'a'.repeat(64)}`

it('pages proven on-demand wallet trades while withholding totals for unverified account enumeration', async () => {
  const app = Fastify()
  const publicData = new PerplPublicAnalytics('https://fixture.invalid', async () => Response.json(context))
  const wallet = {
    profile: async () => ({ data: { accountIds: ['5438'] } }),
  } as unknown as WalletChainAnalytics
  let accountsComplete: boolean | undefined
  const walletOnDemand = {
    load: async (input: { accountsComplete: boolean; accountIds: string[] }) => {
      accountsComplete = input.accountsComplete
      expect(input.accountIds).toEqual(['5438'])
      return {
        window: '30d' as const,
        label: 'last 30 days' as const,
        from: '2026-09-11T00:00:00.000Z',
        through: '2026-10-11T00:00:00.000Z',
        block: 112000000,
        source: 'monad_exchange' as const,
        trades: [1, 2].map((index) => ({
          id: `11200000${index}:${tx}:${index}`,
          time: `2026-10-10T00:00:0${index}.000Z`,
          marketId: 1,
          side: 'long' as const,
          action: 'open' as const,
          size: '0.01',
          price: '82000',
          notional: '820.000000',
          fee: '0.010000',
          realizedPnl: null,
          transactionHash: tx,
        })),
        performance: null,
        unavailableReason: 'ACCOUNT_ENUMERATION_UNVERIFIED',
        maxDrawdownUnavailableReason: 'STARTING_EQUITY_UNAVAILABLE' as const,
      }
    },
  } as unknown as WalletOnDemandAnalytics
  registerAnalyticsRoutes(app, null, { publicData, wallet, walletOnDemand })
  try {
    const path = `/analytics/v1/wallets/${address}`
    const first = await app.inject(`${path}/trades?limit=1`)
    expect(first.statusCode).toBe(200)
    expect(first.json().data.items).toHaveLength(1)
    expect(first.json().data.unavailableReason).toBe('ACCOUNT_ENUMERATION_UNVERIFIED')
    expect(first.json().coverage.label).toBe('Last 30 days')
    expect(first.json().stale).toBe(true)
    const next = await app.inject(`${path}/trades?limit=1&cursor=${first.json().data.nextCursor}`)
    expect(next.statusCode).toBe(200)
    expect(next.json().data.items).toHaveLength(1)
    expect(next.json().data.items[0].id).not.toBe(first.json().data.items[0].id)
    const performance = await app.inject(`${path}/performance`)
    expect(performance.statusCode).toBe(200)
    expect(performance.json().data.realizedPnl).toBeNull()
    expect(performance.json().data.unavailableReason).toBe('ACCOUNT_ENUMERATION_UNVERIFIED')
    expect(accountsComplete).toBe(false)
  } finally {
    await app.close()
  }
})

it('returns an immediate, honest unavailable state instead of rescanning the full public window', async () => {
  const priorRollups = process.env.EYELER_ANALYTICS_ROLLUPS_ENABLED
  const priorLedger = process.env.EYELER_ANALYTICS_WALLET_LEDGER_ENABLED
  process.env.EYELER_ANALYTICS_ROLLUPS_ENABLED = 'true'
  process.env.EYELER_ANALYTICS_WALLET_LEDGER_ENABLED = 'false'
  const app = Fastify()
  const publicData = new PerplPublicAnalytics('https://fixture.invalid', async () => Response.json(context))
  const walletOnDemand = {
    load: async () => {
      throw Error('ON_DEMAND_SCAN_MUST_NOT_RUN')
    },
  } as unknown as WalletOnDemandAnalytics
  registerAnalyticsRoutes(app, {} as pg.Pool, { publicData, walletOnDemand })
  try {
    const path = `/analytics/v1/wallets/${address}`
    const trades = await app.inject(`${path}/trades?limit=1`)
    expect(trades.statusCode).toBe(200)
    expect(trades.json().data).toMatchObject({ items: [], unavailableReason: 'PUBLIC_WALLET_HISTORY_UNAVAILABLE' })
    const performance = await app.inject(`${path}/performance`)
    expect(performance.statusCode).toBe(200)
    expect(performance.json().data.realizedPnl).toBeNull()
    expect(performance.json().data.unavailableReason).toBe('PUBLIC_WALLET_HISTORY_UNAVAILABLE')
  } finally {
    await app.close()
    if (priorRollups === undefined) delete process.env.EYELER_ANALYTICS_ROLLUPS_ENABLED
    else process.env.EYELER_ANALYTICS_ROLLUPS_ENABLED = priorRollups
    if (priorLedger === undefined) delete process.env.EYELER_ANALYTICS_WALLET_LEDGER_ENABLED
    else process.env.EYELER_ANALYTICS_WALLET_LEDGER_ENABLED = priorLedger
  }
})
