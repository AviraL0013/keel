import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { verifyAsync } from '@noble/ed25519'
import { hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { perplEnrollmentPayload } from './helpers/perpl-enrollment.js'
import type { EnrollmentPayloadRequest } from '../server/src/infrastructure/perpl/enrollment-client.js'
import { databaseFixture } from './helpers/database.js'
import { loadConfig } from '../packages/shared/src/index.js'
import {
  DevelopmentKeyCustody,
  credentialContext,
  type KeyCustody,
} from '../server/src/infrastructure/perpl/key-custody.js'
import { loadEnrollmentConfig, PerplEnrollmentService } from '../server/src/infrastructure/perpl/enrollment-service.js'
import { PerplEnrollmentClient } from '../server/src/infrastructure/perpl/enrollment-client.js'
import { AuthService } from '../server/src/auth.js'
import { registerRoutes } from '../server/src/interfaces/http/register.js'

const wallet = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const origin = 'https://eyeler.example'

async function fixture(
  enrollStatus = 200,
  domainOrder = false,
  now: () => number = Date.now,
  asyncCustody = false,
  builderResponseFields?: Record<string, unknown>,
) {
  const { db, store } = await databaseFixture()
  const userId = await store.ensureUser(wallet.address)
  const custody = new DevelopmentKeyCustody('33'.repeat(32))
  const config = loadEnrollmentConfig(
    {
      PERPL_ENROLLMENT_ORIGIN: origin,
      ...(builderResponseFields === undefined ? {} : { EYELER_BUILDER_ID: '25', EYELER_MAX_BUILDER_FEE_PER_100K: '0' }),
    },
    loadConfig({ EYELER_ENV: 'test' }),
  )
  const requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = []
  let onEnroll: (() => Promise<void>) | undefined
  let walletStatus = 200
  let walletFrozen = false
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/v1/trading/wallet')) {
      if (walletStatus !== 200) return Response.json({ error: 'fake refusal' }, { status: walletStatus })
      return Response.json({
        addr: wallet.address,
        at: { b: 123 },
        as: [{ id: 7, b: '10000000', lb: '0', fw: false, fr: walletFrozen }],
      })
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ path, headers: new Headers(init?.headers), body })
    if (path.endsWith('/payload')) {
      return Response.json({
        mac: 'private-mac',
        typed_data: (() => {
          const typed = perplEnrollmentPayload(body as EnrollmentPayloadRequest, origin, now())
          if (domainOrder) typed.types.EIP712Domain.reverse()
          return typed
        })(),
      })
    }
    await onEnroll?.()
    if (enrollStatus !== 200) return Response.json({ error: 'fake venue refusal' }, { status: enrollStatus })
    const typed = body.typed_data as Parameters<typeof hashTypedData>[0]
    const digest = hashTypedData(typed)
    const publicKey = String(requests[0].body.public_key)
    expect(
      await verifyAsync(
        Buffer.from(String(body.pop_signature).slice(2), 'hex'),
        Buffer.from(digest.slice(2), 'hex'),
        Buffer.from(publicKey.slice(2), 'hex'),
      ),
    ).toBe(true)
    const altered = { ...typed, message: { ...typed.message, label: 'OTHER' } }
    const alteredDigest = hashTypedData(altered)
    expect(
      await verifyAsync(
        Buffer.from(String(body.pop_signature).slice(2), 'hex'),
        Buffer.from(alteredDigest.slice(2), 'hex'),
        Buffer.from(publicKey.slice(2), 'hex'),
      ),
    ).toBe(false)
    return Response.json({
      api_key: {
        api_key: 'private-token',
        address: wallet.address,
        scope_mask: 3,
        label: 'EYELER',
        origin,
        expires_at: requests[0].body.expires_at,
        ...(builderResponseFields ?? {}),
      },
    })
  }) as typeof fetch
  const client = new PerplEnrollmentClient('https://perpl.invalid/api', origin, fetcher)
  const asyncProvider: KeyCustody = {
    seal: vi.fn(async (value, context) => custody.seal(value, context)),
    open: vi.fn(async (value, context) => custody.open(value, context)),
    shred: () => null,
  }
  const service = new PerplEnrollmentService(
    store,
    config,
    asyncCustody ? asyncProvider : custody,
    client,
    now,
    fetcher,
  )
  const sign = async (typedData: unknown) =>
    wallet.signTypedData(typedData as Parameters<typeof wallet.signTypedData>[0])
  return {
    db,
    store,
    userId,
    custody,
    asyncProvider,
    config,
    client,
    service,
    requests,
    fetcher,
    sign,
    setOnEnroll: (callback: () => Promise<void>) => {
      onEnroll = callback
    },
    setWalletStatus: (status: number) => {
      walletStatus = status
    },
    setWalletFrozen: (frozen: boolean) => {
      walletFrozen = frozen
    },
    close: () => db.close(),
  }
}

