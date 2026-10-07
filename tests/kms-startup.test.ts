import { expect, it, vi } from 'vitest'
import { KMSClient } from '@aws-sdk/client-kms'
import { createServer } from '../server/src/index.js'
import { databaseFixture } from './helpers/database.js'
import { EyelerRuntime } from '../server/src/runtime.js'

it('rejects startup before acquiring a worker lock or starting a venue when KMS denies access', async () => {
  const env = {
    EYELER_ENV: 'mainnet',
    EYELER_PERPL_ACCOUNT_MODE: 'per-user',
    EYELER_ACCESS_MODE: 'allowlist',
    EYELER_ALLOWED_WALLETS: '0x1111111111111111111111111111111111111111',
    DATABASE_URL: 'postgres://unused/test',
    SESSION_SECRET: 'unit-test-only',
    CORS_ORIGIN: 'https://app.eyeler.xyz',
    PERPL_ENROLLMENT_ORIGIN: 'https://app.eyeler.xyz',
    PERPL_REST_URL: 'https://app.perpl.xyz/api',
    PERPL_WS_URL: 'wss://app.perpl.xyz',
    PERPL_CHAIN_ID: '143',
    MONAD_CHAIN_ID: '143',
    MONAD_RPC_URL: 'https://rpc.monad.xyz',
    AUSD_TOKEN_ADDRESS: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    EYELER_BUILDER_ID: '25',
    EYELER_MAX_BUILDER_FEE_PER_100K: '0',
    EYELER_KEY_CUSTODY: 'aws-kms',
    AWS_REGION: 'ap-southeast-1',
    EYELER_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-1:111122223333:key/00000000-0000-4000-8000-000000000001',
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  const send = vi
    .spyOn(KMSClient.prototype, 'send')
    .mockRejectedValue(Object.assign(new Error('synthetic-denial'), { name: 'AccessDeniedException' }))
  const start = vi.spyOn(EyelerRuntime.prototype, 'start')
  const { store } = await databaseFixture()
  const app = createServer(store)
  try {
    await expect(app.ready()).rejects.toThrow('KMS_CUSTODY_UNAVAILABLE')
    expect(start).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    await app.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }
}, 20000)
