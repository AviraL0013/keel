import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { deriveEvent } from '../../packages/analytics/src/aggregate.js'
import { decodeExchangeLog, type ChainLog } from '../../packages/analytics/src/decoder.js'
import { AnalyticsRepository } from '../../server/src/infrastructure/analytics/repository.js'
import { PerplPublicAnalytics, type PublicContext } from '../../server/src/infrastructure/analytics/perpl-public.js'
import { profileFromViews, type WalletChainAnalytics } from '../../server/src/infrastructure/analytics/wallet-chain.js'
import { AuthService } from '../../server/src/auth.js'
import { loadConfig } from '../../server/src/config/index.js'
import { registerRoutes } from '../../server/src/interfaces/http/register.js'
import { databaseFixture } from './database.js'

/** Loopback-only replay harness. No RPC, venue, custody or worker is started. */
export async function createAnalyticsFixtureServer() {
  const { db, store } = await databaseFixture()
  const app = Fastify()
  try {
    const publicFixture = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-public.json', 'utf8')) as {
      context: PublicContext
      funding: unknown
      candles: unknown
    }
    const rawFixture = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-logs.json', 'utf8')) as {
      logs: ChainLog[]
      blocks: Record<string, string>
    }
    const walletFixture = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-wallet.json', 'utf8')) as {
      capturedAt: string
      blockNumber: string
      entryBlock: { number: string; timestamp: string; openedAt: string }
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
    const publicData = new PerplPublicAnalytics('https://recorded.perpl.invalid/api', async (input) => {
      const path = String(input)
      const value = path.endsWith('/v1/pub/context')
        ? publicFixture.context
        : path.includes('/funding/')
          ? publicFixture.funding
          : path.includes('/v1/market-data/1/candles/3600/')
            ? publicFixture.candles
            : undefined
      if (!value) throw new Error('UNEXPECTED_RECORDED_FETCH')
      return Response.json(value)
    })
    // Only BTC hourly candles were recorded. Missing market/resolution data is
    // unavailable, never another market's prices or volume.
    const readVolumes = publicData.volumeCandles.bind(publicData)
    publicData.volumeCandles = (market, interval, from, to) =>
      market.id === 1 && interval === '1h' ? readVolumes(market, interval, from, to) : Promise.resolve([])
    // Persist one recorded block. This proves the decoder/database/API path;
    // it does not fabricate missing blocks or claim complete historical totals.
    const first = rawFixture.logs.reduce(
      (min, log) => (BigInt(log.blockNumber) < min ? BigInt(log.blockNumber) : min),
      BigInt(rawFixture.logs[0].blockNumber),
    )
    const raw = rawFixture.logs.filter((log) => BigInt(log.blockNumber) === first)
    const timestamp = new Date(Number(BigInt(rawFixture.blocks[raw[0].blockNumber])) * 1000)
    const repo = new AnalyticsRepository(store.pool)
    const precision = publicData.precision(publicFixture.context)
    await repo.saveChunk(
      [{ number: first, hash: raw[0].blockHash, timestamp }],
      raw.map((log) => {
        const decoded = decodeExchangeLog(log)
        return { raw: log, decoded, derived: decoded ? deriveEvent(decoded, precision) : null }
      }),
      first,
      first,
    )

    const account = {
      ...walletFixture.account,
      accountId: BigInt(walletFixture.account.accountId),
      balanceCNS: BigInt(walletFixture.account.balanceCNS),
      lockedBalanceCNS: BigInt(walletFixture.account.lockedBalanceCNS),
      positions: {
        bank1: BigInt(walletFixture.account.positions.bank1),
        bank2: BigInt(walletFixture.account.positions.bank2),
        bank3: BigInt(walletFixture.account.positions.bank3),
        bank4: BigInt(walletFixture.account.positions.bank4),
      },
    }
    const sourcePosition = walletFixture.position[0]
    const position = {
      ...sourcePosition,
      accountId: BigInt(sourcePosition.accountId),
      depositCNS: BigInt(sourcePosition.depositCNS),
      pricePNS: BigInt(sourcePosition.pricePNS),
      lotLNS: BigInt(sourcePosition.lotLNS),
      entryBlock: BigInt(sourcePosition.entryBlock),
      pnlCNS: BigInt(sourcePosition.pnlCNS),
      priceResiduePNSQ16: BigInt(sourcePosition.priceResiduePNSQ16),
    }
    const market = publicFixture.context.markets.find((item) => item.id === 100)!
    if (
      BigInt(walletFixture.entryBlock.number) !== position.entryBlock ||
      new Date(Number(BigInt(walletFixture.entryBlock.timestamp)) * 1000).toISOString() !==
        walletFixture.entryBlock.openedAt
    )
      throw new Error('RECORDED_ENTRY_BLOCK_MISMATCH')
    const profile = profileFromViews(
      account.accountAddr,
      account,
      [
        {
          market,
          result: [position, BigInt(walletFixture.position[1]), walletFixture.position[2]],
          openedAt: walletFixture.entryBlock.openedAt,
        },
      ],
      Number(walletFixture.blockNumber),
      walletFixture.capturedAt,
    )
    // The snapshot is archived evidence, never a fresh balance or a full history.
    profile.stale = true
    const wallet = {
      profile: async (address: string) =>
        address.toLowerCase() === account.accountAddr.toLowerCase()
          ? { ...profile, data: { ...profile.data, address } }
          : null,
    } as unknown as WalletChainAnalytics
    const config = loadConfig({ EYELER_ENV: 'test' })
    await app.register(cookie, { secret: config.sessionSecret })
    await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })
    process.env.EYELER_ANALYTICS_ENABLED = 'true'
    registerRoutes({
      app,
      config,
      persistence: store,
      auth: new AuthService(store, config.sessionSecret),
      notificationStore: null,
      analytics: { publicData, wallet },
    })
    app.addHook('onClose', async () => db.close())
    return app
  } catch (error) {
    await app.close()
    await db.close()
    throw error
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = await createAnalyticsFixtureServer()
  const timeout = setTimeout(() => {
    void app.close()
  }, 300_000)
  app.addHook('onClose', async () => {
    clearTimeout(timeout)
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void app.close()
    })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  console.log(address)
}
