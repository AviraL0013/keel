import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { DecryptCommand, GenerateDataKeyCommand, KMSClient, ReEncryptCommand } from '@aws-sdk/client-kms'
import { kmsKeyRegion } from '../../../../packages/shared/src/key-custody-config.js'
import type { CredentialContext, KeyCustody } from './key-custody.js'

export type CustodyAuditEvent = {
  event: 'credential_custody'
  operation: 'decrypt' | 'rewrap'
  status: 'attempt' | 'success' | 'failure'
  environment: string
  userId?: string
  credentialId?: string
  keyArn?: string
  requestId?: string
  reason?: string
}
type Envelope = { keyArn: string; wrappedKey: string; nonce: string; tag: string; ciphertext: string }
type Options = {
  keyArn: string
  decryptKeyArns?: string[]
  environment: 'development' | 'test' | 'testnet' | 'mainnet'
  audit: (event: CustodyAuditEvent) => void | Promise<void>
  client?: Pick<KMSClient, 'send'> & { destroy?: () => void }
}

function bytes(value: unknown, max: number, exact?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('INVALID_ENVELOPE')
  const decoded = Buffer.from(value, 'base64url')
  if (
    decoded.toString('base64url') !== value ||
    decoded.length > max ||
    (exact !== undefined && decoded.length !== exact)
  )
    throw new Error('INVALID_ENVELOPE')
  return decoded
}
function validateContext(context: CredentialContext | string): CredentialContext {
  if (
    !context ||
    typeof context !== 'object' ||
    typeof context.userId !== 'string' ||
    typeof context.credentialId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(context.userId) ||
    !/^[A-Za-z0-9_:-]{1,200}$/.test(context.credentialId)
  )
    throw new Error('INVALID_CREDENTIAL_CONTEXT')
  return context
}
function reason(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (
    ['AccessDeniedException', 'UnrecognizedClientException', 'ExpiredTokenException', 'InvalidClientTokenId'].includes(
      name,
    )
  )
    return 'ACCESS_DENIED'
  if (name === 'InvalidCiphertextException' || name === 'IncorrectKeyException') return 'CONTEXT_OR_KEY_MISMATCH'
  if (name === 'AbortError' || name === 'TimeoutError') return 'TIMEOUT'
  return 'CUSTODY_FAILED'
}

