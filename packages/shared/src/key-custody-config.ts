export type KeyCustodyConfig =
  | { provider: 'development'; key: string }
  | { provider: 'aws-kms'; region: string; keyArn: string; decryptKeyArns: string[] }

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
  if (developmentKey && !['development', 'test'].includes(environment)) throw new Error('DEVELOPMENT_CUSTODY_FORBIDDEN')
  if (environment === 'mainnet' && provider !== 'aws-kms') throw new Error('KMS_CUSTODY_REQUIRED')
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
