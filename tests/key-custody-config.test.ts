import { describe, expect, it } from 'vitest'
import { loadKeyCustodyConfig } from '../packages/shared/src/key-custody-config.js'
import { assertProductionConfig, loadConfig } from '../packages/shared/src/index.js'

const kms = {
  EYELER_KEY_CUSTODY: 'aws-kms',
  AWS_REGION: 'ap-southeast-1',
  EYELER_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-1:111122223333:key/00000000-0000-4000-8000-000000000001',
}
describe('custody deployment guard', () => {
  it('permits a Railway envelope key only for a mainnet per-user allowlist demo', () => {
    const demo = {
      EYELER_KEY_CUSTODY: 'railway-allowlist-demo',
      EYELER_PERPL_ACCOUNT_MODE: 'per-user',
      EYELER_ACCESS_MODE: 'allowlist',
      EYELER_DEMO_CUSTODY_KEYS: JSON.stringify({ v1: '11'.repeat(32) }),
      EYELER_DEMO_CUSTODY_ACTIVE_VERSION: 'v1',
    }
    expect(loadKeyCustodyConfig(demo, 'mainnet')).toMatchObject({
      provider: 'railway-allowlist-demo',
      activeVersion: 'v1',
    })
    for (const override of [{ EYELER_ACCESS_MODE: 'public' }, { EYELER_PERPL_ACCOUNT_MODE: 'operator' }])
      expect(() => loadKeyCustodyConfig({ ...demo, ...override }, 'mainnet')).toThrow('KMS_CUSTODY_REQUIRED')
    expect(() => loadKeyCustodyConfig(demo, 'testnet')).toThrow('DEMO_CUSTODY_FORBIDDEN')
    expect(() => loadKeyCustodyConfig({ ...demo, EYELER_DEMO_CUSTODY_ACTIVE_VERSION: 'v2' }, 'mainnet')).toThrow(
      'INVALID_DEMO_CUSTODY_CONFIGURATION',
    )
  })
  it('keeps the testnet Railway provider off mainnet and requires its own key versions', () => {
    const railway = {
      EYELER_KEY_CUSTODY: 'railway-testnet',
      EYELER_TESTNET_CUSTODY_KEYS: JSON.stringify({ v1: '11'.repeat(32), v2: '22'.repeat(32) }),
      EYELER_TESTNET_CUSTODY_ACTIVE_VERSION: 'v2',
    }
    expect(loadKeyCustodyConfig(railway, 'testnet')).toMatchObject({ provider: 'railway-testnet', activeVersion: 'v2' })
    expect(() => loadKeyCustodyConfig(railway, 'mainnet')).toThrow('KMS_CUSTODY_REQUIRED')
    expect(() => loadKeyCustodyConfig(railway, 'development')).toThrow('TESTNET_CUSTODY_FORBIDDEN')
    expect(() => loadKeyCustodyConfig({ ...railway, EYELER_TESTNET_CUSTODY_ACTIVE_VERSION: 'v3' }, 'testnet')).toThrow(
      'INVALID_TESTNET_CUSTODY_CONFIGURATION',
    )
  })
  it('blocks mainnet without KMS even in operator mode and forbids DevelopmentKeyCustody outside local/test', () => {
    for (const environment of ['mainnet', 'testnet']) {
      expect(() => loadKeyCustodyConfig({ EYELER_KEY_ENCRYPTION_KEY: '11'.repeat(32) }, environment)).toThrow(
        'DEVELOPMENT_CUSTODY_FORBIDDEN',
      )
    }
    expect(() => assertProductionConfig(loadConfig({ EYELER_ENV: 'mainnet' }), {})).toThrow('KMS_CUSTODY_REQUIRED')
    expect(loadKeyCustodyConfig({ EYELER_KEY_ENCRYPTION_KEY: '11'.repeat(32) }, 'test')).toMatchObject({
      provider: 'development',
    })
    expect(loadKeyCustodyConfig({}, 'test')).toBeUndefined()
  })
  it('validates immutable ARNs and region and rejects local key fallback when KMS is configured', () => {
    expect(loadKeyCustodyConfig(kms, 'mainnet')).toMatchObject({ provider: 'aws-kms', keyArn: kms.EYELER_KMS_KEY_ARN })
    for (const extra of [
      { AWS_REGION: 'us-east-1' },
      { EYELER_KMS_KEY_ARN: 'alias/eyeler' },
      { EYELER_KMS_DECRYPT_KEY_ARNS: 'arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000002' },
    ])
      expect(() => loadKeyCustodyConfig({ ...kms, ...extra }, 'mainnet')).toThrow('INVALID_KMS_CUSTODY_CONFIGURATION')
    expect(() => loadKeyCustodyConfig({ ...kms, EYELER_KEY_ENCRYPTION_KEY: 'secret-not-to-print' }, 'mainnet')).toThrow(
      'DEVELOPMENT_CUSTODY_FORBIDDEN',
    )
  })
})
