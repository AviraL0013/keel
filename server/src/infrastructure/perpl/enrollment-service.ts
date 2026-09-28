import { randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { getPublicKeyAsync, signAsync } from '@noble/ed25519'
import { hashTypedData, verifyTypedData, type Address, type Hex } from 'viem'
import type { Config } from '../../config/index.js'
import { AuthorizationError, ConflictError, InfrastructureError, NotFoundError } from '../../application/errors.js'
import type { PostgresStore } from '../database/postgres-store.js'
import { DevelopmentKeyCustody, type KeyCustody } from './key-custody.js'
import { PerplEnrollmentClient, type EnrollmentPayloadRequest, type EnrolledKey } from './enrollment-client.js'

export type EnrollmentConfig = { chainId: number; environment: 'testnet'; origin: string; ttlDays: number; ipCidrs?: string[]; builderId?: number; builderFeeCeiling?: number }
type TypedData = { domain: Record<string, unknown>; types: Record<string, readonly { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }
const keyPage = 'https://testnet.perpl.xyz/apikeys'
const credentialContext = (id: string, field: 'private_key' | 'mac' | 'api_token') => `${id}:${field}`

export function loadEnrollmentConfig(env: Record<string, string | undefined>, config: Config): EnrollmentConfig {
  if (config.environment === 'mainnet') throw new Error('PERPL_CONNECTIONS_MAINNET_UNSUPPORTED')
  const origin = env.PERPL_ENROLLMENT_ORIGIN
  try { if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error() }
  catch { throw new Error('INVALID_PERPL_ENROLLMENT_ORIGIN') }
  const ttlDays = Number(env.KEEL_KEY_TTL_DAYS ?? 90)
  if (!Number.isSafeInteger(ttlDays) || ttlDays < 1 || ttlDays > 3650) throw new Error('INVALID_KEEL_KEY_TTL_DAYS')
  const ipCidrs = (env.KEEL_EGRESS_CIDRS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (ipCidrs.length > 4 || ipCidrs.some(value => {
    const [ip, prefix, extra] = value.split('/')
    const version = isIP(ip)
    return extra !== undefined || !version || !/^(0|[1-9]\d*)$/.test(prefix ?? '') || Number(prefix) > (version === 4 ? 32 : 128)
  })) throw new Error('INVALID_KEEL_EGRESS_CIDRS')
  const builderIdRaw = env.KEEL_BUILDER_ID
  const feeRaw = env.KEEL_MAX_BUILDER_FEE_PER_100K
  const builderId = builderIdRaw == null || builderIdRaw === '' ? undefined : Number(builderIdRaw)
  const builderFeeCeiling = feeRaw == null || feeRaw === '' ? undefined : Number(feeRaw)
  if ((builderId === undefined) !== (builderFeeCeiling === undefined) || (builderId !== undefined && (!Number.isSafeInteger(builderId) || builderId < 1 || builderId > 255)) || (builderFeeCeiling !== undefined && (!Number.isSafeInteger(builderFeeCeiling) || builderFeeCeiling < 0 || builderFeeCeiling > 100))) throw new Error('INVALID_KEEL_BUILDER_TERMS')
  return { chainId: config.perplChainId, environment: 'testnet', origin, ttlDays, ...(ipCidrs.length ? { ipCidrs } : {}), ...(builderId === undefined ? {} : { builderId, builderFeeCeiling }) }
}

function typedData(value: unknown): TypedData {
  if (!value || typeof value !== 'object') throw new InfrastructureError('PERPL_ENROLLMENT_INVALID_RESPONSE')
  const input = value as Record<string, unknown>
  if (!input.domain || !input.types || !input.message || typeof input.primaryType !== 'string') throw new InfrastructureError('PERPL_ENROLLMENT_INVALID_RESPONSE')
  return value as TypedData
}

export class PerplEnrollmentService {
  private cleanupTimer?: ReturnType<typeof setInterval>
  constructor(private readonly store: PostgresStore, private readonly config: EnrollmentConfig, private readonly custody: KeyCustody, private readonly client: PerplEnrollmentClient, private readonly now: () => number = Date.now) {}

  startCleanup() { if (!this.cleanupTimer) { this.cleanupTimer = setInterval(() => { void this.cleanupExpired().catch(() => undefined) }, 60_000); this.cleanupTimer.unref() } }
  stopCleanup() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); this.cleanupTimer = undefined }
  async cleanupExpired() {
    await this.store.pool.query(`UPDATE perpl_connections SET status='EXPIRED',sealed_private_key=NULL,sealed_api_token=NULL,sealed_mac=NULL,typed_data=NULL,shredded_at=now(),last_error='ENROLLMENT_EXPIRED'
      WHERE (status='PENDING' AND pending_expires_at<=now()) OR (status='ACTIVE' AND expires_at<=now())`)
  }
  async start(userId: string, walletAddress: string): Promise<{ connectionId: string; typedData: TypedData }> {
    await this.cleanupExpired()
    const wallet = walletAddress.toLowerCase()
    const active = await this.store.pool.query("SELECT 1 FROM perpl_connections WHERE user_id=$1 AND wallet_address=$2 AND environment=$3 AND status='ACTIVE' LIMIT 1", [userId, wallet, this.config.environment])
    if (active.rows.length) throw new ConflictError('PERPL_CONNECTION_ALREADY_ACTIVE')
    const pending = await this.store.pool.query("SELECT 1 FROM perpl_connections WHERE user_id=$1 AND wallet_address=$2 AND environment=$3 AND status='PENDING' LIMIT 1", [userId, wallet, this.config.environment])
    if (pending.rows.length) throw new ConflictError('PERPL_ENROLLMENT_ALREADY_PENDING')
    const secret = randomBytes(32)
    try {
      const publicKey = `0x${Buffer.from(await getPublicKeyAsync(secret)).toString('hex')}`
      const expiresAt = this.now() + this.config.ttlDays * 86_400_000
      const payloadRequest: EnrollmentPayloadRequest = { chain_id: this.config.chainId, address: wallet, public_key: publicKey, scope_mask: 3, label: 'KEEL', expires_at: expiresAt,
        ...(this.config.ipCidrs ? { ip_cidrs: this.config.ipCidrs } : {}), ...(this.config.builderId === undefined ? {} : { builder_id: this.config.builderId, max_builder_fee_per_100k: this.config.builderFeeCeiling }) }
      const payload = await this.client.payload(payloadRequest)
      const typed = typedData(payload.typed_data)
      const connectionId = randomUUID()
      try {
        await this.store.pool.query(`INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,wallet_address,public_key,sealed_private_key,sealed_mac,typed_data,scope_mask,label,origin,ip_cidrs,expires_at,pending_expires_at,builder_id,builder_fee_ceiling)
          VALUES($1,$2,$3,'trade',$4,'PENDING',$5,$6,$7,$8,$9,3,'KEEL',$10,$11,$12,$13,$14,$15)`, [connectionId,userId,this.config.environment,`enrollment:${connectionId}`,wallet,publicKey,this.custody.seal(secret.toString('hex'), credentialContext(connectionId, 'private_key')),this.custody.seal(payload.mac, credentialContext(connectionId, 'mac')),JSON.stringify(typed),this.config.origin,JSON.stringify(this.config.ipCidrs ?? []),new Date(expiresAt).toISOString(),new Date(this.now() + 600_000).toISOString(),this.config.builderId ?? null,this.config.builderFeeCeiling ?? null])
      } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new ConflictError('PERPL_ENROLLMENT_ALREADY_PENDING'); throw error }
      return { connectionId, typedData: typed }
    } finally { secret.fill(0) }
  }

  async complete(userId: string, walletAddress: string, id: string, signature: string): Promise<{ connectionId: string; status: 'ACTIVE' }> {
    await this.cleanupExpired()
    const db = await this.store.pool.connect()
    try {
      await db.query('BEGIN')
      const found = await db.query('SELECT * FROM perpl_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [id,userId])
      const row = found.rows[0]
      if (!row) throw new NotFoundError('PERPL_CONNECTION_NOT_FOUND')
      if (row.status !== 'PENDING') throw new ConflictError('PERPL_ENROLLMENT_NOT_PENDING')
      if (String(row.wallet_address).toLowerCase() !== walletAddress.toLowerCase()) throw new AuthorizationError('PERPL_ENROLLMENT_WALLET_MISMATCH')
      const active = await db.query("SELECT 1 FROM perpl_connections WHERE user_id=$1 AND wallet_address=$2 AND environment=$3 AND status='ACTIVE' LIMIT 1", [userId,row.wallet_address,row.environment])
      if (active.rows.length) throw new ConflictError('PERPL_CONNECTION_ALREADY_ACTIVE')
      const typed = typedData(row.typed_data)
      const canonical = { ...typed, types: Object.fromEntries(Object.entries(typed.types).filter(([name]) => name !== 'EIP712Domain')) }
      let valid = false
      try { valid = await verifyTypedData({ ...canonical, address: walletAddress as Address, signature: signature as Hex } as Parameters<typeof verifyTypedData>[0]) }
      catch { valid = false }
      if (!valid) throw new AuthorizationError('WALLET_SIGNATURE_INVALID')
      const privateKey = Buffer.from(this.custody.open(String(row.sealed_private_key), credentialContext(id, 'private_key')), 'hex')
      let popSignature: string
      try {
        const digest = hashTypedData(canonical as Parameters<typeof hashTypedData>[0])
        popSignature = `0x${Buffer.from(await signAsync(Buffer.from(digest.slice(2), 'hex'), privateKey)).toString('hex')}`
      } finally { privateKey.fill(0) }
      let enrolled: EnrolledKey
      try {
        enrolled = await this.client.enroll({ chain_id: this.config.chainId, address: walletAddress.toLowerCase(), typed_data: typed, mac: this.custody.open(String(row.sealed_mac), credentialContext(id, 'mac')), signature, pop_signature: popSignature })
        if (enrolled.api_key.address.toLowerCase() !== walletAddress.toLowerCase() || enrolled.api_key.scope_mask !== 3 || enrolled.api_key.label !== 'KEEL' || enrolled.api_key.origin !== this.config.origin || enrolled.api_key.expires_at !== new Date(row.expires_at).getTime() || enrolled.api_key.builder_id !== (row.builder_id ?? undefined) || enrolled.api_key.max_builder_fee_per_100k !== (row.builder_fee_ceiling ?? undefined)) throw new InfrastructureError('PERPL_ENROLLMENT_RESPONSE_MISMATCH')
      } catch (error) {
        await db.query("UPDATE perpl_connections SET status='ERROR',last_error=$2,sealed_private_key=NULL,sealed_mac=NULL,typed_data=NULL,shredded_at=now() WHERE id=$1", [id,error instanceof Error ? error.message : 'PERPL_ENROLLMENT_UNAVAILABLE'])
        await db.query('COMMIT')
        throw error
      }
      await db.query("UPDATE perpl_connections SET status='ACTIVE',sealed_api_token=$2,sealed_mac=NULL,typed_data=NULL,pending_expires_at=NULL,last_error=NULL WHERE id=$1", [id,this.custody.seal(enrolled.api_key.api_key, credentialContext(id, 'api_token'))])
      await db.query('COMMIT')
      return { connectionId: id, status: 'ACTIVE' }
    } catch (error) { try { await db.query('ROLLBACK') } catch { /* Transaction already committed after a venue error. */ } throw error }
    finally { db.release() }
  }

  async disconnect(userId: string, id: string): Promise<{ connectionId: string; status: 'REVOKED'; perplKeyPageUrl: string }> {
    const result = await this.store.pool.query(`UPDATE perpl_connections SET status='REVOKED',sealed_private_key=NULL,sealed_api_token=NULL,sealed_mac=NULL,typed_data=NULL,shredded_at=now(),revoked_at=now()
      WHERE id=$1 AND user_id=$2 RETURNING id`, [id,userId])
    if (!result.rows.length) throw new NotFoundError('PERPL_CONNECTION_NOT_FOUND')
    return { connectionId: id, status: 'REVOKED', perplKeyPageUrl: keyPage }
  }
}

export function createPerplEnrollmentService(store: PostgresStore, config: Config, env: Record<string, string | undefined>, fetcher: typeof fetch = fetch): PerplEnrollmentService | undefined {
  if (!env.KEEL_KEY_ENCRYPTION_KEY) return undefined
  const settings = loadEnrollmentConfig(env, config)
  const custody = new DevelopmentKeyCustody(env.KEEL_KEY_ENCRYPTION_KEY)
  return new PerplEnrollmentService(store, settings, custody, new PerplEnrollmentClient(config.perplRestUrl, settings.origin, fetcher))
}