describe('authenticated forwarding state', () => {
  it('reads fresh signed wallet state only for active owner, and never retries 403', async () => {
    const value = await fixture()
    try {
      expect(await value.service.accountState(value.userId, wallet.address)).toEqual({ status: 'NOT_CONNECTED' })
      const pending = await value.service.start(value.userId, wallet.address)
      await value.service.complete(
        value.userId,
        wallet.address,
        pending.connectionId,
        await value.sign(pending.typedData),
      )
      expect(await value.service.accountState(value.userId, wallet.address)).toEqual({
        status: 'AVAILABLE',
        accountId: 7,
        forwardingEnabled: false,
      })
      value.setWalletFrozen(true)
      await expect(value.service.accountState(value.userId, wallet.address)).rejects.toThrow(
        'PERPL_ACCOUNT_TRADING_UNAVAILABLE',
      )
      value.setWalletFrozen(false)
      expect(await value.service.accountState('00000000-0000-4000-8000-000000000002', wallet.address)).toEqual({
        status: 'NOT_CONNECTED',
      })
      value.setWalletStatus(403)
      const before = value.fetcher.mock.calls.length
      await expect(value.service.accountState(value.userId, wallet.address)).rejects.toThrow('PERPL_WALLET_HTTP_403')
      expect(value.fetcher.mock.calls.length).toBe(before + 1)
    } finally {
      await value.close()
    }
  }, 20_000)
})

