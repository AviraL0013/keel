import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { KMSClient } from '@aws-sdk/client-kms'
import { AwsKmsKeyCustody, type CustodyAuditEvent } from '../server/src/infrastructure/perpl/kms-key-custody.js'
import { credentialContext } from '../server/src/infrastructure/perpl/key-custody.js'
import { PerplUserVenues, type PerplUserCredentials } from '../server/src/infrastructure/perpl/user-venues.js'
import { rotateCredentialBatch } from '../server/src/infrastructure/perpl/rotate-credentials.js'
import { databaseFixture } from './helpers/database.js'
import { fakeKms, fixtureKmsKeyArn, fixtureNextKmsKeyArn } from './helpers/kms.js'

afterEach(() => vi.restoreAllMocks())

it('uses KMS envelopes across two users, restart and replacement-key rotation without AWS or venue traffic', async () => {
  const realAws = vi.spyOn(KMSClient.prototype, 'send').mockImplementation(() => {
    throw new Error('REAL_AWS_FORBIDDEN_IN_TEST')
  })
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN_IN_TEST'))
  const { db, store } = await databaseFixture()
  const kms = fakeKms()
  const audit: CustodyAuditEvent[] = []
  const custody = (keyArn: string, decryptKeyArns: string[] = []) =>
    new AwsKmsKeyCustody({
      keyArn,
      decryptKeyArns,
      environment: 'mainnet',
      client: kms.client,
      audit: (event) => {
        audit.push(event)
      },
    })
  const first = custody(fixtureKmsKeyArn)
  const registry = (provider: AwsKmsKeyCustody) => new PerplUserVenues(store, 'mainnet', provider, factory)
  const factory = vi.fn(async (credentials: PerplUserCredentials) => ({
    accountId: credentials.accountId,
    ready: () => true,
    close: vi.fn(async () => {}),
    refresh: vi.fn(),
    submit: vi.fn(),
    reconcile: vi.fn(),
    listPositions: vi.fn(async () => []),
  }))
  let venues = registry(first)
  const add = async (number: number) => {
    const userId = await store.ensureUser(`0x${number.toString(16).padStart(40, '0')}`)
    const id = randomUUID()
    const privateKey = `synthetic-private-${number}`,
      apiKey = `synthetic-api-${number}`
    const privateEnvelope = await first.seal(privateKey, credentialContext(userId, id, 'private_key'))
    const apiEnvelope = await first.seal(apiKey, credentialContext(userId, id, 'api_token'))
    await store.pool.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,wallet_address,
       scope_mask,expires_at,sealed_private_key,sealed_api_token)
       SELECT $1::uuid,id,'mainnet','trade',$1::text,'ACTIVE',wallet_address,3,now()+interval '1 day',$3,$4
       FROM users WHERE id=$2`,
      [id, userId, privateEnvelope, apiEnvelope],
    )
    await store.pool.query('INSERT INTO perpl_accounts(connection_id,account_id) VALUES($1,$2)', [id, number])
    return { userId, id, privateKey, apiKey, privateEnvelope }
  }
  try {
    await first.assertReady()
    const a = await add(101),
      b = await add(202)
    expect(await venues.forUser(a.userId)).toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
    await venues.start()
    await venues.forUser(a.userId, a.id)
    await venues.forUser(b.userId, b.id)
    expect(factory.mock.calls.map(([credentials]) => [credentials.userId, credentials.accountId])).toEqual([
      [a.userId, 101],
      [b.userId, 202],
    ])
    expect(await venues.forUser(b.userId, a.id)).toBeUndefined()
    await venues.close()

    const next = custody(fixtureNextKmsKeyArn, [fixtureKmsKeyArn])
    const plan = await rotateCredentialBatch(store, next, 'mainnet')
    expect(plan).toMatchObject({ scanned: 2, rotated: 0 })
    const rotated = await rotateCredentialBatch(store, next, 'mainnet', { apply: true })
    expect(rotated).toMatchObject({ scanned: 2, rotated: 2 })
    // A fresh process accepts only the new key after every row has been rewrapped.
    venues = registry(custody(fixtureNextKmsKeyArn))
    await venues.start()
    await venues.forUser(a.userId, a.id)
    await venues.forUser(b.userId, b.id)
    expect(factory.mock.calls.at(-2)![0]).toMatchObject({ privateKey: a.privateKey, apiKey: a.apiKey })
    expect(factory.mock.calls.at(-1)![0]).toMatchObject({ privateKey: b.privateKey, apiKey: b.apiKey })
    await venues.close()

    // Copying a valid user's ciphertext into another row cannot redirect a session.
    await store.pool.query(
      `UPDATE perpl_connections SET sealed_private_key=(SELECT sealed_private_key FROM perpl_connections WHERE id=$1)
       WHERE id=$2`,
      [a.id, b.id],
    )
    venues = registry(custody(fixtureNextKmsKeyArn))
    await venues.start()
    const calls = factory.mock.calls.length
    await expect(venues.forUser(b.userId, b.id)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    expect(factory).toHaveBeenCalledTimes(calls)
    const logs = JSON.stringify(audit)
    for (const secret of [a.privateKey, a.apiKey, b.privateKey, b.apiKey, a.privateEnvelope])
      expect(logs).not.toContain(secret)
    expect(kms.returnedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true)
    expect(realAws).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  } finally {
    await venues.close()
    kms.clear()
    await db.close()
  }
}, 30000)
