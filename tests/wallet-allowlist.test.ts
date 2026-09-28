import { afterEach, describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { loadConfig } from '../packages/shared/src/index.js'

const walletA = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const walletB = privateKeyToAccount('0x1123456789012345678901234567890123456789012345678901234567890123')
const keys = ['EYELER_ENV', 'EYELER_ALLOWED_WALLETS', 'MONAD_WALLET_ADDRESS', 'CORS_ORIGIN', 'DATABASE_URL', 'SESSION_SECRET', 'PERPL_REST_URL', 'PERPL_WS_URL', 'PERPL_CHAIN_ID', 'PERPL_API_KEY', 'PERPL_API_KEY_SECRET', 'PERPL_ACCOUNT_ID'] as const
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
afterEach(() => { for (const key of keys) { const value = original[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value } })

async function signIn(app: ReturnType<typeof createServer>, wallet: typeof walletA) {
  const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: wallet.address } })
  if (challenge.statusCode !== 200) return { challenge }
  const body = challenge.json() as { message: string; nonce: string }
  const signature = await wallet.signMessage({ message: body.message })
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: wallet.address, nonce: body.nonce, message: body.message, signature } })
  return { challenge, verify }
}

describe('configured wallet access', () => {
  it('allows only listed wallet in test mode', async () => {
    process.env.EYELER_ENV = 'test'; process.env.EYELER_ALLOWED_WALLETS = walletA.address; delete process.env.MONAD_WALLET_ADDRESS
    const app = createServer(new MemoryStore())
    try {
      const a = await signIn(app, walletA)
      expect(a.verify?.statusCode).toBe(200)
      const books = await app.inject({ method: 'GET', url: '/books', headers: { authorization: `Bearer ${a.verify!.json().token}` } })
      expect(books.statusCode).toBe(200)
      const b = await signIn(app, walletB)
      expect(b.challenge.statusCode).toBe(403)
      expect(b.challenge.json()).toEqual({ error: 'WALLET_NOT_ALLOWED' })
    } finally { await app.close() }
  })

  it('fails closed in development without an allowlist or fallback', async () => {
    process.env.EYELER_ENV = 'development'; delete process.env.EYELER_ALLOWED_WALLETS; delete process.env.MONAD_WALLET_ADDRESS
    const app = createServer(new MemoryStore())
    try { const result = await signIn(app, walletA); expect(result.challenge.statusCode).toBe(403); expect(result.challenge.json()).toEqual({ error: 'WALLET_ALLOWLIST_NOT_CONFIGURED' }) } finally { await app.close() }
  })

  it('uses MONAD_WALLET_ADDRESS when allowlist is empty', async () => {
    process.env.EYELER_ENV = 'development'; process.env.EYELER_ALLOWED_WALLETS = ''; process.env.MONAD_WALLET_ADDRESS = walletA.address
    const app = createServer(new MemoryStore())
    try { expect((await signIn(app, walletA)).verify?.statusCode).toBe(200); const b = await signIn(app, walletB); expect(b.challenge.statusCode).toBe(403) } finally { await app.close() }
  })

  it('permits test wallets only when no allowlist exists', async () => {
    process.env.EYELER_ENV = 'test'; delete process.env.EYELER_ALLOWED_WALLETS; delete process.env.MONAD_WALLET_ADDRESS
    const app = createServer(new MemoryStore())
    try { expect((await signIn(app, walletA)).verify?.statusCode).toBe(200); expect((await signIn(app, walletB)).verify?.statusCode).toBe(200) } finally { await app.close() }
  })

  it('invalidates an existing session on a server with a different allowlist', async () => {
    process.env.EYELER_ENV = 'test'; process.env.EYELER_ALLOWED_WALLETS = walletA.address
    const store = new MemoryStore(); const appA = createServer(store)
    process.env.EYELER_ALLOWED_WALLETS = walletB.address
    const appB = createServer(store)
    try {
      const a = await signIn(appA, walletA); const authorization = `Bearer ${a.verify!.json().token}`
      expect((await appB.inject({ method: 'GET', url: '/books', headers: { authorization } })).statusCode).toBe(401)
      expect((await appB.inject({ method: 'GET', url: '/auth/session', headers: { authorization } })).statusCode).toBe(401)
    } finally { await appA.close(); await appB.close() }
  })

  it('rejects verification after the wallet is removed without creating a session', async () => {
    process.env.EYELER_ENV = 'test'; process.env.EYELER_ALLOWED_WALLETS = walletA.address
    class CountingStore extends MemoryStore { created = 0; override async createSession(token: string, session: Parameters<MemoryStore['createSession']>[1]) { this.created++; return super.createSession(token, session) } }
    const store = new CountingStore(); const appA = createServer(store)
    process.env.EYELER_ALLOWED_WALLETS = walletB.address; const appB = createServer(store)
    try {
      const challenge = await appA.inject({ method: 'POST', url: '/auth/challenge', payload: { address: walletA.address } })
      const body = challenge.json() as { message: string; nonce: string }
      const signature = await walletA.signMessage({ message: body.message })
      const verify = await appB.inject({ method: 'POST', url: '/auth/verify', payload: { address: walletA.address, nonce: body.nonce, message: body.message, signature } })
      expect(verify.statusCode).toBe(403); expect(verify.json()).toEqual({ error: 'WALLET_NOT_ALLOWED' }); expect(store.created).toBe(0)
    } finally { await appA.close(); await appB.close() }
  })

  it('rejects malformed allowlist entries at startup', () => {
    process.env.EYELER_ENV = 'test'; process.env.EYELER_ALLOWED_WALLETS = '0x123'
    expect(() => createServer(new MemoryStore())).toThrow('INVALID_EYELER_ALLOWED_WALLETS')
  })

  it('normalizes, deduplicates, and validates fallback wallets', () => {
    expect(loadConfig({ EYELER_ALLOWED_WALLETS: ` ${walletA.address.toUpperCase().replace('0X', '0x')} , ${walletA.address} ` }).allowedWallets).toEqual([walletA.address.toLowerCase()])
    expect(() => loadConfig({ EYELER_ALLOWED_WALLETS: '', MONAD_WALLET_ADDRESS: '0x123' })).toThrow('INVALID_MONAD_WALLET_ADDRESS')
  })

  it('restricts testnet CORS preflights to configured origins', async () => {
    process.env.EYELER_ENV = 'testnet'; process.env.CORS_ORIGIN = 'https://demo.example'; process.env.EYELER_ALLOWED_WALLETS = walletA.address
    process.env.DATABASE_URL = 'postgres://localhost/unused'; process.env.SESSION_SECRET = 'test-secret-not-for-production'
    for (const key of ['PERPL_REST_URL', 'PERPL_WS_URL', 'PERPL_CHAIN_ID', 'PERPL_API_KEY', 'PERPL_API_KEY_SECRET', 'PERPL_ACCOUNT_ID']) delete process.env[key]
    const app = createServer(new MemoryStore())
    try {
      const preflight = (origin: string) => app.inject({ method: 'OPTIONS', url: '/auth/challenge', headers: { origin, 'access-control-request-method': 'POST' } })
      expect((await preflight('https://demo.example')).headers['access-control-allow-origin']).toBe('https://demo.example')
      expect((await preflight('https://evil.example')).headers['access-control-allow-origin']).toBeUndefined()
    } finally { await app.close() }
  })
})
