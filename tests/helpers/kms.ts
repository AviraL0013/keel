import { randomBytes } from 'node:crypto'
import { DecryptCommand, GenerateDataKeyCommand, ReEncryptCommand, type KMSClient } from '@aws-sdk/client-kms'
import { vi } from 'vitest'

export const fixtureKmsKeyArn = 'arn:aws:kms:ap-southeast-1:111122223333:key/00000000-0000-4000-8000-000000000001'
export const fixtureNextKmsKeyArn = 'arn:aws:kms:ap-southeast-1:111122223333:key/00000000-0000-4000-8000-000000000002'

/** In-memory SDK transport only. No endpoint, AWS credentials, HTTP or persistent key material. */
export function fakeKms() {
  const wrapped = new Map<string, { key: Buffer; arn: string; context: string }>()
  const returnedKeys: Uint8Array[] = []
  const context = (value: Record<string, string> | undefined) =>
    JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)))
  const send = vi.fn(async (command: GenerateDataKeyCommand | DecryptCommand | ReEncryptCommand) => {
    if (command instanceof GenerateDataKeyCommand) {
      const key = randomBytes(32)
      const blob = randomBytes(48)
      wrapped.set(blob.toString('hex'), {
        key: Buffer.from(key),
        arn: command.input.KeyId!,
        context: context(command.input.EncryptionContext),
      })
      returnedKeys.push(key)
      return { KeyId: command.input.KeyId, Plaintext: key, CiphertextBlob: blob }
    }
    if (!(command instanceof DecryptCommand) && !(command instanceof ReEncryptCommand))
      throw new Error('FAKE_KMS_UNSUPPORTED_COMMAND')
    const record = wrapped.get(Buffer.from(command.input.CiphertextBlob!).toString('hex'))
    const expectedArn = command instanceof DecryptCommand ? command.input.KeyId : command.input.SourceKeyId
    const expectedContext =
      command instanceof DecryptCommand ? command.input.EncryptionContext : command.input.SourceEncryptionContext
    if (!record || record.arn !== expectedArn || record.context !== context(expectedContext))
      throw Object.assign(new Error('FAKE_KMS_CONTEXT_MISMATCH'), { name: 'InvalidCiphertextException' })
    if (command instanceof ReEncryptCommand) {
      const blob = randomBytes(48)
      wrapped.set(blob.toString('hex'), {
        key: Buffer.from(record.key),
        arn: command.input.DestinationKeyId!,
        context: context(command.input.DestinationEncryptionContext),
      })
      return {
        SourceKeyId: record.arn,
        KeyId: command.input.DestinationKeyId,
        CiphertextBlob: blob,
        $metadata: { requestId: 'fake-rewrap' },
      }
    }
    const key = Buffer.from(record.key)
    returnedKeys.push(key)
    return { KeyId: record.arn, Plaintext: key, $metadata: { requestId: 'fake-decrypt' } }
  })
  return {
    send,
    client: { send } as unknown as Pick<KMSClient, 'send'>,
    returnedKeys,
    clear() {
      for (const record of wrapped.values()) record.key.fill(0)
      for (const key of returnedKeys) key.fill(0)
      wrapped.clear()
    },
  }
}
