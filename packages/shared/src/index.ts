export type Environment = 'development' | 'test' | 'testnet' | 'mainnet'
export type Config = { environment: Environment; port: number; databaseUrl?: string; sessionSecret: string; perplRestUrl: string; perplWsUrl: string; perplChainId: number; ausdTokenAddress?: string; corsOrigin: string; allowedWallets: string[]; safeModeResumeTicks: number }
export type WalletAccess = 'ALLOWED' | 'WALLET_NOT_ALLOWED' | 'WALLET_ALLOWLIST_NOT_CONFIGURED'
export function walletAccess(config: Config, address: string): WalletAccess { if (config.allowedWallets.length === 0) return config.environment === 'test' ? 'ALLOWED' : 'WALLET_ALLOWLIST_NOT_CONFIGURED'; return config.allowedWallets.includes(address.toLowerCase()) ? 'ALLOWED' : 'WALLET_NOT_ALLOWED' }
export function brandEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const current = env[`EYELER_${name}`]
  const previous = env[`KEEL_${name}`]
  if (current !== undefined && previous !== undefined && current !== previous) throw new Error(`CONFLICTING_EYELER_${name}`)
  return current ?? previous
}
export function loadConfig(env: Record<string, string | undefined> = {}): Config {
  const environment = (brandEnv(env, 'ENV') ?? 'development') as Environment
  const explicit = (brandEnv(env, 'ALLOWED_WALLETS') ?? '').trim()
  const source = explicit ? explicit : (env.MONAD_WALLET_ADDRESS ?? '')
  const allowedWallets = [...new Set(source.split(',').map(address => address.trim()).filter(Boolean).map(address => { if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(explicit ? 'INVALID_EYELER_ALLOWED_WALLETS' : 'INVALID_MONAD_WALLET_ADDRESS'); return address.toLowerCase() }))]
  const safeModeResumeTicks = Number(brandEnv(env, 'SAFE_MODE_RESUME_TICKS') ?? 5)
  if (!Number.isSafeInteger(safeModeResumeTicks) || safeModeResumeTicks < 1) throw new Error('INVALID_EYELER_SAFE_MODE_RESUME_TICKS')
  return { environment, port: Number(env.PORT ?? 8787), databaseUrl: env.DATABASE_URL, sessionSecret: env.SESSION_SECRET ?? 'development-only-change-me', perplRestUrl: env.PERPL_REST_URL ?? '', perplWsUrl: env.PERPL_WS_URL ?? '', perplChainId: Number(env.PERPL_CHAIN_ID ?? 10143), ausdTokenAddress: env.AUSD_TOKEN_ADDRESS, corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173', allowedWallets, safeModeResumeTicks }
}
export function assertProductionConfig(config: Config, env: Record<string, string | undefined> = process.env) {
  if (config.environment === 'mainnet' && (config.sessionSecret.includes('change-me') || !config.databaseUrl || !config.perplRestUrl || !config.perplWsUrl || !config.ausdTokenAddress)) throw new Error('INCOMPLETE_MAINNET_CONFIGURATION')
  if (config.environment !== 'testnet') return
  const problems: string[] = []
  const set = (key: string) => Boolean(env[key]?.trim())
  if (!set('DATABASE_URL')) problems.push('DATABASE_URL_MISSING')
  if (!set('SESSION_SECRET') || config.sessionSecret === 'development-only-change-me') problems.push('SESSION_SECRET_UNSAFE')
  if (!config.allowedWallets.length) problems.push('WALLET_ALLOWLIST_MISSING')
  if (!set('CORS_ORIGIN')) problems.push('CORS_ORIGIN_MISSING')
  const perpl = ['PERPL_REST_URL','PERPL_WS_URL','PERPL_CHAIN_ID','PERPL_API_KEY','PERPL_API_KEY_SECRET','PERPL_ACCOUNT_ID']
  const count = perpl.filter(set).length
  if (count > 0 && count < perpl.length) problems.push('PERPL_LIVE_SETTINGS_INCOMPLETE')
  if (problems.length) throw new Error(`INVALID_TESTNET_CONFIGURATION: ${problems.join(', ')}`)
}
export type Logger = { info: (meta: Record<string, unknown>, message: string) => void; warn: (meta: Record<string, unknown>, message: string) => void; error: (meta: Record<string, unknown>, message: string) => void }
export const logger: Logger = { info(meta, message) { console.log(JSON.stringify({ level: 'info', ...meta, message, timestamp: new Date().toISOString() })) }, warn(meta, message) { console.warn(JSON.stringify({ level: 'warn', ...meta, message, timestamp: new Date().toISOString() })) }, error(meta, message) { console.error(JSON.stringify({ level: 'error', ...meta, message, timestamp: new Date().toISOString() })) } }
