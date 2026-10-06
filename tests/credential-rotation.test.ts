import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { databaseFixture } from './helpers/database.js'
import { rotateCredentialBatch } from '../server/src/infrastructure/perpl/rotate-credentials.js'
import { RailwayTestnetKeyCustody } from '../server/src/infrastructure/perpl/railway-testnet-key-custody.js'
import { credentialContext } from '../server/src/infrastructure/perpl/key-custody.js'

it('rewraps persisted testnet envelopes and keeps credentials decryptable after dropping the old key', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000001')
    const id = randomUUID()
    const oldCustody = new RailwayTestnetKeyCustody({ v1: '11'.repeat(32) }, 'v1')
    const old = await oldCustody.seal('credential', credentialContext(user, id, 'api_token'))
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,sealed_api_token) VALUES($1,$2,'testnet','trade','test','ACTIVE',$3)`,
      [id, user, old],
    )
    const upgraded = new RailwayTestnetKeyCustody({ v1: '11'.repeat(32), v2: '22'.repeat(32) }, 'v2')
    expect(await rotateCredentialBatch(store, upgraded, 'testnet', { apply: true })).toMatchObject({ rotated: 1 })
    const rotated = (await db.query('SELECT sealed_api_token FROM perpl_connections WHERE id=$1', [id])).rows[0]
      .sealed_api_token as string
    expect(
      await new RailwayTestnetKeyCustody({ v2: '22'.repeat(32) }, 'v2').open(
        rotated,
        credentialContext(user, id, 'api_token'),
      ),
    ).toBe('credential')
  } finally {
    await db.close()
  }
}, 20000)

it('keeps KMS-backed testnet rotation compatible with existing envelopes', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000001')
    const id = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,sealed_api_token) VALUES($1,$2,'testnet','trade','test','ACTIVE','kms-v1:original')`,
      [id, user],
    )
    const rotate = vi.fn(async () => 'kms-v1:rotated')
    expect(await rotateCredentialBatch(store, { rotate }, 'testnet', { apply: true })).toMatchObject({ rotated: 1 })
    expect(rotate).toHaveBeenCalledOnce()
  } finally {
    await db.close()
  }
}, 20000)

it('rotation is dry-run by default, scopes environment and never restores a concurrently revoked credential', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000001')
    const a = randomUUID(),
      b = randomUUID()
    await db.query(
      `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,sealed_private_key,sealed_api_token) VALUES($1,$3,'mainnet','trade','a','ACTIVE','kms-v1:old-private','kms-v1:old-token'),($2,$3,'testnet','trade','b','ACTIVE','kms-v1:test-private','kms-v1:test-token')`,
      [a, b, user],
    )
    const rotate = vi.fn(async (value: string) => `${value}-rotated`)
    const dry = await rotateCredentialBatch(store, { rotate }, 'mainnet')
    expect(dry).toMatchObject({ scanned: 1, rotated: 0, skipped: 0 })
    expect(rotate).not.toHaveBeenCalled()
    const applied = await rotateCredentialBatch(store, { rotate }, 'mainnet', { apply: true })
    expect(applied).toMatchObject({ scanned: 1, rotated: 1, skipped: 0 })
    expect(rotate).toHaveBeenCalledWith('kms-v1:old-private', { userId: user, credentialId: `${a}:private_key` })
    expect(
      (await db.query('SELECT sealed_private_key FROM perpl_connections WHERE id=$1', [b])).rows[0].sealed_private_key,
    ).toBe('kms-v1:test-private')
    rotate.mockImplementationOnce(async (value) => {
      await db.query(
        "UPDATE perpl_connections SET status='REVOKED',sealed_private_key=NULL,sealed_api_token=NULL,revoked_at=now() WHERE id=$1",
        [a],
      )
      return `${value}-again`
    })
    expect(await rotateCredentialBatch(store, { rotate }, 'mainnet', { apply: true })).toMatchObject({
      scanned: 1,
      rotated: 0,
      skipped: 1,
    })
    expect(
      (await db.query('SELECT sealed_private_key FROM perpl_connections WHERE id=$1', [a])).rows[0].sealed_private_key,
    ).toBeNull()
  } finally {
    await db.close()
  }
}, 20000)

it('failed rewrap leaves every original field untouched and never attempts a development-envelope fallback', async () => {
  const { db, store } = await databaseFixture()
  try {
    const user = await store.ensureUser('0x0000000000000000000000000000000000000001')
    const id = randomUUID()
    await db.query(
      "INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,sealed_private_key,sealed_api_token) VALUES($1,$2,'mainnet','trade','a','ACTIVE','kms-v1:private','kms-v1:token')",
      [id, user],
    )
    const rotate = vi
      .fn()
      .mockResolvedValueOnce('kms-v1:new-private')
      .mockRejectedValueOnce(new Error('CREDENTIAL_ROTATION_FAILED'))
    await expect(rotateCredentialBatch(store, { rotate }, 'mainnet', { apply: true })).rejects.toThrow(
      'CREDENTIAL_ROTATION_FAILED',
    )
    expect(
      (await db.query('SELECT sealed_private_key FROM perpl_connections WHERE id=$1', [id])).rows[0].sealed_private_key,
    ).toBe('kms-v1:private')
    await db.query("UPDATE perpl_connections SET sealed_private_key='v2:legacy' WHERE id=$1", [id])
    rotate.mockClear()
    await expect(rotateCredentialBatch(store, { rotate }, 'mainnet', { apply: true })).rejects.toThrow(
      'LEGACY_CREDENTIAL_REENROLLMENT_REQUIRED',
    )
    expect(rotate).not.toHaveBeenCalled()
  } finally {
    await db.close()
  }
}, 20000)
