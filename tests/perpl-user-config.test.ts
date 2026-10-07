import { describe, expect, it } from 'vitest'
import { assertProductionConfig, loadConfig, walletAccess } from '../packages/shared/src/index.js'

const base = {
  EYELER_ENV: 'testnet',
  DATABASE_URL: 'postgres://unused/test',
  SESSION_SECRET: 'unit-test-only',
  CORS_ORIGIN: 'https://app.example',
  EYELER_PERPL_ACCOUNT_MODE: 'per-user',
  EYELER_KEY_CUSTODY: 'aws-kms',
  AWS_REGION: 'ap-southeast-1',
  EYELER_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-1:111122223333:key/00000000-0000-4000-8000-000000000001',
  PERPL_ENROLLMENT_ORIGIN: 'https://app.example',
  EYELER_ALLOWED_WALLETS: '0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002',
}

describe('explicit per-user deployment configuration', () => {
  it('requires KMS and matching network settings before mainnet can be configured', () => {
    const mainnet = {
      ...base,
      EYELER_ENV: 'mainnet',
      CORS_ORIGIN: 'https://app.eyeler.xyz',
      PERPL_ENROLLMENT_ORIGIN: 'https://app.eyeler.xyz',
      AUSD_TOKEN_ADDRESS: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
      MONAD_CHAIN_ID: '143',
      MONAD_RPC_URL: 'https://rpc.monad.xyz',
      EYELER_BUILDER_ID: '25',
      EYELER_MAX_BUILDER_FEE_PER_100K: '0',
    }
    expect(() => assertProductionConfig(loadConfig(mainnet), mainnet)).not.toThrow()
    const mixed = { ...mainnet, PERPL_CHAIN_ID: '10143' }
    expect(() => assertProductionConfig(loadConfig(mixed), mixed)).toThrow('PERPL_ENVIRONMENT_MISMATCH')
    for (const invalid of [
      { AUSD_TOKEN_ADDRESS: '0xdf5b718d8fcc173335185a2a1513ee8151e3c027' },
      { MONAD_CHAIN_ID: '10143' },
      { MONAD_RPC_URL: 'https://testnet-rpc.monad.xyz' },
      { CORS_ORIGIN: 'https://testnet.eyeler.xyz' },
      { PERPL_ENROLLMENT_ORIGIN: 'https://testnet.eyeler.xyz' },
      { EYELER_BUILDER_ID: '26' },
      { EYELER_MAX_BUILDER_FEE_PER_100K: '1' },
    ])
      expect(() => assertProductionConfig(loadConfig({ ...mainnet, ...invalid }), { ...mainnet, ...invalid })).toThrow(
        'MAINNET_BOUNTY_PROFILE_MISMATCH',
      )
  })
  it('accepts multiple allowlisted users only with isolated connections and no shared credentials', () => {
    expect(loadConfig(base)).toMatchObject({ perplAccountMode: 'per-user' })
    expect(() => assertProductionConfig(loadConfig(base), base)).not.toThrow()
    const shared = { ...base, PERPL_API_KEY: 'operator-key' }
    expect(() => assertProductionConfig(loadConfig(shared), shared)).toThrow('PER_USER_SHARED_CREDENTIALS_FORBIDDEN')
  })
  it('requires explicit public access and refuses public access with an operator account', () => {
    const publicEnv = { ...base, EYELER_ACCESS_MODE: 'public', EYELER_ALLOWED_WALLETS: '' }
    const config = loadConfig(publicEnv)
    expect(walletAccess(config, '0x0000000000000000000000000000000000000003')).toBe('ALLOWED')
    expect(() => assertProductionConfig(config, publicEnv)).not.toThrow()
    expect(() => loadConfig({ ...publicEnv, EYELER_PERPL_ACCOUNT_MODE: 'operator' })).toThrow(
      'PUBLIC_ACCESS_REQUIRES_PER_USER_ACCOUNTS',
    )
    expect(
      walletAccess(loadConfig({ ...base, EYELER_ALLOWED_WALLETS: '' }), '0x0000000000000000000000000000000000000003'),
    ).toBe('WALLET_ALLOWLIST_NOT_CONFIGURED')
  })
  it('rejects invalid modes and keeps mainnet blocked until production credential custody is supplied', () => {
    expect(() => loadConfig({ ...base, EYELER_PERPL_ACCOUNT_MODE: 'anything' })).toThrow(
      'INVALID_EYELER_PERPL_ACCOUNT_MODE',
    )
    expect(() => loadConfig({ ...base, EYELER_ACCESS_MODE: 'anything' })).toThrow('INVALID_EYELER_ACCESS_MODE')
    const mainnet = { ...base, EYELER_ENV: 'mainnet', EYELER_KEY_CUSTODY: undefined }
    expect(() => assertProductionConfig(loadConfig(mainnet), mainnet)).toThrow('KMS_CUSTODY_REQUIRED')
  })
})
