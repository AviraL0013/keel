import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CredentialContext, KeyCustody } from './key-custody.js'

type Envelope = {
  version: string
  wrappedKey: string
  wrapNonce: string
  wrapTag: string
  nonce: string
  tag: string
  ciphertext: string
}

function contextBytes(context: CredentialContext | string, environment: 'testnet' | 'mainnet'): Buffer {
  if (
    !context ||
    typeof context === 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(context.userId) ||
    !/^[A-Za-z0-9_:-]{1,200}$/.test(context.credentialId)
  )
    throw new Error('INVALID_CREDENTIAL_CONTEXT')
  return Buffer.from(JSON.stringify(['eyeler', environment, context.userId, context.credentialId]))
}

function decode(value: string, length?: number): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length > 24000) throw new Error('INVALID_ENVELOPE')
  const result = Buffer.from(value, 'base64url')
  if (result.toString('base64url') !== value || (length !== undefined && result.length !== length))
    throw new Error('INVALID_ENVELOPE')
  return result
}

/** A random data key encrypts each credential; a versioned Railway secret wraps that key. */
export class RailwayEnvelopeKeyCustody implements KeyCustody {
  readonly envelopePrefix = 'rail-v1:'
  private readonly keys: Map<string, Buffer>
  constructor(
    keys: Record<string, string>,
    private readonly activeVersion: string,
    private readonly environment: 'testnet' | 'mainnet',
  ) {
    if (
      !Object.hasOwn(keys, activeVersion) ||
      Object.entries(keys).some(
        ([version, key]) => !/^[A-Za-z0-9_-]{1,32}$/.test(version) || !/^[0-9a-fA-F]{64}$/.test(key),
      )
    )
      throw new Error('INVALID_TESTNET_CUSTODY_CONFIGURATION')
    this.keys = new Map(Object.entries(keys).map(([version, key]) => [version, Buffer.from(key, 'hex')]))
  }

  private wrap(dataKey: Buffer, context: Buffer, version: string) {
    const wrappingKey = this.keys.get(version)
    if (!wrappingKey) throw new Error('CREDENTIAL_ENCRYPT_FAILED')
    const wrapNonce = randomBytes(12)
    const wrapper = createCipheriv('aes-256-gcm', wrappingKey, wrapNonce)
    wrapper.setAAD(Buffer.concat([context, Buffer.from(version)]))
    const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()])
    return {
      version,
      wrappedKey: wrappedKey.toString('base64url'),
      wrapNonce: wrapNonce.toString('base64url'),
      wrapTag: wrapper.getAuthTag().toString('base64url'),
    }
  }

  private parse(sealed: string): Envelope {
    if (!sealed.startsWith('rail-v1:') || sealed.length > 30000) throw new Error('INVALID_ENVELOPE')
    const data = JSON.parse(decode(sealed.slice(8)).toString()) as Envelope
    if (
      !data ||
      Object.keys(data).sort().join(',') !== 'ciphertext,nonce,tag,version,wrapNonce,wrapTag,wrappedKey' ||
      !this.keys.has(data.version)
    )
      throw new Error('INVALID_ENVELOPE')
    decode(data.wrappedKey, 32)
    decode(data.wrapNonce, 12)
    decode(data.wrapTag, 16)
    decode(data.nonce, 12)
    decode(data.tag, 16)
    decode(data.ciphertext)
    return data
  }

  private unwrap(data: Envelope, context: Buffer): Buffer {
    const wrapper = createDecipheriv('aes-256-gcm', this.keys.get(data.version)!, decode(data.wrapNonce, 12))
    wrapper.setAAD(Buffer.concat([context, Buffer.from(data.version)]))
    wrapper.setAuthTag(decode(data.wrapTag, 16))
    return Buffer.concat([wrapper.update(decode(data.wrappedKey, 32)), wrapper.final()])
  }

  async seal(value: string, binding: CredentialContext | string): Promise<string> {
    const context = contextBytes(binding, this.environment)
    if (Buffer.byteLength(value) > 16384) throw new Error('CREDENTIAL_ENCRYPT_FAILED')
    const dataKey = randomBytes(32)
    try {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce)
      cipher.setAAD(context)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      const envelope: Envelope = {
        ...this.wrap(dataKey, context, this.activeVersion),
        nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      }
      return `rail-v1:${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`
    } finally {
      dataKey.fill(0)
    }
  }

  async open(sealed: string, binding: CredentialContext | string): Promise<string> {
    let dataKey: Buffer | undefined
    try {
      const context = contextBytes(binding, this.environment)
      const data = this.parse(sealed)
      dataKey = this.unwrap(data, context)
      const cipher = createDecipheriv('aes-256-gcm', dataKey, decode(data.nonce, 12))
      cipher.setAAD(context)
      cipher.setAuthTag(decode(data.tag, 16))
      return Buffer.concat([cipher.update(decode(data.ciphertext)), cipher.final()]).toString('utf8')
    } catch {
      throw new Error('CREDENTIAL_DECRYPT_FAILED')
    } finally {
      dataKey?.fill(0)
    }
  }

  async rotate(sealed: string, binding: CredentialContext | string): Promise<string> {
    let dataKey: Buffer | undefined
    try {
      const context = contextBytes(binding, this.environment)
      const data = this.parse(sealed)
      dataKey = this.unwrap(data, context)
      const envelope = { ...data, ...this.wrap(dataKey, context, this.activeVersion) }
      return `rail-v1:${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`
    } catch {
      throw new Error('CREDENTIAL_ROTATION_FAILED')
    } finally {
      dataKey?.fill(0)
    }
  }

  async assertReady() {
    const binding = { userId: 'startup-check', credentialId: 'startup-check' }
    if ((await this.open(await this.seal('ok', binding), binding)) !== 'ok')
      throw new Error('RAILWAY_CUSTODY_UNAVAILABLE')
  }
  close() {
    for (const key of this.keys.values()) key.fill(0)
  }
  shred(): null {
    return null
  }
}

/** Existing testnet provider retains its testnet-bound encryption context. */
export class RailwayTestnetKeyCustody extends RailwayEnvelopeKeyCustody {
  constructor(keys: Record<string, string>, activeVersion: string) {
    super(keys, activeVersion, 'testnet')
  }
}
