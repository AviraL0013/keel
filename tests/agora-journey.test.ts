import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { expect, it, vi } from 'vitest'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import type { LocalAccount } from 'viem'
import { ChainAdapter, chainConfigs } from '../packages/chain/src/index.js'
import type { CapitalAmount } from '../packages/domain/src/index.js'
import type { OpeningMarketDetail } from '../packages/perpl/src/opening-market.js'
import { loadConfig } from '../packages/shared/src/index.js'
import { AuthService } from '../server/src/auth.js'
import { OpeningTrades } from '../server/src/application/opening-trades.js'
import { createPublicCapital } from '../server/src/infrastructure/capital/snapshot.js'
import { DevelopmentKeyCustody } from '../server/src/infrastructure/perpl/key-custody.js'
import {
  PerplEnrollmentClient,
  type EnrollmentPayloadRequest,
} from '../server/src/infrastructure/perpl/enrollment-client.js'
import { PerplEnrollmentService } from '../server/src/infrastructure/perpl/enrollment-service.js'
import { registerRoutes } from '../server/src/interfaces/http/register.js'
import type { RuntimeVenue } from '../server/src/runtime.js'
import { databaseFixture } from './helpers/database.js'
import { perplEnrollmentPayload } from './helpers/perpl-enrollment.js'

// Public synthetic PRF bytes 00..1f under the Mera reference BIP-39/BIP-44
// recipe; the Flutter golden test asserts this same address. Never fund it.
const wallet = mnemonicToAccount(
  'abandon amount liar amount expire adjust cage candy arch gather drum bullet absurd math era live bid rhythm alien crouch range attend journey unaware',
)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const origin = 'https://app.eyeler.xyz'

async function login(app: FastifyInstance, account: LocalAccount = wallet) {
  const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: account.address } })
  expect(challenge.statusCode).toBe(200)
  const proof = challenge.json()
  expect(proof.message).toContain('Chain ID: 143')
  const response = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: {
      address: account.address,
      nonce: proof.nonce,
      message: proof.message,
      signature: await account.signMessage({ message: proof.message }),
    },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { token: string; userId: string }
}

