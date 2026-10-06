export type Environment = 'development' | 'test' | 'testnet' | 'mainnet'
import { loadKeyCustodyConfig } from './key-custody-config.js'

export type Config = {
  environment: Environment
  port: number
  databaseUrl?: string
  sessionSecret: string
  perplRestUrl: string
  perplWsUrl: string
  perplChainId: number
  ausdTokenAddress?: string
  corsOrigin: string
  allowedWallets: string[]
  perplAccountMode: 'operator' | 'per-user'
  accessMode: 'allowlist' | 'public'
  safeModeResumeTicks: number
  tickStaleMs: number
}
export type WalletAccess = 'ALLOWED' | 'WALLET_NOT_ALLOWED' | 'WALLET_ALLOWLIST_NOT_CONFIGURED'
export function walletAccess(config: Config, address: string): WalletAccess {
  if (config.accessMode === 'public' && config.perplAccountMode === 'per-user') return 'ALLOWED'
  if (config.allowedWallets.length === 0)
    return config.environment === 'test' ? 'ALLOWED' : 'WALLET_ALLOWLIST_NOT_CONFIGURED'
  return config.allowedWallets.includes(address.toLowerCase()) ? 'ALLOWED' : 'WALLET_NOT_ALLOWED'
}
export function brandEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const current = env[`EYELER_${name}`]
  const previous = env[`KEEL_${name}`]
  if (current !== undefined && previous !== undefined && current !== previous)
    throw new Error(`CONFLICTING_EYELER_${name}`)
  return current ?? previous
}
export function executionDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (brandEnv(env, 'EXECUTION_DISABLED') ?? 'false').trim().toLowerCase()
  if (value !== 'true' && value !== 'false' && value !== '') throw new Error('INVALID_EYELER_EXECUTION_DISABLED')
  return value === 'true'
}
export function loadConfig(env: Record<string, string | undefined> = {}): Config {
  executionDisabled(env)
  const environment = (brandEnv(env, 'ENV') ?? 'development') as Environment
  if (!['development', 'test', 'testnet', 'mainnet'].includes(environment)) throw new Error('INVALID_EYELER_ENV')
  const perplAccountMode = brandEnv(env, 'PERPL_ACCOUNT_MODE') ?? 'operator'
  if (perplAccountMode !== 'operator' && perplAccountMode !== 'per-user')
    throw new Error('INVALID_EYELER_PERPL_ACCOUNT_MODE')
  const accessMode = brandEnv(env, 'ACCESS_MODE') ?? 'allowlist'
  if (accessMode !== 'allowlist' && accessMode !== 'public') throw new Error('INVALID_EYELER_ACCESS_MODE')
  if (accessMode === 'public' && perplAccountMode !== 'per-user')
    throw new Error('PUBLIC_ACCESS_REQUIRES_PER_USER_ACCOUNTS')
  const explicit = (brandEnv(env, 'ALLOWED_WALLETS') ?? '').trim()
  const source = explicit ? explicit : (env.MONAD_WALLET_ADDRESS ?? '')
  const allowedWallets = [
    ...new Set(
      source
        .split(',')
        .map((address) => address.trim())
        .filter(Boolean)
        .map((address) => {
          if (!/^0x[0-9a-fA-F]{40}$/.test(address))
            throw new Error(explicit ? 'INVALID_EYELER_ALLOWED_WALLETS' : 'INVALID_MONAD_WALLET_ADDRESS')
          return address.toLowerCase()
        }),
    ),
  ]
  const safeModeResumeTicks = Number(brandEnv(env, 'SAFE_MODE_RESUME_TICKS') ?? 5)
  if (!Number.isSafeInteger(safeModeResumeTicks) || safeModeResumeTicks < 1)
    throw new Error('INVALID_EYELER_SAFE_MODE_RESUME_TICKS')
  const tickStaleMs = Number(brandEnv(env, 'TICK_STALE_MS') ?? 15_000)
  if (!Number.isSafeInteger(tickStaleMs) || tickStaleMs < 1) throw new Error('INVALID_EYELER_TICK_STALE_MS')
  return {
    environment,
    perplAccountMode,
    accessMode,
    port: Number(env.PORT ?? 8787),
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET ?? 'development-only-change-me',
    perplRestUrl:
      env.PERPL_REST_URL ??
      (perplAccountMode === 'per-user' ? `https://${environment === 'mainnet' ? 'app' : 'testnet'}.perpl.xyz/api` : ''),
    perplWsUrl:
      env.PERPL_WS_URL ??
      (perplAccountMode === 'per-user' ? `wss://${environment === 'mainnet' ? 'app' : 'testnet'}.perpl.xyz` : ''),
    perplChainId: Number(env.PERPL_CHAIN_ID ?? (environment === 'mainnet' ? 143 : 10143)),
    ausdTokenAddress: env.AUSD_TOKEN_ADDRESS,
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
    allowedWallets,
    safeModeResumeTicks,
    tickStaleMs,
  }
}
export function assertProductionConfig(config: Config, env: Record<string, string | undefined> = process.env) {
  const custody = loadKeyCustodyConfig(env, config.environment)
  if (config.perplAccountMode === 'per-user') {
    if (['PERPL_API_KEY', 'PERPL_API_KEY_SECRET', 'PERPL_ACCOUNT_ID'].some((key) => Boolean(env[key]?.trim())))
      throw new Error('PER_USER_SHARED_CREDENTIALS_FORBIDDEN')
    if (
      ['mainnet', 'testnet'].includes(config.environment) &&
      custody?.provider !== 'aws-kms' &&
      !(config.environment === 'testnet' && custody?.provider === 'railway-testnet')
    )
      throw new Error('KMS_CUSTODY_REQUIRED')
    if (
      !config.databaseUrl ||
      config.sessionSecret.includes('change-me') ||
      !env.SESSION_SECRET?.trim() ||
      !env.CORS_ORIGIN?.trim()
    )
      throw new Error('INCOMPLETE_PER_USER_CONFIGURATION')
    if (config.accessMode === 'allowlist' && !config.allowedWallets.length) throw new Error('WALLET_ALLOWLIST_MISSING')
    if (!custody || !env.PERPL_ENROLLMENT_ORIGIN) throw new Error('PER_USER_ENROLLMENT_NOT_CONFIGURED')
    if (
      config.perplRestUrl !== `https://${config.environment === 'mainnet' ? 'app' : 'testnet'}.perpl.xyz/api` ||
      config.perplWsUrl !== `wss://${config.environment === 'mainnet' ? 'app' : 'testnet'}.perpl.xyz` ||
      config.perplChainId !== (config.environment === 'mainnet' ? 143 : 10143)
    )
      throw new Error('PERPL_ENVIRONMENT_MISMATCH')
    return
  }
  const liveCredentials = ['PERPL_API_KEY', 'PERPL_API_KEY_SECRET', 'PERPL_ACCOUNT_ID'].every((key) =>
    Boolean(env[key]?.trim()),
  )
  if (liveCredentials && config.environment !== 'testnet' && config.allowedWallets.length !== 1)
    throw new Error('MULTI_USER_PERPL_RUNTIME_UNSUPPORTED')
  if (
    config.environment === 'mainnet' &&
    (config.sessionSecret.includes('change-me') ||
      !config.databaseUrl ||
      !config.perplRestUrl ||
      !config.perplWsUrl ||
      !config.ausdTokenAddress)
  )
    throw new Error('INCOMPLETE_MAINNET_CONFIGURATION')
  if (config.environment === 'mainnet' && config.allowedWallets.length !== 1)
    throw new Error('MULTI_USER_PERPL_RUNTIME_UNSUPPORTED')
  if (config.environment !== 'testnet') return
  const problems: string[] = []
  const set = (key: string) => Boolean(env[key]?.trim())
  if (!set('DATABASE_URL')) problems.push('DATABASE_URL_MISSING')
  if (!set('SESSION_SECRET') || config.sessionSecret === 'development-only-change-me')
    problems.push('SESSION_SECRET_UNSAFE')
  if (!config.allowedWallets.length) problems.push('WALLET_ALLOWLIST_MISSING')
  if (!set('CORS_ORIGIN')) problems.push('CORS_ORIGIN_MISSING')
  const perpl = [
    'PERPL_REST_URL',
    'PERPL_WS_URL',
    'PERPL_CHAIN_ID',
    'PERPL_API_KEY',
    'PERPL_API_KEY_SECRET',
    'PERPL_ACCOUNT_ID',
  ]
  const count = perpl.filter(set).length
  if (count > 0 && count < perpl.length) problems.push('PERPL_LIVE_SETTINGS_INCOMPLETE')
  if (count === perpl.length && config.allowedWallets.length !== 1)
    problems.push('MULTI_USER_PERPL_RUNTIME_UNSUPPORTED')
  if (problems.length) throw new Error(`INVALID_TESTNET_CONFIGURATION: ${problems.join(', ')}`)
}
export type Logger = {
  info: (meta: Record<string, unknown>, message: string) => void
  warn: (meta: Record<string, unknown>, message: string) => void
  error: (meta: Record<string, unknown>, message: string) => void
}
export const logger: Logger = {
  info(meta, message) {
    console.log(JSON.stringify({ level: 'info', ...meta, message, timestamp: new Date().toISOString() }))
  },
  warn(meta, message) {
    console.warn(JSON.stringify({ level: 'warn', ...meta, message, timestamp: new Date().toISOString() }))
  },
  error(meta, message) {
    console.error(JSON.stringify({ level: 'error', ...meta, message, timestamp: new Date().toISOString() }))
  },
}
