import { createHash, randomBytes } from 'node:crypto'
import { signAsync } from '@noble/ed25519'
import type { ApiKeySigner } from './index.js'

export class Ed25519PerplSigner implements ApiKeySigner {
  private readonly privateKey: Uint8Array
  constructor(public readonly apiKey: string, secretHex: string, private readonly chainId = 143) {
    const normalized = secretHex.replace(/^0x/, '')
    if (!/^[0-9a-f]{64}$/i.test(normalized)) throw new Error('PERPL_API_KEY_SECRET_INVALID')
    this.privateKey = Uint8Array.from(Buffer.from(normalized, 'hex'))
  }
  async sign(method: string, path: string, body: string, timestamp: string, nonce: string) {
    const bodyHash = createHash('sha256').update(body).digest('hex')
    const canonical = [this.chainId, method, path, timestamp, nonce, bodyHash].join('\n')
    const signature = await signAsync(Buffer.from(canonical), this.privateKey)
    return Buffer.from(signature).toString('base64url')
  }
  async signWebSocket(timestamp: string, nonce: string) {
    const canonical = [this.chainId, 'trading-ws-signin', timestamp, nonce].join('\n')
    const signature = await signAsync(Buffer.from(canonical), this.privateKey)
    return Buffer.from(signature).toString('base64url')
  }
}
export function createPerplSignerFromEnv(env: Record<string, string | undefined> = process.env) {
  if (!env.PERPL_API_KEY || !env.PERPL_API_KEY_SECRET) throw new Error('PERPL_SIGNER_NOT_CONFIGURED')
  return new Ed25519PerplSigner(env.PERPL_API_KEY, env.PERPL_API_KEY_SECRET, Number(env.PERPL_CHAIN_ID ?? 143))
}
export function createNonce() { return randomBytes(16).toString('base64url') }
