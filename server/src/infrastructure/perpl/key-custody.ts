import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface KeyCustody {
  seal(value: string): string
  open(sealed: string): string
  shred(): null
}

/** Development-only envelope encryption. A production KMS is still required. */
export class DevelopmentKeyCustody implements KeyCustody {
  private readonly key: Buffer
  constructor(hexKey: string) {
    if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error('INVALID_KEEL_KEY_ENCRYPTION_KEY')
    this.key = Buffer.from(hexKey.replace(/^0x/, ''), 'hex')
  }
  seal(value: string): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v1:${nonce.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${body.toString('base64url')}`
  }
  open(sealed: string): string {
    try {
      const [version, nonce, tag, body, extra] = sealed.split(':')
      if (version !== 'v1' || !nonce || !tag || body === undefined || extra !== undefined) throw new Error('INVALID_SEALED_CREDENTIAL')
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
    } catch { throw new Error('INVALID_SEALED_CREDENTIAL') }
  }
  shred(): null { return null }
}