/** One KMS-generated data key per envelope; no plaintext data-key cache. */
export class AwsKmsKeyCustody implements KeyCustody {
  private readonly client: Pick<KMSClient, 'send'> & { destroy?: () => void }
  private readonly allowed: Set<string>
  constructor(private readonly options: Options) {
    const region = kmsKeyRegion(options.keyArn)
    if (
      !region ||
      (options.decryptKeyArns ?? []).some((arn) => kmsKeyRegion(arn) !== region) ||
      typeof options.audit !== 'function'
    )
      throw new Error('INVALID_KMS_CUSTODY_CONFIGURATION')
    this.allowed = new Set([options.keyArn, ...(options.decryptKeyArns ?? [])])
    this.client =
      options.client ??
      new KMSClient({
        region,
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
        requestHandler: { connectionTimeout: 3000, requestTimeout: 8000 },
      })
  }
  private encryptionContext(context: CredentialContext | string) {
    const valid = validateContext(context)
    return {
      application: 'eyeler',
      environment: this.options.environment,
      userId: valid.userId,
      credentialId: valid.credentialId,
      version: '1',
    }
  }
  private envelope(sealed: string): Envelope {
    if (!sealed.startsWith('kms-v1:') || sealed.length > 40_000) throw new Error('INVALID_ENVELOPE')
    const data = JSON.parse(bytes(sealed.slice(7), 30_000).toString('utf8')) as Envelope
    if (
      !data ||
      Object.keys(data).sort().join(',') !== 'ciphertext,keyArn,nonce,tag,wrappedKey' ||
      !this.allowed.has(data.keyArn)
    )
      throw new Error('INVALID_ENVELOPE')
    if (!bytes(data.wrappedKey, 6144).length) throw new Error('INVALID_ENVELOPE')
    bytes(data.nonce, 12, 12)
    bytes(data.tag, 16, 16)
    bytes(data.ciphertext, 16_384)
    return data
  }
  private encode(data: Envelope) {
    return `kms-v1:${Buffer.from(JSON.stringify(data)).toString('base64url')}`
  }
  private async audit(
    operation: CustodyAuditEvent['operation'],
    status: CustodyAuditEvent['status'],
    context: CredentialContext | string,
    keyArn?: string,
    requestId?: string,
    failure?: string,
  ) {
    let valid: CredentialContext | undefined
    try {
      valid = validateContext(context)
    } catch {
      /* Invalid caller input is never copied to logs. */
    }
    await this.options.audit({
      event: 'credential_custody',
      operation,
      status,
      environment: this.options.environment,
      ...(valid ? { userId: valid.userId, credentialId: valid.credentialId } : {}),
      ...(keyArn && this.allowed.has(keyArn) ? { keyArn } : {}),
      ...(requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? { requestId } : {}),
      ...(failure ? { reason: failure } : {}),
    })
  }
  async seal(value: string, context: CredentialContext | string): Promise<string> {
    const encryptionContext = this.encryptionContext(context)
    if (Buffer.byteLength(value, 'utf8') > 16_384) throw new Error('CREDENTIAL_ENCRYPT_FAILED')
    let key: Uint8Array | undefined
    try {
      const generated = await this.client.send(
        new GenerateDataKeyCommand({
          KeyId: this.options.keyArn,
          KeySpec: 'AES_256',
          EncryptionContext: encryptionContext,
        }),
        { abortSignal: AbortSignal.timeout(8000) },
      )
      key = generated.Plaintext
      if (
        generated.KeyId !== this.options.keyArn ||
        key?.length !== 32 ||
        !generated.CiphertextBlob?.length ||
        generated.CiphertextBlob.length > 6144
      )
        throw new Error()
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(Buffer.from(JSON.stringify(encryptionContext)))
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return this.encode({
        keyArn: generated.KeyId,
        wrappedKey: Buffer.from(generated.CiphertextBlob).toString('base64url'),
        nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      })
    } catch {
      throw new Error('CREDENTIAL_ENCRYPT_FAILED')
    } finally {
      key?.fill(0)
    }
  }
  async open(sealed: string, context: CredentialContext | string): Promise<string> {
    let key: Uint8Array | undefined
    let plaintext: Buffer | undefined
    let partial: Buffer | undefined
    let keyArn: string | undefined
    try {
      await this.audit('decrypt', 'attempt', context)
      const encryptionContext = this.encryptionContext(context)
      const envelope = this.envelope(sealed)
      keyArn = envelope.keyArn
      const result = await this.client.send(
        new DecryptCommand({
          KeyId: keyArn,
          CiphertextBlob: bytes(envelope.wrappedKey, 6144),
          EncryptionContext: encryptionContext,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        }),
        { abortSignal: AbortSignal.timeout(8000) },
      )
      key = result.Plaintext
      if (result.KeyId !== keyArn || key?.length !== 32) throw new Error()
      const decipher = createDecipheriv('aes-256-gcm', key, bytes(envelope.nonce, 12, 12), { authTagLength: 16 })
      decipher.setAAD(Buffer.from(JSON.stringify(encryptionContext)))
      decipher.setAuthTag(bytes(envelope.tag, 16, 16))
      partial = decipher.update(bytes(envelope.ciphertext, 16_384))
      plaintext = Buffer.concat([partial, decipher.final()])
      await this.audit('decrypt', 'success', context, keyArn, result.$metadata?.requestId)
      return plaintext.toString('utf8')
    } catch (error) {
      try {
        await this.audit('decrypt', 'failure', context, keyArn, undefined, reason(error))
      } catch {
        /* No plaintext is released if audit delivery fails. */
      }
      throw new Error('CREDENTIAL_DECRYPT_FAILED')
    } finally {
      key?.fill(0)
      partial?.fill(0)
      plaintext?.fill(0)
    }
  }
  /** Rewrap only the encrypted data key. Credential bytes never enter KMS or local plaintext. */
  async rotate(sealed: string, context: CredentialContext | string): Promise<string> {
    let keyArn: string | undefined
    try {
      await this.audit('rewrap', 'attempt', context)
      const encryptionContext = this.encryptionContext(context)
      const envelope = this.envelope(sealed)
      keyArn = envelope.keyArn
      const result = await this.client.send(
        new ReEncryptCommand({
          SourceKeyId: keyArn,
          DestinationKeyId: this.options.keyArn,
          CiphertextBlob: bytes(envelope.wrappedKey, 6144),
          SourceEncryptionContext: encryptionContext,
          DestinationEncryptionContext: encryptionContext,
        }),
        { abortSignal: AbortSignal.timeout(8000) },
      )
      if (
        result.SourceKeyId !== keyArn ||
        result.KeyId !== this.options.keyArn ||
        !result.CiphertextBlob?.length ||
        result.CiphertextBlob.length > 6144
      )
        throw new Error()
      await this.audit('rewrap', 'success', context, keyArn, result.$metadata?.requestId)
      return this.encode({
        ...envelope,
        keyArn: result.KeyId,
        wrappedKey: Buffer.from(result.CiphertextBlob).toString('base64url'),
      })
    } catch (error) {
      try {
        await this.audit('rewrap', 'failure', context, keyArn, undefined, reason(error))
      } catch {
        /* Fail closed. */
      }
      throw new Error('CREDENTIAL_ROTATION_FAILED')
    }
  }
  async assertReady(): Promise<void> {
    try {
      const context = { userId: 'startup-check', credentialId: `startup:${randomUUID()}` }
      const sealed = await this.seal('eyeler-custody-check', context)
      if ((await this.open(sealed, context)) !== 'eyeler-custody-check') throw new Error()
    } catch {
      throw new Error('KMS_CUSTODY_UNAVAILABLE')
    }
  }
  close() {
    this.client.destroy?.()
  }
  shred(): null {
    return null
  }
}
