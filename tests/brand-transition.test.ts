import { afterEach, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { AuthService } from '../server/src/auth.js'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { brandEnv, loadConfig } from '../packages/shared/src/index.js'
import { loadEnrollmentConfig } from '../server/src/infrastructure/perpl/enrollment-service.js'
import { createTelegramNotifier } from '../server/src/infrastructure/telegram/notifier.js'

const wallet = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const previous = { EYELER_ENV: process.env.EYELER_ENV, KEEL_ENV: process.env.KEEL_ENV, EYELER_ALLOWED_WALLETS: process.env.EYELER_ALLOWED_WALLETS, KEEL_ALLOWED_WALLETS: process.env.KEEL_ALLOWED_WALLETS }
afterEach(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })

it('accepts legacy settings and rejects conflicting brand configuration', () => {
  expect(loadConfig({ KEEL_ENV: 'test', KEEL_ALLOWED_WALLETS: wallet.address }).allowedWallets).toEqual([wallet.address.toLowerCase()])
  expect(brandEnv({ KEEL_APP_URL: 'https://old.example' }, 'APP_URL')).toBe('https://old.example')
  expect(() => loadConfig({ EYELER_ENV: 'testnet', KEEL_ENV: 'mainnet' })).toThrow('CONFLICTING_EYELER_ENV')
  const enrollment = loadEnrollmentConfig({ PERPL_ENROLLMENT_ORIGIN: 'https://old.example', KEEL_KEY_TTL_DAYS: '45' }, loadConfig({ KEEL_ENV: 'testnet' }))
  expect(enrollment.ttlDays).toBe(45)
  expect(createTelegramNotifier({} as never, { TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: 'chat', KEEL_APP_URL: 'https://old.example' })).toBeDefined()
})

it('signs new Eyeler challenges and verifies an unexpired stored Keel challenge', async () => {
  const store = new MemoryStore()
  const auth = new AuthService(store, 'brand-test-secret')
  expect((await auth.challenge(wallet.address)).message).toContain('Eyeler wants to verify wallet ownership.')
  const nonce = 'pending-old-challenge'
  const expiresAt = Date.now() + 60_000
  const message = `Keel wants to verify wallet ownership.\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}`
  await store.createChallenge(wallet.address, nonce, expiresAt, message)
  const signature = await wallet.signMessage({ message })
  expect((await auth.verify(wallet.address, nonce, message, signature)).session.walletAddress).toBe(wallet.address.toLowerCase())
})

it('accepts an old session cookie and clears it on logout', async () => {
  process.env.EYELER_ENV = 'test'; delete process.env.KEEL_ENV
  process.env.EYELER_ALLOWED_WALLETS = wallet.address; delete process.env.KEEL_ALLOWED_WALLETS
  const app = createServer(new MemoryStore())
  try {
    const challenge = (await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: wallet.address } })).json()
    const signature = await wallet.signMessage({ message: challenge.message })
    const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: wallet.address, nonce: challenge.nonce, message: challenge.message, signature } })
    const token = verified.json().token as string
    expect(verified.headers['set-cookie']).toContain('eyeler_session=')
    const cookie = `keel_session=${token}`
    expect((await app.inject({ method: 'GET', url: '/books', headers: { cookie } })).statusCode).toBe(200)
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })
    expect(logout.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('keel_session=')]))
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } })).statusCode).toBe(401)
  } finally { await app.close() }
})