describe('development Perpl enrollment foundation', () => {
  it('accepts a zero-fee builder response with its optional zero ceiling omitted', async () => {
    const value = await fixture(200, false, Date.now, false, { builder_id: 25 })
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      await expect(
        value.service.complete(value.userId, wallet.address, pending.connectionId, await value.sign(pending.typedData)),
      ).resolves.toMatchObject({ status: 'ACTIVE' })
    } finally {
      await value.close()
    }
  }, 20_000)

  it('rejects a missing or changed builder identity and any nonzero returned fee', async () => {
    for (const responseFields of [
      {},
      { builder_id: 26 },
      { builder_id: 25, max_builder_fee_per_100k: 1 },
      { builder_id: 25, address: null },
    ]) {
      const value = await fixture(200, false, Date.now, false, responseFields)
      try {
        const pending = await value.service.start(value.userId, wallet.address)
        await expect(
          value.service.complete(
            value.userId,
            wallet.address,
            pending.connectionId,
            await value.sign(pending.typedData),
          ),
        ).rejects.toThrow('PERPL_ENROLLMENT_RESPONSE_MISMATCH')
        const row = (
          await value.db.query('SELECT status,last_error,sealed_api_token FROM perpl_connections WHERE id=$1', [
            pending.connectionId,
          ])
        ).rows[0]
        expect(row).toMatchObject({ status: 'ERROR', last_error: 'ENROLLED_NOT_SAVED', sealed_api_token: null })
      } finally {
        await value.close()
      }
    }
  }, 30_000)

  it('awaits asynchronous custody and binds all sealed fields to the authenticated owner and credential', async () => {
    const f = await fixture(200, false, Date.now, true)
    try {
      const pending = await f.service.start(f.userId, wallet.address)
      await f.service.complete(f.userId, wallet.address, pending.connectionId, await f.sign(pending.typedData))
      for (const field of ['private_key', 'mac', 'api_token'] as const)
        expect(f.asyncProvider.seal).toHaveBeenCalledWith(
          expect.any(String),
          credentialContext(f.userId, pending.connectionId, field),
        )
      expect(f.asyncProvider.open).toHaveBeenCalledWith(
        expect.any(String),
        credentialContext(f.userId, pending.connectionId, 'private_key'),
      )
      const row = (
        await f.db.query('SELECT sealed_api_token FROM perpl_connections WHERE id=$1', [pending.connectionId])
      ).rows[0]
      expect(f.custody.open(row.sealed_api_token, credentialContext(f.userId, pending.connectionId, 'api_token'))).toBe(
        'private-token',
      )
      expect(() =>
        f.custody.open(row.sealed_api_token, credentialContext('different-user', pending.connectionId, 'api_token')),
      ).toThrow('INVALID_SEALED_CREDENTIAL')
    } finally {
      await f.close()
    }
  }, 20000)
  it('revalidates saved signing terms before enrollment even if a tampered payload has a valid wallet signature', async () => {
    const f = await fixture()
    try {
      const pending = await f.service.start(f.userId, wallet.address)
      pending.typedData.message.scope = '7'
      await f.store.pool.query('UPDATE perpl_connections SET typed_data=$2 WHERE id=$1', [
        pending.connectionId,
        JSON.stringify(pending.typedData),
      ])
      const signature = await f.sign(pending.typedData)
      await expect(f.service.complete(f.userId, wallet.address, pending.connectionId, signature)).rejects.toThrow(
        'PERPL_ENROLLMENT_PAYLOAD_MISMATCH',
      )
      expect(f.requests.filter((r) => r.path.endsWith('/enroll'))).toHaveLength(0)
    } finally {
      await f.close()
    }
  }, 20000)
  it('rejects substituted enrollment terms before persisting a signing request', async () => {
    const value = await fixture()
    try {
      const original = value.client.payload.bind(value.client)
      for (const mutate of [
        (t: any) => {
          t.message.signer = other.address
        },
        (t: any) => {
          t.message.scope = '7'
        },
        (t: any) => {
          t.message.publicKey = `0x${'ff'.repeat(32)}`
        },
        (t: any) => {
          t.message.publicKey = Buffer.alloc(32, 0xff).toString('base64url')
        },
        (t: any) => {
          t.message.publicKey = `${t.message.publicKey}=`
        },
        (t: any) => {
          t.message.expiresAt = '9999999999999'
        },
        (t: any) => {
          t.message.origin = 'https://evil.invalid'
        },
        (t: any) => {
          t.message.builderId = '26'
        },
        (t: any) => {
          t.message.maxBuilderFeePer100K = '100'
        },
        (t: any) => {
          t.domain.chainId = '0x8f'
        },
        (t: any) => {
          t.domain.verifyingContract = other.address
        },
        (t: any) => {
          t.primaryType = 'Permit'
        },
        (t: any) => {
          t.types.PerplRegisterApiKey[0].type = 'string'
        },
        (t: any) => {
          t.message.time = '0x1'
        },
      ]) {
        vi.spyOn(value.client, 'payload').mockImplementation(async (request) => {
          const payload = await original(request)
          mutate(payload.typed_data)
          return payload
        })
        await expect(value.service.start(value.userId, wallet.address)).rejects.toThrow(
          'PERPL_ENROLLMENT_PAYLOAD_MISMATCH',
        )
        expect((await value.db.query('SELECT id FROM perpl_connections')).rows).toHaveLength(0)
      }
    } finally {
      await value.close()
    }
  }, 20_000)

  it('binds sealed credentials to their row and field and rejects truncated tags', () => {
    const custody = new DevelopmentKeyCustody('33'.repeat(32))
    const sealed = custody.seal('row-secret', 'connection-a:private_key')
    expect(custody.open(sealed, 'connection-a:private_key')).toBe('row-secret')
    expect(() => custody.open(sealed, 'connection-b:private_key')).toThrow('INVALID_SEALED_CREDENTIAL')
    expect(() => custody.open(sealed, 'connection-a:mac')).toThrow('INVALID_SEALED_CREDENTIAL')
    const parts = sealed.split(':')
    parts[2] = Buffer.from(Buffer.from(parts[2], 'base64url').subarray(0, 15)).toString('base64url')
    expect(() => custody.open(parts.join(':'), 'connection-a:private_key')).toThrow('INVALID_SEALED_CREDENTIAL')
  })

  it('enrolls the session wallet with a sealed key and valid proof-of-possession', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      expect(Object.keys(pending).sort()).toEqual(['connectionId', 'typedData'])
      const row = (await value.db.query('SELECT * FROM perpl_connections WHERE id=$1', [pending.connectionId])).rows[0]
      expect(row.status).toBe('PENDING')
      expect(row.sealed_private_key).not.toContain('private-token')
      expect(row.sealed_mac).not.toContain('private-mac')
      expect(row.credential_reference).toBe(`enrollment:${pending.connectionId}`)
      expect(value.requests[0].headers.get('origin')).toBe(origin)
      expect(value.requests[0].body).toMatchObject({
        address: wallet.address.toLowerCase(),
        scope_mask: 3,
        label: 'EYELER',
        chain_id: 10143,
      })
      const signature = await value.sign(pending.typedData)
      const complete = await value.service.complete(value.userId, wallet.address, pending.connectionId, signature)
      expect(complete).toEqual({ connectionId: pending.connectionId, status: 'ACTIVE' })
      const active = (await value.db.query('SELECT * FROM perpl_connections WHERE id=$1', [pending.connectionId]))
        .rows[0]
      expect(active.status).toBe('ACTIVE')
      expect(
        value.custody.open(active.sealed_api_token, credentialContext(value.userId, pending.connectionId, 'api_token')),
      ).toBe('private-token')
      expect(active.sealed_mac).toBeNull()
      expect(active.typed_data).toBeNull()
      expect(value.requests[1].headers.get('origin')).toBe(origin)
      expect(value.requests[1].body.mac).toBe('private-mac')
      expect(JSON.stringify([pending, complete])).not.toMatch(
        /private-token|private-mac|sealed_private_key|sealed_api_token/,
      )
    } finally {
      await value.close()
    }
  }, 20_000)

  it('rejects a wallet mismatch before enrollment', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      const signature = await value.sign(pending.typedData)
      await expect(
        value.service.complete(value.userId, other.address, pending.connectionId, signature),
      ).rejects.toThrow('PERPL_ENROLLMENT_WALLET_MISMATCH')
      expect(value.requests).toHaveLength(1)
      expect(
        (await value.db.query('SELECT status FROM perpl_connections WHERE id=$1', [pending.connectionId])).rows[0]
          .status,
      ).toBe('PENDING')
    } finally {
      await value.close()
    }
  }, 20_000)

  it('rejects a wrong wallet signature without contacting the enrollment endpoint', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      const signature = await other.signTypedData(pending.typedData as Parameters<typeof other.signTypedData>[0])
      await expect(
        value.service.complete(value.userId, wallet.address, pending.connectionId, signature),
      ).rejects.toThrow('WALLET_SIGNATURE_INVALID')
      expect(value.requests).toHaveLength(1)
      expect(
        (await value.db.query('SELECT status FROM perpl_connections WHERE id=$1', [pending.connectionId])).rows[0]
          .status,
      ).toBe('PENDING')
    } finally {
      await value.close()
    }
  }, 20_000)

  it('uses Perpl domain field order for wallet verification and proof-of-possession', async () => {
    const value = await fixture(200, true)
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      const domainFields = (pending.typedData.types as Record<string, Array<{ name: string }>>).EIP712Domain
      expect(domainFields.map((field) => field.name)).toEqual([
        'salt',
        'verifyingContract',
        'chainId',
        'version',
        'name',
      ])
      expect(
        await value.service.complete(
          value.userId,
          wallet.address,
          pending.connectionId,
          await value.sign(pending.typedData),
        ),
      ).toEqual({ connectionId: pending.connectionId, status: 'ACTIVE' })
    } finally {
      await value.close()
    }
  }, 20_000)

  it('commits ENROLLING before calling Perpl and blocks duplicate enrollment', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      value.setOnEnroll(async () => {
        const row = (
          await value.db.query('SELECT status,public_key FROM perpl_connections WHERE id=$1', [pending.connectionId])
        ).rows[0]
        expect(row.status).toBe('ENROLLING')
        expect(row.public_key).toBe(value.requests[0].body.public_key)
        await expect(value.service.start(value.userId, wallet.address)).rejects.toThrow(
          'PERPL_ENROLLMENT_ALREADY_PENDING',
        )
      })
      await value.service.complete(
        value.userId,
        wallet.address,
        pending.connectionId,
        await value.sign(pending.typedData),
      )
      expect(value.requests).toHaveLength(2)
    } finally {
      await value.close()
    }
  }, 20_000)

  it('recovers a stuck ENROLLING row after restart and lets the wallet enroll again', async () => {
    const clock = { now: Date.now() }
    const value = await fixture(200, false, () => clock.now)
    let entered!: () => void
    const enrollmentStarted = new Promise<void>((resolve) => {
      entered = resolve
    })
    let stopRequest!: (reason: Error) => void
    const stalledRequest = new Promise<void>((_, reject) => {
      stopRequest = reject
    })
    let completing: Promise<unknown> | undefined
    const app = Fastify({ logger: false })
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      value.setOnEnroll(async () => {
        entered()
        await stalledRequest
      })
      completing = value.service.complete(
        value.userId,
        wallet.address,
        pending.connectionId,
        await value.sign(pending.typedData),
      )
      await enrollmentStarted
      const inFlight = (await value.db.query('SELECT * FROM perpl_connections WHERE id=$1', [pending.connectionId]))
        .rows[0]
      expect(inFlight.status).toBe('ENROLLING')
      expect(new Date(inFlight.pending_expires_at).getTime()).toBe(clock.now + 300_000)
      const restarted = new PerplEnrollmentService(
        value.store,
        value.config,
        value.custody,
        value.client,
        () => clock.now,
      )
      clock.now += 300_001
      await restarted.cleanupExpired()
      const row = (await value.db.query('SELECT * FROM perpl_connections WHERE id=$1', [pending.connectionId])).rows[0]
      expect(row).toMatchObject({
        status: 'ERROR',
        last_error: 'ENROLLMENT_OUTCOME_UNKNOWN',
        public_key: inFlight.public_key,
        sealed_private_key: null,
        sealed_mac: null,
        typed_data: null,
      })
      expect(row.shredded_at).not.toBeNull()
      const config = loadConfig({ EYELER_ENV: 'test' })
      await app.register(cookie, { secret: config.sessionSecret })
      registerRoutes({
        app,
        config,
        persistence: value.store,
        auth: new AuthService(value.store, config.sessionSecret),
        notificationStore: null,
        enrollment: restarted,
      })
      await value.store.createSession('stuck-enrollment-session', {
        userId: value.userId,
        walletAddress: wallet.address.toLowerCase(),
        expiresAt: Date.now() + 3_600_000,
      })
      const listed = await app.inject({
        method: 'GET',
        url: '/connections',
        headers: { authorization: 'Bearer stuck-enrollment-session' },
      })
      expect(listed.statusCode).toBe(200)
      expect(listed.json()[0]).toMatchObject({
        status: 'ERROR',
        lastError: 'ENROLLMENT_OUTCOME_UNKNOWN',
        publicKey: inFlight.public_key,
        perplKeyPageUrl: 'https://testnet.perpl.xyz/apikeys',
      })
      const next = await restarted.start(value.userId, wallet.address)
      expect(next.connectionId).not.toBe(pending.connectionId)
    } finally {
      stopRequest?.(new Error('SIMULATED_PROCESS_STOP'))
      if (completing) await expect(completing).rejects.toThrow()
      await app.close()
      await value.close()
    }
  }, 20_000)

  it('keeps ENROLLING secrets while its deadline has not elapsed', async () => {
    const clock = { now: Date.now() }
    const value = await fixture(200, false, () => clock.now)
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      await value.db.query("UPDATE perpl_connections SET status='ENROLLING',pending_expires_at=$2 WHERE id=$1", [
        pending.connectionId,
        new Date(clock.now + 300_000).toISOString(),
      ])
      clock.now += 299_999
      await new PerplEnrollmentService(
        value.store,
        value.config,
        value.custody,
        value.client,
        () => clock.now,
      ).cleanupExpired()
      const row = (
        await value.db.query(
          'SELECT status,last_error,sealed_private_key,sealed_mac,typed_data FROM perpl_connections WHERE id=$1',
          [pending.connectionId],
        )
      ).rows[0]
      expect(row.status).toBe('ENROLLING')
      expect(row.last_error).toBeNull()
      expect(row.sealed_private_key).not.toBeNull()
      expect(row.sealed_mac).not.toBeNull()
      expect(row.typed_data).not.toBeNull()
    } finally {
      await value.close()
    }
  }, 20_000)

  it('protects an in-flight enrollment from local revoke and legacy validation', async () => {
    const value = await fixture()
    const app = Fastify({ logger: false })
    try {
      const config = loadConfig({ EYELER_ENV: 'test' })
      await app.register(cookie, { secret: config.sessionSecret })
      registerRoutes({
        app,
        config,
        persistence: value.store,
        auth: new AuthService(value.store, config.sessionSecret),
        notificationStore: null,
        enrollment: value.service,
      })
      await value.store.createSession('inflight-enrollment-session', {
        userId: value.userId,
        walletAddress: wallet.address.toLowerCase(),
        expiresAt: Date.now() + 3_600_000,
      })
      const pending = await value.service.start(value.userId, wallet.address)
      value.setOnEnroll(async () => {
        await expect(value.service.disconnect(value.userId, pending.connectionId)).rejects.toThrow(
          'PERPL_ENROLLMENT_IN_PROGRESS',
        )
        await expect(value.store.revokeConnection(value.userId)).rejects.toThrow('PERPL_ENROLLMENT_IN_PROGRESS')
        const validated = await app.inject({
          method: 'POST',
          url: '/connections/perpl/validate',
          headers: { authorization: 'Bearer inflight-enrollment-session' },
          payload: {},
        })
        expect(validated.statusCode).toBe(200)
        expect(
          (await value.db.query('SELECT status FROM perpl_connections WHERE id=$1', [pending.connectionId])).rows[0]
            .status,
        ).toBe('ENROLLING')
      })
      await value.service.complete(
        value.userId,
        wallet.address,
        pending.connectionId,
        await value.sign(pending.typedData),
      )
      expect(
        (await value.db.query('SELECT status FROM perpl_connections WHERE id=$1', [pending.connectionId])).rows[0]
          .status,
      ).toBe('ACTIVE')
    } finally {
      await app.close()
      await value.close()
    }
  }, 20_000)

  it('preserves the public key and flags a Perpl success whose token could not be saved', async () => {
    const value = await fixture()
    const pending = await value.service.start(value.userId, wallet.address)
    const originalQuery = value.db.query.bind(value.db)
    let failFinalWrite = true
    const querySpy = vi.spyOn(value.db, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
      if (failFinalWrite && sql.includes("SET status='ACTIVE'")) {
        failFinalWrite = false
        throw new Error('SIMULATED_DB_FAILURE')
      }
      return originalQuery(sql, values)
    }) as typeof value.db.query)
    try {
      await expect(
        value.service.complete(value.userId, wallet.address, pending.connectionId, await value.sign(pending.typedData)),
      ).rejects.toThrow('PERPL_ENROLLED_NOT_SAVED')
      expect(value.requests).toHaveLength(2)
      const row = (
        await value.db.query(
          'SELECT status,last_error,public_key,sealed_api_token FROM perpl_connections WHERE id=$1',
          [pending.connectionId],
        )
      ).rows[0]
      expect(row).toMatchObject({
        status: 'ERROR',
        last_error: 'ENROLLED_NOT_SAVED',
        public_key: value.requests[0].body.public_key,
        sealed_api_token: null,
      })
      await expect(value.service.start(value.userId, wallet.address)).rejects.toThrow(
        'PERPL_ENROLLMENT_REVIEW_REQUIRED',
      )
      const app = Fastify({ logger: false })
      try {
        const config = loadConfig({ EYELER_ENV: 'test' })
        await app.register(cookie, { secret: config.sessionSecret })
        registerRoutes({
          app,
          config,
          persistence: value.store,
          auth: new AuthService(value.store, config.sessionSecret),
          notificationStore: null,
          enrollment: value.service,
        })
        await value.store.createSession('enrollment-failure-session', {
          userId: value.userId,
          walletAddress: wallet.address.toLowerCase(),
          expiresAt: Date.now() + 3_600_000,
        })
        const listed = await app.inject({
          method: 'GET',
          url: '/connections',
          headers: { authorization: 'Bearer enrollment-failure-session' },
        })
        expect(listed.statusCode).toBe(200)
        expect(listed.json()[0]).toMatchObject({
          status: 'ERROR',
          lastError: 'ENROLLED_NOT_SAVED',
          publicKey: row.public_key,
          perplKeyPageUrl: 'https://testnet.perpl.xyz/apikeys',
        })
      } finally {
        await app.close()
      }
    } finally {
      querySpy.mockRestore()
      await value.close()
    }
  }, 20_000)

  it('permits only one pending or active enrollment for a wallet', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      await expect(value.service.start(value.userId, wallet.address)).rejects.toThrow(
        'PERPL_ENROLLMENT_ALREADY_PENDING',
      )
      await value.service.complete(
        value.userId,
        wallet.address,
        pending.connectionId,
        await value.sign(pending.typedData),
      )
      await expect(value.service.start(value.userId, wallet.address)).rejects.toThrow('PERPL_CONNECTION_ALREADY_ACTIVE')
      expect(value.requests).toHaveLength(2)
    } finally {
      await value.close()
    }
  }, 20_000)

  it.each([
    [400, 'PERPL_ENROLLMENT_INVALID_REQUEST'],
    [404, 'PERPL_ENROLLMENT_TARGET_NOT_FOUND'],
    [409, 'PERPL_ENROLLMENT_KEY_CONFLICT'],
    [423, 'PERPL_ENROLLMENT_KEY_LIMIT'],
  ] as const)(
    'maps venue %s and shreds the failed enrollment',
    async (status, error) => {
      const value = await fixture(status)
      try {
        const pending = await value.service.start(value.userId, wallet.address)
        await expect(
          value.service.complete(
            value.userId,
            wallet.address,
            pending.connectionId,
            await value.sign(pending.typedData),
          ),
        ).rejects.toThrow(error)
        const row = (await value.db.query('SELECT * FROM perpl_connections WHERE id=$1', [pending.connectionId]))
          .rows[0]
        expect(row.status).toBe('ERROR')
        expect(row.sealed_private_key).toBeNull()
        expect(row.sealed_api_token).toBeNull()
        expect(row.sealed_mac).toBeNull()
        expect(row.shredded_at).not.toBeNull()
      } finally {
        await value.close()
      }
    },
    20_000,
  )

  it('expires and shreds a PENDING row after ten minutes', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      await value.db.query("UPDATE perpl_connections SET pending_expires_at=now()-interval '1 second' WHERE id=$1", [
        pending.connectionId,
      ])
      await expect(
        value.service.complete(value.userId, wallet.address, pending.connectionId, await value.sign(pending.typedData)),
      ).rejects.toThrow('PERPL_ENROLLMENT_NOT_PENDING')
      const row = (
        await value.db.query(
          'SELECT status,sealed_private_key,sealed_mac,shredded_at FROM perpl_connections WHERE id=$1',
          [pending.connectionId],
        )
      ).rows[0]
      expect(row.status).toBe('EXPIRED')
      expect(row.sealed_private_key).toBeNull()
      expect(row.sealed_mac).toBeNull()
      expect(row.shredded_at).not.toBeNull()
      expect(value.requests).toHaveLength(1)
    } finally {
      await value.close()
    }
  }, 20_000)

  it('shows an expired ACTIVE key as expired and shreds it', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      await value.service.complete(
        value.userId,
        wallet.address,
        pending.connectionId,
        await value.sign(pending.typedData),
      )
      await value.db.query("UPDATE perpl_connections SET expires_at=now()-interval '1 second' WHERE id=$1", [
        pending.connectionId,
      ])
      await value.service.cleanupExpired()
      const row = (
        await value.db.query(
          'SELECT status,sealed_private_key,sealed_api_token,shredded_at FROM perpl_connections WHERE id=$1',
          [pending.connectionId],
        )
      ).rows[0]
      expect(row.status).toBe('EXPIRED')
      expect(row.sealed_private_key).toBeNull()
      expect(row.sealed_api_token).toBeNull()
      expect(row.shredded_at).not.toBeNull()
    } finally {
      await value.close()
    }
  }, 20_000)

  it('disconnects and shreds the stored key and token', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      await value.service.complete(
        value.userId,
        wallet.address,
        pending.connectionId,
        await value.sign(pending.typedData),
      )
      const response = await value.service.disconnect(value.userId, pending.connectionId)
      expect(response.perplKeyPageUrl).toBe('https://testnet.perpl.xyz/apikeys')
      const row = (
        await value.db.query(
          'SELECT status,sealed_private_key,sealed_api_token,shredded_at FROM perpl_connections WHERE id=$1',
          [pending.connectionId],
        )
      ).rows[0]
      expect(row.status).toBe('REVOKED')
      expect(row.sealed_private_key).toBeNull()
      expect(row.sealed_api_token).toBeNull()
      expect(row.shredded_at).not.toBeNull()
      expect(JSON.stringify(response)).not.toContain('private-token')
    } finally {
      await value.close()
    }
  }, 20_000)

  it('also shreds enrolled credentials through the legacy revoke route', async () => {
    const value = await fixture()
    try {
      const pending = await value.service.start(value.userId, wallet.address)
      await value.service.complete(
        value.userId,
        wallet.address,
        pending.connectionId,
        await value.sign(pending.typedData),
      )
      await value.store.revokeConnection(value.userId)
      const row = (
        await value.db.query(
          'SELECT status,sealed_private_key,sealed_api_token,shredded_at FROM perpl_connections WHERE id=$1',
          [pending.connectionId],
        )
      ).rows[0]
      expect(row.status).toBe('REVOKED')
      expect(row.sealed_private_key).toBeNull()
      expect(row.sealed_api_token).toBeNull()
      expect(row.shredded_at).not.toBeNull()
    } finally {
      await value.close()
    }
  }, 20_000)

  it('exposes only safe enrollment fields through authenticated HTTP routes and logs', async () => {
    const value = await fixture()
    const app = Fastify({ logger: false })
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errored = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const config = loadConfig({ EYELER_ENV: 'test' })
      await app.register(cookie, { secret: config.sessionSecret })
      registerRoutes({
        app,
        config,
        persistence: value.store,
        auth: new AuthService(value.store, config.sessionSecret),
        notificationStore: null,
        enrollment: value.service,
      })
      await value.store.createSession('enrollment-session', {
        userId: value.userId,
        walletAddress: wallet.address.toLowerCase(),
        expiresAt: Date.now() + 3_600_000,
      })
      const headers = { authorization: 'Bearer enrollment-session' }
      const unauthenticated = await app.inject({ method: 'POST', url: '/connections/perpl/enrollment', payload: {} })
      expect(unauthenticated.statusCode).toBe(401)
      expect(value.requests).toHaveLength(0)
      const start = await app.inject({
        method: 'POST',
        url: '/connections/perpl/enrollment',
        headers,
        payload: { address: other.address },
      })
      expect(start.statusCode).toBe(200)
      expect(value.requests[0].body.address).toBe(wallet.address.toLowerCase())
      const pending = start.json() as { connectionId: string; typedData: unknown }
      expect(Object.keys(pending).sort()).toEqual(['connectionId', 'typedData'])
      const completed = await app.inject({
        method: 'POST',
        url: `/connections/perpl/enrollment/${pending.connectionId}/complete`,
        headers,
        payload: { signature: await value.sign(pending.typedData) },
      })
      expect(completed.statusCode).toBe(200)
      expect(completed.json()).toEqual({ connectionId: pending.connectionId, status: 'ACTIVE' })
      const listed = await app.inject({ method: 'GET', url: '/connections', headers })
      expect(listed.statusCode).toBe(200)
      expect(listed.json()[0].status).toBe('ACTIVE')
      await value.db.query(
        "UPDATE perpl_connections SET environment='mainnet',last_error='ENROLLED_NOT_SAVED' WHERE id=$1",
        [pending.connectionId],
      )
      const mainnetRecovery = await app.inject({ method: 'GET', url: '/connections', headers })
      expect(mainnetRecovery.json()[0].perplKeyPageUrl).toBe('https://app.perpl.xyz/apikeys')
      const disconnected = await app.inject({
        method: 'POST',
        url: `/connections/perpl/${pending.connectionId}/disconnect`,
        headers,
        payload: {},
      })
      expect(disconnected.statusCode).toBe(200)
      const visible = [
        start.body,
        completed.body,
        listed.body,
        disconnected.body,
        JSON.stringify(logged.mock.calls),
        JSON.stringify(errored.mock.calls),
      ].join(' ')
      for (const secret of [
        'private-token',
        'private-mac',
        'sealed_private_key',
        'sealed_api_token',
        String(value.requests[1].body.pop_signature),
      ])
        expect(visible).not.toContain(secret)
    } finally {
      logged.mockRestore()
      errored.mockRestore()
      await app.close()
      await value.close()
    }
  }, 20_000)

  it('validates custody and enrollment settings and blocks mainnet without KMS', () => {
    expect(() => new DevelopmentKeyCustody('bad')).toThrow('INVALID_EYELER_KEY_ENCRYPTION_KEY')
    const config = loadConfig({ EYELER_ENV: 'testnet' })
    const base = { PERPL_ENROLLMENT_ORIGIN: origin }
    expect(loadEnrollmentConfig({ ...base, EYELER_KEY_TTL_DAYS: '90' }, config).ttlDays).toBe(90)
    expect(() => loadEnrollmentConfig({ ...base, EYELER_KEY_TTL_DAYS: '91' }, config)).toThrow(
      'INVALID_EYELER_KEY_TTL_DAYS',
    )
    expect(() => loadEnrollmentConfig({ ...base, EYELER_EGRESS_CIDRS: '192.0.2.1/32' }, config)).toThrow(
      'PERPL_CIDR_ENROLLMENT_NOT_SUPPORTED',
    )
    expect(() => loadEnrollmentConfig({ ...base, EYELER_KEY_TTL_DAYS: '0' }, config)).toThrow(
      'INVALID_EYELER_KEY_TTL_DAYS',
    )
    expect(() => loadEnrollmentConfig({ ...base, EYELER_EGRESS_CIDRS: 'not-a-cidr' }, config)).toThrow(
      'INVALID_EYELER_EGRESS_CIDRS',
    )
    expect(() =>
      loadEnrollmentConfig(
        { ...base, EYELER_EGRESS_CIDRS: '1.1.1.1/32,2.2.2.2/32,3.3.3.3/32,4.4.4.4/32,5.5.5.5/32' },
        config,
      ),
    ).toThrow('INVALID_EYELER_EGRESS_CIDRS')
    expect(() =>
      loadEnrollmentConfig({ ...base, EYELER_BUILDER_ID: '256', EYELER_MAX_BUILDER_FEE_PER_100K: '0' }, config),
    ).toThrow('INVALID_EYELER_BUILDER_TERMS')
    expect(() =>
      loadEnrollmentConfig({ ...base, EYELER_BUILDER_ID: '1', EYELER_MAX_BUILDER_FEE_PER_100K: '101' }, config),
    ).toThrow('INVALID_EYELER_BUILDER_TERMS')
    expect(() => loadEnrollmentConfig({ PERPL_ENROLLMENT_ORIGIN: 'http://insecure.example' }, config)).toThrow(
      'INVALID_PERPL_ENROLLMENT_ORIGIN',
    )
    expect(() => loadEnrollmentConfig(base, loadConfig({ EYELER_ENV: 'mainnet' }))).toThrow('KMS_CUSTODY_REQUIRED')
    const custody = new DevelopmentKeyCustody('33'.repeat(32))
    const sealed = custody.seal('example-secret', 'connection-a:private_key')
    expect(custody.open(sealed, 'connection-a:private_key')).toBe('example-secret')
    expect(() => custody.open(`${sealed}x`, 'connection-a:private_key')).toThrow('INVALID_SEALED_CREDENTIAL')
  })
})
