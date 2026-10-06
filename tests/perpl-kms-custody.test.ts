import { fakeKms } from './helpers/kms.js'
import { describe, expect, it } from 'vitest'
import { GenerateDataKeyCommand, ReEncryptCommand, type KMSClient } from '@aws-sdk/client-kms'
import { AwsKmsKeyCustody, type CustodyAuditEvent } from '../server/src/infrastructure/perpl/kms-key-custody.js'

const oldArn = 'arn:aws:kms:ap-southeast-1:111122223333:key/00000000-0000-4000-8000-000000000001'
const nextArn = 'arn:aws:kms:ap-southeast-1:111122223333:key/00000000-0000-4000-8000-000000000002'
const context = { userId: 'user-a', credentialId: 'connection-a:private_key' }

function fixture() {
  const { send, returnedKeys } = fakeKms()
  const events: CustodyAuditEvent[] = []
  const custody = (arn = oldArn, previous: string[] = []) =>
    new AwsKmsKeyCustody({
      keyArn: arn,
      decryptKeyArns: previous,
      environment: 'mainnet',
      audit: (event) => {
        events.push(event)
      },
      client: { send } as unknown as KMSClient,
    })
  return { custody, send, returnedKeys, events }
}

describe('AWS KMS envelope custody', () => {
  it('generates a separate AES-256 data key for each credential and wipes returned plaintext keys', async () => {
    const f = fixture(),
      custody = f.custody()
    const first = await custody.seal('synthetic-token', context)
    const second = await custody.seal('synthetic-token', { ...context, credentialId: 'connection-a:api_token' })
    expect(first).not.toBe(second)
    expect(first).not.toContain('synthetic-token')
    const generate = f.send.mock.calls.filter(([c]) => c instanceof GenerateDataKeyCommand)
    expect(generate).toHaveLength(2)
    expect(generate[0][0].input).toEqual({
      KeyId: oldArn,
      KeySpec: 'AES_256',
      EncryptionContext: {
        application: 'eyeler',
        environment: 'mainnet',
        userId: 'user-a',
        credentialId: 'connection-a:private_key',
        version: '1',
      },
    })
    expect(await custody.open(first, context)).toBe('synthetic-token')
    expect(f.returnedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true)
    expect(f.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'decrypt',
          status: 'attempt',
          userId: 'user-a',
          credentialId: context.credentialId,
        }),
        expect.objectContaining({ operation: 'decrypt', status: 'success', requestId: 'fake-decrypt' }),
      ]),
    )
    expect(JSON.stringify(f.events)).not.toContain('synthetic-token')
    expect(JSON.stringify(f.events)).not.toContain(first)
  })
  it('fails closed for another user, credential, environment, malformed envelope or altered ciphertext', async () => {
    const f = fixture(),
      custody = f.custody()
    const sealed = await custody.seal('synthetic-token', context)
    for (const other of [
      { ...context, userId: 'user-b' },
      { ...context, credentialId: 'connection-a:api_token' },
    ])
      await expect(custody.open(sealed, other)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    const differentEnvironment = new AwsKmsKeyCustody({
      keyArn: oldArn,
      environment: 'testnet',
      audit: (event) => {
        f.events.push(event)
      },
      client: { send: f.send } as unknown as KMSClient,
    })
    await expect(differentEnvironment.open(sealed, context)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    const data = JSON.parse(Buffer.from(sealed.slice('kms-v1:'.length), 'base64url').toString())
    const bytes = Buffer.from(data.ciphertext, 'base64url')
    bytes[0] ^= 1
    data.ciphertext = bytes.toString('base64url')
    await expect(
      custody.open(`kms-v1:${Buffer.from(JSON.stringify(data)).toString('base64url')}`, context),
    ).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    for (const invalid of ['v2:legacy:data:body', 'kms-v1:not-json', sealed + '!'])
      await expect(custody.open(invalid, context)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    await expect(custody.seal('synthetic-token', 'legacy-context')).rejects.toThrow('INVALID_CREDENTIAL_CONTEXT')
    expect(f.returnedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true)
  })
  it('supports replacement keys and rewraps without exposing credential plaintext', async () => {
    const f = fixture(),
      old = f.custody(),
      next = f.custody(nextArn, [oldArn])
    const sealed = await old.seal('synthetic-token', context)
    expect(await next.open(sealed, context)).toBe('synthetic-token')
    f.send.mockClear()
    const rotated = await next.rotate(sealed, context)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0][0]).toBeInstanceOf(ReEncryptCommand)
    expect(await f.custody(nextArn).open(rotated, context)).toBe('synthetic-token')
    const count = f.send.mock.calls.length
    await expect(f.custody(nextArn).open(sealed, context)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    expect(f.send).toHaveBeenCalledTimes(count)
    expect(await next.seal('new-token', context)).not.toBe(sealed)
  })
  it('records denied decrypts without raw AWS errors, never retries and fails startup when KMS denies access', async () => {
    const f = fixture(),
      custody = f.custody()
    const sealed = await custody.seal('synthetic-token', context)
    f.send.mockClear()
    f.send.mockRejectedValue(
      Object.assign(new Error('secret-provider-detail'), {
        name: 'AccessDeniedException',
        $metadata: { httpStatusCode: 403 },
      }),
    )
    await expect(custody.open(sealed, context)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.events.at(-1)).toMatchObject({ operation: 'decrypt', status: 'failure', reason: 'ACCESS_DENIED' })
    expect(JSON.stringify(f.events)).not.toContain('secret-provider-detail')
    await expect(custody.assertReady()).rejects.toThrow('KMS_CUSTODY_UNAVAILABLE')
  })
  it('requires audit delivery before releasing plaintext and checks KMS access at startup', async () => {
    const f = fixture(),
      custody = f.custody()
    await expect(custody.assertReady()).resolves.toBeUndefined()
    const sealed = await custody.seal('synthetic-token', context)
    const unaudited = new AwsKmsKeyCustody({
      keyArn: oldArn,
      environment: 'mainnet',
      client: { send: f.send } as unknown as KMSClient,
      audit: (event) => {
        if (event.status === 'success') throw new Error('audit unavailable')
      },
    })
    await expect(unaudited.open(sealed, context)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    expect(f.returnedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true)
  })
})
