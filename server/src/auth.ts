import { createHmac, randomBytes } from 'node:crypto'
import { verifyMessage, isAddress } from 'viem'
import type { Store } from './infrastructure/database/postgres-store.js'
export type Session = { userId: string; walletAddress: string; expiresAt: number }
export class AuthService {
  constructor(private readonly store: Store, private readonly secret: string) {}
  async challenge(address: string) { const nonce = randomBytes(24).toString('base64url'); const expiresAt = Date.now() + 5 * 60_000; const message = `Keel wants to verify wallet ownership.\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}`; await this.store.createChallenge(address, nonce, expiresAt, message); return { message, nonce, expiresAt } }
  async verify(address: string, nonce: string, message: string, signature: `0x${string}`) { if (!isAddress(address)) throw new Error('INVALID_WALLET_ADDRESS'); if (!message.startsWith(`Keel wants to verify wallet ownership.\nNonce: ${nonce}\nExpires: `)) throw new Error('AUTH_MESSAGE_INVALID'); if (!await this.store.consumeChallenge(address, nonce, message)) throw new Error('AUTH_CHALLENGE_INVALID'); if (!await verifyMessage({ address: address as `0x${string}`, message, signature })) throw new Error('AUTH_SIGNATURE_INVALID'); const userId = await this.store.ensureUser(address); const token = createHmac('sha256', this.secret).update(`${userId}:${Date.now()}:${randomBytes(16).toString('hex')}`).digest('hex'); const session = { userId, walletAddress: address.toLowerCase(), expiresAt: Date.now() + 7 * 24 * 60 * 60_000 }; await this.store.createSession(token, session); return { token, session } }
  async get(token?: string) { return token ? this.store.getSession(token) : null }
  async revoke(token?: string) { if (token) await this.store.revokeSession(token) }
}


