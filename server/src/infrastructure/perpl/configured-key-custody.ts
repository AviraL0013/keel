import { loadKeyCustodyConfig } from '../../../../packages/shared/src/key-custody-config.js'
import { logger, type Environment } from '../../config/index.js'
import { DevelopmentKeyCustody, type KeyCustody } from './key-custody.js'
import { AwsKmsKeyCustody } from './kms-key-custody.js'

export function configuredKeyCustody(
  env: Record<string, string | undefined>,
  environment: Environment,
): KeyCustody | undefined {
  const config = loadKeyCustodyConfig(env, environment)
  if (!config) return undefined
  if (config.provider === 'development') return new DevelopmentKeyCustody(config.key)
  return new AwsKmsKeyCustody({
    ...config,
    environment,
    audit: (event) => logger.info(event, 'Credential custody audit'),
  })
}
