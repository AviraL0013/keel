import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type CredentialContext = { userId: string; credentialId: string }
export const credentialContext = (
  userId: string,
  connectionId: string,
  field: 'private_key' | 'mac' | 'api_token',
): CredentialContext => ({ userId, credentialId: `${connectionId}:${field}` })

export interface KeyCustody {
  seal(value: string, context: CredentialContext | string): string | Promise<string>
  open(sealed: string, context: CredentialContext | string): string | Promise<string>
  assertReady?(): Promise<void>
  close?(): void
  shred(): null
}

/** Local and isolated test use only. Production factories reject this provider. */
export class DevelopmentKeyCustody implements KeyCustody {
  private readonly key: Buffer
  constructor(hexKey: string) {
    if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error('INVALID_EYELER_KEY_ENCRYPTION_KEY')
    this.key = Buffer.from(hexKey.replace(/^0x/, ''), 'hex')
  }
  seal(value: string, context: CredentialContext | string): string {
    const aad = typeof context === 'string' ? context : JSON.stringify([context.userId, context.credentialId])
    if (!aad) throw new Error('INVALID_CREDENTIAL_CONTEXT')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `${typeof context === 'string' ? 'v2' : 'dev-v3'}:${nonce.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${body.toString('base64url')}`
  }
  open(sealed: string, context: CredentialContext | string): string {
    try {
      const [version, nonce, tag, body, extra] = sealed.split(':')
      if (
        !['v2', 'dev-v3'].includes(version) ||
        !context ||
        !nonce ||
        !tag ||
        body === undefined ||
        extra !== undefined
      )
        throw new Error('INVALID_SEALED_CREDENTIAL')
      const nonceBytes = Buffer.from(nonce, 'base64url')
      const tagBytes = Buffer.from(tag, 'base64url')
      if (nonceBytes.length !== 12 || tagBytes.length !== 16) throw new Error('INVALID_SEALED_CREDENTIAL')
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonceBytes, { authTagLength: 16 })
      const aad =
        typeof context === 'string'
          ? context
          : version === 'v2'
            ? context.credentialId
            : JSON.stringify([context.userId, context.credentialId])
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(tagBytes)
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('INVALID_SEALED_CREDENTIAL')
    }
  }
  close() {
    this.key.fill(0)
  }
  shred(): null {
    return null
  }
}
