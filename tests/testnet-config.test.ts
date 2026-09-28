import { describe, expect, it } from 'vitest'
import { assertProductionConfig, loadConfig } from '../packages/shared/src/index.js'

const wallet = `0x${'12'.repeat(20)}`
const valid = {
  EYELER_ENV: 'testnet',
  DATABASE_URL: 'postgres://localhost/eyeler',
  SESSION_SECRET: 'test-secret-not-for-production',
  EYELER_ALLOWED_WALLETS: wallet,
  CORS_ORIGIN: 'https://app.example',
}
const live = {
  PERPL_REST_URL: 'https://perpl.example',
  PERPL_WS_URL: 'wss://perpl.example',
  PERPL_CHAIN_ID: '10143',
  PERPL_API_KEY: 'private-key',
  PERPL_API_KEY_SECRET: 'private-secret',
  PERPL_ACCOUNT_ID: '642',
}
const validate = (env: Record<string, string | undefined>) => assertProductionConfig(loadConfig(env), env)

describe('testnet startup configuration', () => {
  it('accepts a configured testnet without live Perpl settings', () => {
    expect(() => validate(valid)).not.toThrow()
  })
  it.each([
    ['DATABASE_URL', { DATABASE_URL: undefined }, 'DATABASE_URL_MISSING'],
    ['SESSION_SECRET missing', { SESSION_SECRET: undefined }, 'SESSION_SECRET_UNSAFE'],
    ['SESSION_SECRET default', { SESSION_SECRET: 'development-only-change-me' }, 'SESSION_SECRET_UNSAFE'],
    [
      'wallet allowlist',
      { EYELER_ALLOWED_WALLETS: undefined, MONAD_WALLET_ADDRESS: undefined },
      'WALLET_ALLOWLIST_MISSING',
    ],
    ['CORS_ORIGIN', { CORS_ORIGIN: undefined }, 'CORS_ORIGIN_MISSING'],
  ])('rejects %s', (_name, change, code) => {
    expect(() => validate({ ...valid, ...change })).toThrow(code as string)
  })
  it.each(Object.keys(live))('rejects partial Perpl live settings missing %s', (missing) => {
    expect(() => validate({ ...valid, ...live, [missing]: undefined })).toThrow('PERPL_LIVE_SETTINGS_INCOMPLETE')
  })
  it('lists all problems once without printing secrets', () => {
    const env = {
      ...valid,
      ...live,
      DATABASE_URL: undefined,
      SESSION_SECRET: undefined,
      CORS_ORIGIN: undefined,
      PERPL_API_KEY_SECRET: undefined,
    }
    expect(() => validate(env)).toThrow(
      'DATABASE_URL_MISSING, SESSION_SECRET_UNSAFE, CORS_ORIGIN_MISSING, PERPL_LIVE_SETTINGS_INCOMPLETE',
    )
    try {
      validate(env)
    } catch (error) {
      expect(String(error)).not.toContain('private-key')
    }
  })
})