it('joins Mera identity, exact mainnet AUSD, enrollment and one confirmed owner-only trade over HTTP with fake external transports', async () => {
  vi.stubEnv('EYELER_EXECUTION_DISABLED', 'false')
  const { db, store } = await databaseFixture()
  const app = Fastify()
  const connectionId = { value: '' }
  let forwarding = false
  let confirmed = false
  const observedAt = Date.now()
  const tokenRead = vi.spyOn(ChainAdapter.prototype, 'getAusdBalance').mockImplementation(async (address) => {
    expect(address.toLowerCase()).toBe(wallet.address.toLowerCase())
    return {
      balance: 123456789n,
      decimals: 6,
      symbol: 'AUSD',
      address: chainConfigs.mainnet.ausdToken,
      chainId: 143,
      blockNumber: 123n,
      observedAt: Date.now(),
    }
  })
  let payloadRequest: EnrollmentPayloadRequest
  const external = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/trading/wallet')) {
      return Response.json({
        addr: wallet.address,
        at: { b: 123 },
        as: [{ id: 12, b: '1000000000', lb: '0', fw: forwarding, fr: false }],
      })
    }
    const body = JSON.parse(String(init?.body))
    if (path.endsWith('/payload')) {
      payloadRequest = body
      expect(body).toMatchObject({ chain_id: 143, address: wallet.address.toLowerCase(), scope_mask: 3 })
      return Response.json({ mac: 'synthetic-mac', typed_data: perplEnrollmentPayload(body, origin, Date.now()) })
    }
    expect(path.endsWith('/enroll')).toBe(true)
    return Response.json({
      api_key: {
        api_key: 'synthetic-api-token',
        address: wallet.address,
        scope_mask: 3,
        label: 'EYELER',
        origin,
        expires_at: payloadRequest.expires_at,
      },
    })
  }) as typeof fetch
  const enrollment = new PerplEnrollmentService(
    store,
    { chainId: 143, environment: 'mainnet', origin, ttlDays: 90 },
    new DevelopmentKeyCustody('33'.repeat(32)), // Test fixture only, not production custody.
    new PerplEnrollmentClient('https://fake-perpl.invalid/api', origin, external),
    Date.now,
    external,
  )
  const publicCapital = createPublicCapital(store, { EYELER_ENV: 'mainnet' })!
  const amount = (value: string): CapitalAmount => ({
    amount: value,
    asset: 'AUSD',
    decimals: 6,
    source: 'PERPL_COLLATERAL',
    availability: 'AVAILABLE',
    freshness: 'FRESH',
  })
  const snapshot: OpeningMarketDetail = {
    environment: 'mainnet',
    accountId: 12,
    marketId: 7,
    symbol: 'BTC',
    collateralAsset: 'AUSD',
    priceDecimals: 1,
    sizeDecimals: 5,
    collateralDecimals: 6,
    bidRaw: 999999,
    askRaw: 1000001,
    markRaw: 1000000,
    priceTick: '0.1',
    sizeStep: '0.00001',
    minimumSize: '0.00001',
    initialMarginBps: 1000,
    takerFeeMicros: 500,
    minimumNotionalRaw: '1000000',
    recycleFeeRaw: '1000',
    marketOpen: true,
    marketObservedAt: observedAt,
    balanceObservedAt: observedAt,
    marketBlock: 100,
    headBlock: 101,
    headObservedAt: observedAt,
    orderTtlBlocks: 10,
    freeBalance: '1000.000000',
  }
  const submitOpening = vi.fn<NonNullable<RuntimeVenue['submitOpening']>>(async (_id, _order, beforeSend, verify) => {
    await beforeSend('12:45', 111)
    await verify?.()
    return {
      venueReference: '12:45',
      status: 'SUBMITTED',
      venueProgress: {
        requestId: '45',
        clientSequence: 1,
        admitted: true,
        requestedLastExecBlock: 111,
        response: 'ADMITTED',
      },
    }
  })
  const scoped: RuntimeVenue = {
    accountId: 12,
    ready: () => true,
    submitOpening,
    openingMarketSnapshot: async () => snapshot,
    submit: async () => {
      throw new Error('NO_LIVE_ORDER')
    },
    reconcile: async (action) => action,
    refresh: async () => {},
    close: async () => {},
    capital: async (address, userId) => ({
      ...(await publicCapital(address!, userId!)),
      status: 'VALID',
      accountId: 12,
      perplAvailable: amount('1000.000000'),
      perplLocked: amount('0.000000'),
    }),
    reconcileOpening: async () => {
      confirmed = true
      return {
        status: 'CONFIRMED',
        filledSize: '0.00100',
        averagePrice: '100000.0',
        positionId: 98,
        txHash: `0x${'a'.repeat(64)}`,
      }
    },
    listPositions: async () => {
      expect(confirmed).toBe(true)
      return [
        {
          marketId: 7,
          market: 'BTC',
          accountId: 12,
          positionId: 98,
          position: {
            side: 'LONG',
            size: 0.001,
            entryPrice: 100000,
            markPrice: 100000,
            liquidationPrice: 80000,
            leverage: 5,
            unrealizedPnl: 0,
            margin: 20,
            status: 'OPEN',
          },
          bookCreation: {
            allowed: false,
            code: 'MARKET_TELEMETRY_UNKNOWN',
            reason: 'FIXTURE_NO_TELEMETRY',
            market: { status: 'UNKNOWN', thresholdMs: 10000 },
            position: { status: 'UNKNOWN', thresholdMs: 10000 },
          },
        },
      ]
    },
  }
  const venue: RuntimeVenue = {
    ...scoped,
    forUser: async (userId, requested) => {
      const active = await store.pool.query(
        `SELECT id FROM perpl_connections WHERE user_id=$1 AND status='ACTIVE' AND environment='mainnet'`,
        [userId],
      )
      if (!active.rows.length || !forwarding || (requested && requested !== active.rows[0].id)) return undefined
      scoped.connectionId = active.rows[0].id
      return scoped
    },
  }
  try {
    await app.register(cookie)
    const config = loadConfig({
      EYELER_ENV: 'mainnet',
      EYELER_PERPL_ACCOUNT_MODE: 'per-user',
      EYELER_OPENING_ENABLED: 'true',
    })
    registerRoutes({
      app,
      config,
      persistence: store,
      auth: new AuthService(store, 'synthetic-session-secret', undefined, {
        origin,
        chainId: 143,
        environment: 'mainnet',
      }),
      notificationStore: null,
      venue,
      enrollment,
      publicCapital,
    })
    expect(wallet.address).toBe('0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F')
    expect((await app.inject({ url: '/capital' })).statusCode).toBe(401)
    const owner = await login(app)
    const headers = { authorization: `Bearer ${owner.token}` }
    const capital = (await app.inject({ url: '/capital', headers })).json()
    expect(capital.walletAgoraAusd).toMatchObject({
      amount: '123.456789',
      asset: 'AUSD',
      onChain: { wallet: wallet.address.toLowerCase(), chainId: 143, token: chainConfigs.mainnet.ausdToken },
    })
    expect(capital.perplAvailable.amount).toBeNull()
    expect(tokenRead).toHaveBeenCalled()
    const input = { marketId: 7, side: 'LONG', size: '0.00100', leverage: '5.00' }
    expect((await app.inject({ method: 'POST', url: '/openings/previews', headers, payload: input })).statusCode).toBe(
      503,
    )
    const started = await app.inject({ method: 'POST', url: '/connections/perpl/enrollment', headers })
    expect(started.statusCode).toBe(200)
    const pending = started.json()
    connectionId.value = pending.connectionId
    const signature = await wallet.signTypedData(pending.typedData)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/connections/perpl/enrollment/${connectionId.value}/complete`,
          headers,
          payload: { signature },
        })
      ).json(),
    ).toMatchObject({ status: 'ACTIVE' })
    expect((await app.inject({ url: '/connections/perpl/account-state', headers })).json()).toMatchObject({
      accountId: 12,
      forwardingEnabled: false,
    })
    expect((await app.inject({ method: 'POST', url: '/openings/previews', headers, payload: input })).statusCode).toBe(
      503,
    )
    // Explicit synthetic chain activation + authenticated venue synchronization.
    // No approval, deposit, forwarding transaction or network write is sent.
    forwarding = true
    await db.query('INSERT INTO perpl_accounts(connection_id,account_id,forwarding,frozen) VALUES($1,12,true,false)', [
      connectionId.value,
    ])
    const funded = (await app.inject({ url: '/capital', headers })).json()
    expect(funded.perplAvailable.amount).toBe('1000.000000')
    expect(funded.walletAgoraAusd.amount).toBe('123.456789') // Never sum these two sources.
    const preview = await app.inject({ method: 'POST', url: '/openings/previews', headers, payload: input })
    expect(preview.statusCode).toBe(200)
    expect(submitOpening).not.toHaveBeenCalled()
    const confirmation = { previewId: preview.json().id, idempotencyKey: randomUUID() }
    const stranger = await login(app, other)
    const strangerHeaders = { authorization: `Bearer ${stranger.token}` }
    expect(
      (await app.inject({ method: 'POST', url: '/openings/confirm', headers: strangerHeaders, payload: confirmation }))
        .statusCode,
    ).toBe(404)
    const admitted = await app.inject({ method: 'POST', url: '/openings/confirm', headers, payload: confirmation })
    expect(admitted.statusCode).toBe(200)
    expect(admitted.json().status).toBe('VERIFYING')
    expect(submitOpening).toHaveBeenCalledOnce()
    const again = await app.inject({ method: 'POST', url: '/openings/confirm', headers, payload: confirmation })
    expect(again.json().id).toBe(admitted.json().id)
    expect(submitOpening).toHaveBeenCalledOnce()
    const service = new OpeningTrades(store, venue, 'mainnet', { enabled: true, executionDisabled: false })
    await service.reconcile(owner.userId, admitted.json().id)
    const result = (await app.inject({ url: `/openings/${admitted.json().id}`, headers })).json()
    expect(result).toMatchObject({ status: 'CONFIRMED', position_id: 98, account_id: 12 })
    expect((await app.inject({ url: `/openings/${result.id}`, headers: strangerHeaders })).statusCode).toBe(404)
    expect((await app.inject({ url: '/connections/perpl/positions', headers })).json()).toMatchObject({
      status: 'VALID',
      positions: [{ accountId: 12, positionId: 98 }],
    })
    expect((await app.inject({ method: 'POST', url: '/auth/logout-all', headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/capital', headers })).statusCode).toBe(401)
    expect(submitOpening).toHaveBeenCalledOnce()
  } finally {
    await app.close()
    await db.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }
}, 30_000)
