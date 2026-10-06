import { pathToFileURL } from 'node:url'
import { loadConfig } from '../packages/shared/src/index.js'
import { configuredKeyCustody } from '../server/src/infrastructure/perpl/configured-key-custody.js'
import { AwsKmsKeyCustody } from '../server/src/infrastructure/perpl/kms-key-custody.js'
import { RailwayTestnetKeyCustody } from '../server/src/infrastructure/perpl/railway-testnet-key-custody.js'
import { PostgresStore } from '../server/src/infrastructure/database/postgres-store.js'
import { rotateCredentialBatch } from '../server/src/infrastructure/perpl/rotate-credentials.js'

/** Default is read-only enumeration. --apply explicitly permits ciphertext updates. */
export async function rotatePerplCredentials(args: string[], env = process.env) {
  if (args.some((arg) => arg !== '--apply')) throw new Error('INVALID_ROTATION_ARGUMENTS')
  const config = loadConfig(env)
  if (!config.databaseUrl || (config.environment !== 'mainnet' && config.environment !== 'testnet'))
    throw new Error('INVALID_ROTATION_CONFIGURATION')
  const custody = configuredKeyCustody(env, config.environment)
  if (config.environment === 'mainnet' && !(custody instanceof AwsKmsKeyCustody))
    throw new Error('KMS_CUSTODY_REQUIRED')
  if (
    config.environment === 'testnet' &&
    !(custody instanceof RailwayTestnetKeyCustody) &&
    !(custody instanceof AwsKmsKeyCustody)
  )
    throw new Error('TESTNET_CUSTODY_REQUIRED')
  if (!(custody instanceof RailwayTestnetKeyCustody) && !(custody instanceof AwsKmsKeyCustody))
    throw new Error('CUSTODY_REQUIRED')
  const store = new PostgresStore(config.databaseUrl)
  let after: string | undefined
  const total = { mode: args.includes('--apply') ? 'apply' : 'dry-run', scanned: 0, rotated: 0, skipped: 0 }
  try {
    do {
      const result = await rotateCredentialBatch(store, custody, config.environment, {
        apply: args.includes('--apply'),
        after,
      })
      total.scanned += result.scanned
      total.rotated += result.rotated
      total.skipped += result.skipped
      after = result.nextCursor
    } while (after)
    return total
  } finally {
    custody.close()
    await store.pool.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void rotatePerplCredentials(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      // Database and AWS error details can include sensitive connection information.
      console.error('CREDENTIAL_ROTATION_STOPPED: no later rows attempted; previously completed rows remain rotated')
      process.exitCode = 1
    })
}
