export type KeyCustodyConfig =
  | { provider: 'development'; key: string }
  | { provider: 'aws-kms'; region: string; keyArn: string; decryptKeyArns: string[] }
  | { provider: 'railway-testnet'; keys: Record<string, string>; activeVersion: string }
  | { provider: 'railway-allowlist-demo'; keys: Record<string, string>; activeVersion: string }

export function kmsKeyRegion(arn: string): string | undefined {
  return /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/.exec(
    arn,
  )?.[1]
}

/** No credentials are read here. This validates deployment configuration only. */
export function loadKeyCustodyConfig(
  env: Record<string, string | undefined>,
  environment: string,
): KeyCustodyConfig | undefined {
  const provider = env.EYELER_KEY_CUSTODY
  const developmentKey = env.EYELER_KEY_ENCRYPTION_KEY ?? env.KEEL_KEY_ENCRYPTION_KEY
  const testnetKeys = env.EYELER_TESTNET_CUSTODY_KEYS
  const activeVersion = env.EYELER_TESTNET_CUSTODY_ACTIVE_VERSION
  const demoKeys = env.EYELER_DEMO_CUSTODY_KEYS
  const demoVersion = env.EYELER_DEMO_CUSTODY_ACTIVE_VERSION
  if (developmentKey && !['development', 'test'].includes(environment)) throw new Error('DEVELOPMENT_CUSTODY_FORBIDDEN')
  if (environment === 'mainnet' && provider !== 'aws-kms' && provider !== 'railway-allowlist-demo')
    throw new Error('KMS_CUSTODY_REQUIRED')
  if (provider === 'railway-allowlist-demo') {
    if (environment !== 'mainnet') throw new Error('DEMO_CUSTODY_FORBIDDEN')
    if (env.EYELER_PERPL_ACCOUNT_MODE !== 'per-user' || env.EYELER_ACCESS_MODE !== 'allowlist')
      throw new Error('KMS_CUSTODY_REQUIRED')
    let keys: Record<string, string>
    try {
      keys = JSON.parse(demoKeys ?? '') as Record<string, string>
    } catch {
      throw new Error('INVALID_DEMO_CUSTODY_CONFIGURATION')
    }
    if (
      !keys ||
      Array.isArray(keys) ||
      typeof keys !== 'object' ||
      Object.keys(keys).length < 1 ||
      Object.keys(keys).length > 8 ||
      !demoVersion ||
      !Object.hasOwn(keys, demoVersion) ||
      Object.entries(keys).some(
        ([version, key]) => !/^[A-Za-z0-9_-]{1,32}$/.test(version) || !/^[0-9a-fA-F]{64}$/.test(key),
      ) ||
      developmentKey ||
      testnetKeys ||
      activeVersion ||
      env.EYELER_KMS_KEY_ARN ||
      env.EYELER_KMS_DECRYPT_KEY_ARNS
    )
      throw new Error('INVALID_DEMO_CUSTODY_CONFIGURATION')
    return { provider, keys, activeVersion: demoVersion }
  }
  if (demoKeys || demoVersion) throw new Error('INVALID_DEMO_CUSTODY_CONFIGURATION')
  if (provider === 'railway-testnet') {
    if (environment !== 'testnet') throw new Error('TESTNET_CUSTODY_FORBIDDEN')
    let keys: Record<string, string>
    try {
      keys = JSON.parse(testnetKeys ?? '') as Record<string, string>
    } catch {
      throw new Error('INVALID_TESTNET_CUSTODY_CONFIGURATION')
    }
    if (
      !keys ||
      Array.isArray(keys) ||
      typeof keys !== 'object' ||
      Object.keys(keys).length < 1 ||
      Object.keys(keys).length > 8 ||
      !activeVersion ||
      !Object.hasOwn(keys, activeVersion) ||
      Object.entries(keys).some(
        ([version, key]) => !/^[A-Za-z0-9_-]{1,32}$/.test(version) || !/^[0-9a-fA-F]{64}$/.test(key),
      ) ||
      developmentKey ||
      env.EYELER_KMS_KEY_ARN ||
      env.EYELER_KMS_DECRYPT_KEY_ARNS
    )
      throw new Error('INVALID_TESTNET_CUSTODY_CONFIGURATION')
    return { provider, keys, activeVersion }
  }
  if (testnetKeys || activeVersion) throw new Error('INVALID_TESTNET_CUSTODY_CONFIGURATION')
  if (provider === 'aws-kms') {
    const keyArn = env.EYELER_KMS_KEY_ARN ?? ''
    const region = env.AWS_REGION ?? ''
    const decryptKeyArns = [
      ...new Set(
        (env.EYELER_KMS_DECRYPT_KEY_ARNS ?? '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ]
    if (
      !region ||
      kmsKeyRegion(keyArn) !== region ||
      decryptKeyArns.length > 8 ||
      decryptKeyArns.some((arn) => kmsKeyRegion(arn) !== region) ||
      developmentKey
    )
      throw new Error('INVALID_KMS_CUSTODY_CONFIGURATION')
    return { provider, region, keyArn, decryptKeyArns }
  }
  if ((provider && provider !== 'development') || env.EYELER_KMS_KEY_ARN || env.EYELER_KMS_DECRYPT_KEY_ARNS)
    throw new Error('INVALID_KMS_CUSTODY_CONFIGURATION')
  if (provider === 'development' && !['development', 'test'].includes(environment))
    throw new Error('DEVELOPMENT_CUSTODY_FORBIDDEN')
  if (developmentKey) {
    if (
      env.EYELER_KEY_ENCRYPTION_KEY &&
      env.KEEL_KEY_ENCRYPTION_KEY &&
      env.EYELER_KEY_ENCRYPTION_KEY !== env.KEEL_KEY_ENCRYPTION_KEY
    )
      throw new Error('CONFLICTING_EYELER_KEY_ENCRYPTION_KEY')
    return { provider: 'development', key: developmentKey }
  }
  if (provider === 'development') throw new Error('INVALID_EYELER_KEY_ENCRYPTION_KEY')
  return undefined
}
