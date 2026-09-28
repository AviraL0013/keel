import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface KeyCustody {
  seal(value: string, context: string): string
  open(sealed: string, context: string): string
  shred(): null
}

/** Development-only envelope encryption. A production KMS is still required. */
export class DevelopmentKeyCustody implements KeyCustody {
  private readonly key: Buffer
  constructor(hexKey: string) {
    if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error('INVALID_EYELER_KEY_ENCRYPTION_KEY')
    this.key = Buffer.from(hexKey.replace(/^0x/, ''), 'hex')
  }
  seal(value: string, context: string): string {
    if (!context) throw new Error('INVALID_CREDENTIAL_CONTEXT')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(context, 'utf8'))
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v2:${nonce.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${body.toString('base64url')}`
  }
  open(sealed: string, context: string): string {
    try {
      const [version, nonce, tag, body, extra] = sealed.split(':')
      if (version !== 'v2' || !context || !nonce || !tag || body === undefined || extra !== undefined)
        throw new Error('INVALID_SEALED_CREDENTIAL')
      const nonceBytes = Buffer.from(nonce, 'base64url')
      const tagBytes = Buffer.from(tag, 'base64url')
      if (nonceBytes.length !== 12 || tagBytes.length !== 16) throw new Error('INVALID_SEALED_CREDENTIAL')
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonceBytes, { authTagLength: 16 })
      decipher.setAAD(Buffer.from(context, 'utf8'))
      decipher.setAuthTag(tagBytes)
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('INVALID_SEALED_CREDENTIAL')
    }
  }
  shred(): null {
    return null
  }
}
