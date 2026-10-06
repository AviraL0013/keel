import { randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { getPublicKeyAsync, signAsync } from '@noble/ed25519'
import { hashTypedData, verifyTypedData, type Address, type Hex } from 'viem'
import { brandEnv, type Config } from '../../config/index.js'
import { AuthorizationError, ConflictError, InfrastructureError, NotFoundError } from '../../application/errors.js'
import type { PostgresStore } from '../database/postgres-store.js'
import { credentialContext, type KeyCustody } from './key-custody.js'
import { configuredKeyCustody } from './configured-key-custody.js'
import { loadKeyCustodyConfig } from '../../../../packages/shared/src/key-custody-config.js'
import { PerplEnrollmentClient, type EnrollmentPayloadRequest, type EnrolledKey } from './enrollment-client.js'
import { validateEnrollmentPayload } from './enrollment-payload.js'

export type EnrollmentConfig = {
  chainId: number
  environment: 'testnet' | 'mainnet'
  origin: string
  ttlDays: number
  ipCidrs?: string[]
  builderId?: number
  builderFeeCeiling?: number
}
type TypedData = {
  domain: Record<string, unknown>
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}
const keyPage = (environment: string) => `https://${environment === 'mainnet' ? 'app' : 'testnet'}.perpl.xyz/apikeys`

export function loadEnrollmentConfig(env: Record<string, string | undefined>, config: Config): EnrollmentConfig {
  if (config.environment === 'mainnet') loadKeyCustodyConfig(env, config.environment)
  const origin = env.PERPL_ENROLLMENT_ORIGIN
  try {
    if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error()
  } catch {
    throw new Error('INVALID_PERPL_ENROLLMENT_ORIGIN')
  }
  const ttlDays = Number(brandEnv(env, 'KEY_TTL_DAYS') ?? 90)
  if (!Number.isSafeInteger(ttlDays) || ttlDays < 1 || ttlDays > 3650) throw new Error('INVALID_EYELER_KEY_TTL_DAYS')
  const ipCidrs = (brandEnv(env, 'EGRESS_CIDRS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (
    ipCidrs.length > 4 ||
    ipCidrs.some((value) => {
      const [ip, prefix, extra] = value.split('/')
      const version = isIP(ip)
      return (
        extra !== undefined ||
        !version ||
        !/^(0|[1-9]\d*)$/.test(prefix ?? '') ||
        Number(prefix) > (version === 4 ? 32 : 128)
      )
    })
  )
    throw new Error('INVALID_EYELER_EGRESS_CIDRS')
  const builderIdRaw = brandEnv(env, 'BUILDER_ID')
  const feeRaw = brandEnv(env, 'MAX_BUILDER_FEE_PER_100K')
  const builderId = builderIdRaw == null || builderIdRaw === '' ? undefined : Number(builderIdRaw)
  const builderFeeCeiling = feeRaw == null || feeRaw === '' ? undefined : Number(feeRaw)
  if (
    (builderId === undefined) !== (builderFeeCeiling === undefined) ||
    (builderId !== undefined && (!Number.isSafeInteger(builderId) || builderId < 1 || builderId > 255)) ||
    (builderFeeCeiling !== undefined &&
      (!Number.isSafeInteger(builderFeeCeiling) || builderFeeCeiling < 0 || builderFeeCeiling > 100))
  )
    throw new Error('INVALID_EYELER_BUILDER_TERMS')
  return {
    chainId: config.perplChainId,
    environment: config.environment === 'mainnet' ? 'mainnet' : 'testnet',
    origin,
    ttlDays,
    ...(ipCidrs.length ? { ipCidrs } : {}),
    ...(builderId === undefined ? {} : { builderId, builderFeeCeiling }),
  }
}

function typedData(value: unknown): TypedData {
  if (!value || typeof value !== 'object') throw new InfrastructureError('PERPL_ENROLLMENT_INVALID_RESPONSE')
  const input = value as Record<string, unknown>
  if (!input.domain || !input.types || !input.message || typeof input.primaryType !== 'string')
    throw new InfrastructureError('PERPL_ENROLLMENT_INVALID_RESPONSE')
  return value as TypedData
}

export class PerplEnrollmentService {
  private cleanupTimer?: ReturnType<typeof setInterval>
  constructor(
    private readonly store: PostgresStore,
    private readonly config: EnrollmentConfig,
    private readonly custody: KeyCustody,
    private readonly client: PerplEnrollmentClient,
    private readonly now: () => number = Date.now,
  ) {}

  capabilities() {
    return {
      status: 'AVAILABLE',
      environment: this.config.environment,
      chainId: this.config.chainId,
      origin: this.config.origin,
      scope: 'read,trade',
      withdrawals: false,
      ttlDays: this.config.ttlDays,
      builderId: this.config.builderId ?? 0,
      maxBuilderFeePer100K: this.config.builderFeeCeiling ?? 0,
      perplKeyPageUrl: keyPage(this.config.environment),
    }
  }

  startCleanup() {
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        void this.cleanupExpired().catch(() => undefined)
      }, 60_000)
      this.cleanupTimer.unref()
    }
  }
  stopCleanup() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = undefined
  }
  async cleanupExpired() {
    await this.store.pool.query(
      `UPDATE perpl_connections SET status=CASE WHEN status='ENROLLING' THEN 'ERROR' ELSE 'EXPIRED' END,sealed_private_key=NULL,sealed_api_token=NULL,sealed_mac=NULL,typed_data=NULL,shredded_at=now(),last_error=CASE WHEN status='ENROLLING' THEN 'ENROLLMENT_OUTCOME_UNKNOWN' ELSE 'ENROLLMENT_EXPIRED' END
      WHERE (status IN ('PENDING','ENROLLING') AND pending_expires_at<=$1) OR (status='ACTIVE' AND expires_at<=$1)`,
      [new Date(this.now()).toISOString()],
    )
  }
  async start(userId: string, walletAddress: string): Promise<{ connectionId: string; typedData: TypedData }> {
    await this.cleanupExpired()
    const wallet = walletAddress.toLowerCase()
    const unresolved = await this.store.pool.query(
      "SELECT 1 FROM perpl_connections WHERE user_id=$1 AND wallet_address=$2 AND environment=$3 AND last_error='ENROLLED_NOT_SAVED' AND revoked_at IS NULL LIMIT 1",
      [userId, wallet, this.config.environment],
    )
    if (unresolved.rows.length) throw new ConflictError('PERPL_ENROLLMENT_REVIEW_REQUIRED')
    const active = await this.store.pool.query(
      "SELECT 1 FROM perpl_connections WHERE user_id=$1 AND wallet_address=$2 AND environment=$3 AND status='ACTIVE' LIMIT 1",
      [userId, wallet, this.config.environment],
    )
    if (active.rows.length) throw new ConflictError('PERPL_CONNECTION_ALREADY_ACTIVE')
    const pending = await this.store.pool.query(
      "SELECT 1 FROM perpl_connections WHERE user_id=$1 AND wallet_address=$2 AND environment=$3 AND status IN ('PENDING','ENROLLING') LIMIT 1",
      [userId, wallet, this.config.environment],
    )
    if (pending.rows.length) throw new ConflictError('PERPL_ENROLLMENT_ALREADY_PENDING')
    const secret = randomBytes(32)
    try {
      const publicKey = `0x${Buffer.from(await getPublicKeyAsync(secret)).toString('hex')}`
      const expiresAt = this.now() + this.config.ttlDays * 86_400_000
      const payloadRequest: EnrollmentPayloadRequest = {
        chain_id: this.config.chainId,
        address: wallet,
        public_key: publicKey,
        scope_mask: 3,
        label: 'EYELER',
        expires_at: expiresAt,
        ...(this.config.ipCidrs ? { ip_cidrs: this.config.ipCidrs } : {}),
        ...(this.config.builderId === undefined
          ? {}
          : { builder_id: this.config.builderId, max_builder_fee_per_100k: this.config.builderFeeCeiling }),
      }
      const payload = await this.client.payload(payloadRequest)
      const typed = validateEnrollmentPayload(payload.typed_data, payloadRequest, this.config.origin, this.now())
      const connectionId = randomUUID()
      try {
        await this.store.pool.query(
          `INSERT INTO perpl_connections(id,user_id,environment,scope,credential_reference,status,wallet_address,public_key,sealed_private_key,sealed_mac,typed_data,scope_mask,label,origin,ip_cidrs,expires_at,pending_expires_at,builder_id,builder_fee_ceiling)
          VALUES($1,$2,$3,'trade',$4,'PENDING',$5,$6,$7,$8,$9,3,'EYELER',$10,$11,$12,$13,$14,$15)`,
          [
            connectionId,
            userId,
            this.config.environment,
            `enrollment:${connectionId}`,
            wallet,
            publicKey,
            await this.custody.seal(secret.toString('hex'), credentialContext(userId, connectionId, 'private_key')),
            await this.custody.seal(payload.mac, credentialContext(userId, connectionId, 'mac')),
            JSON.stringify(typed),
            this.config.origin,
            JSON.stringify(this.config.ipCidrs ?? []),
            new Date(expiresAt).toISOString(),
            new Date(this.now() + 600_000).toISOString(),
            this.config.builderId ?? null,
            this.config.builderFeeCeiling ?? null,
          ],
        )
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
          throw new ConflictError('PERPL_ENROLLMENT_ALREADY_PENDING')
        throw error
      }
      return { connectionId, typedData: typed }
    } finally {
      secret.fill(0)
    }
  }

  private async markEnrollmentError(id: string, userId: string, reason: string) {
    await this.store.pool.query(
      "UPDATE perpl_connections SET status='ERROR',last_error=$3,sealed_private_key=NULL,sealed_mac=NULL,typed_data=NULL,shredded_at=now() WHERE id=$1 AND user_id=$2 AND status='ENROLLING'",
      [id, userId, reason],
    )
  }

  async complete(
    userId: string,
    walletAddress: string,
    id: string,
    signature: string,
  ): Promise<{ connectionId: string; status: 'ACTIVE' }> {
    await this.cleanupExpired()
    const db = await this.store.pool.connect()
    let row: Record<string, unknown>
    let committed = false
    try {
      await db.query('BEGIN')
      const found = await db.query('SELECT * FROM perpl_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        id,
        userId,
      ])
      row = found.rows[0]
      if (!row) throw new NotFoundError('PERPL_CONNECTION_NOT_FOUND')
      if (row.status !== 'PENDING') throw new ConflictError('PERPL_ENROLLMENT_NOT_PENDING')
      if (String(row.wallet_address).toLowerCase() !== walletAddress.toLowerCase())
        throw new AuthorizationError('PERPL_ENROLLMENT_WALLET_MISMATCH')
      const active = await db.query(
        "SELECT 1 FROM perpl_connections WHERE user_id=$1 AND wallet_address=$2 AND environment=$3 AND status='ACTIVE' LIMIT 1",
        [userId, row.wallet_address, row.environment],
      )
      if (active.rows.length) throw new ConflictError('PERPL_CONNECTION_ALREADY_ACTIVE')
      if (row.environment !== this.config.environment || row.origin !== this.config.origin)
        throw new ConflictError('PERPL_ENROLLMENT_CONFIGURATION_CHANGED')
      const typed = validateEnrollmentPayload(
        row.typed_data,
        {
          chain_id: this.config.chainId,
          address: String(row.wallet_address),
          public_key: String(row.public_key),
          scope_mask: 3,
          label: 'EYELER',
          expires_at: new Date(row.expires_at as string).getTime(),
          ip_cidrs: row.ip_cidrs as string[],
          ...(row.builder_id == null
            ? {}
            : { builder_id: Number(row.builder_id), max_builder_fee_per_100k: Number(row.builder_fee_ceiling) }),
        },
        this.config.origin,
        this.now(),
      )
      let valid = false
      try {
        valid = await verifyTypedData({
          ...typed,
          address: walletAddress as Address,
          signature: signature as Hex,
        } as Parameters<typeof verifyTypedData>[0])
      } catch {
        valid = false
      }
      if (!valid) throw new AuthorizationError('WALLET_SIGNATURE_INVALID')
      await db.query(
        "UPDATE perpl_connections SET status='ENROLLING',pending_expires_at=$2,last_error=NULL WHERE id=$1",
        [id, new Date(this.now() + 300_000).toISOString()],
      )
      await db.query('COMMIT')
      committed = true
    } catch (error) {
      if (!committed) await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }

    const typed = typedData(row.typed_data)
    let enrolled: EnrolledKey
    try {
      const privateKey = Buffer.from(
        await this.custody.open(String(row.sealed_private_key), credentialContext(userId, id, 'private_key')),
        'hex',
      )
      let popSignature: string
      try {
        const digest = hashTypedData(typed as Parameters<typeof hashTypedData>[0])
        popSignature = `0x${Buffer.from(await signAsync(Buffer.from(digest.slice(2), 'hex'), privateKey)).toString('hex')}`
      } finally {
        privateKey.fill(0)
      }
      enrolled = await this.client.enroll({
        chain_id: this.config.chainId,
        address: walletAddress.toLowerCase(),
        typed_data: typed,
        mac: await this.custody.open(String(row.sealed_mac), credentialContext(userId, id, 'mac')),
        signature,
        pop_signature: popSignature,
      })
    } catch (error) {
      await this.markEnrollmentError(
        id,
        userId,
        error instanceof Error ? error.message : 'PERPL_ENROLLMENT_UNAVAILABLE',
      )
      throw error
    }
    const key = enrolled.api_key
    if (
      key.address.toLowerCase() !== walletAddress.toLowerCase() ||
      key.scope_mask !== 3 ||
      key.label !== row.label ||
      key.origin !== row.origin ||
      key.expires_at !== new Date(row.expires_at as string).getTime() ||
      key.builder_id !== (row.builder_id ?? undefined) ||
      key.max_builder_fee_per_100k !== (row.builder_fee_ceiling ?? undefined)
    ) {
      await this.markEnrollmentError(id, userId, 'ENROLLED_NOT_SAVED')
      throw new InfrastructureError('PERPL_ENROLLMENT_RESPONSE_MISMATCH')
    }
    try {
      const saved = await this.store.pool.query(
        "UPDATE perpl_connections SET status='ACTIVE',sealed_api_token=$2,sealed_mac=NULL,typed_data=NULL,pending_expires_at=NULL,last_error=NULL WHERE id=$1 AND user_id=$3 AND status='ENROLLING' RETURNING id",
        [id, await this.custody.seal(key.api_key, credentialContext(userId, id, 'api_token')), userId],
      )
      if (!saved.rows.length) throw new Error('ENROLLMENT_FINAL_STATE_CHANGED')
    } catch {
      try {
        await this.markEnrollmentError(id, userId, 'ENROLLED_NOT_SAVED')
      } catch {
        /* Keep ENROLLING and public key for manual Perpl revocation if database remains unavailable. */
      }
      throw new InfrastructureError('PERPL_ENROLLED_NOT_SAVED')
    }
    return { connectionId: id, status: 'ACTIVE' }
  }

  async disconnect(
    userId: string,
    id: string,
  ): Promise<{ connectionId: string; status: 'REVOKED'; perplKeyPageUrl: string }> {
    const result = await this.store.pool.query(
      `UPDATE perpl_connections SET status='REVOKED',sealed_private_key=NULL,sealed_api_token=NULL,sealed_mac=NULL,typed_data=NULL,shredded_at=now(),revoked_at=now()
      WHERE id=$1 AND user_id=$2 AND status!='ENROLLING' RETURNING id`,
      [id, userId],
    )
    if (!result.rows.length) {
      const current = await this.store.pool.query('SELECT status FROM perpl_connections WHERE id=$1 AND user_id=$2', [
        id,
        userId,
      ])
      if (current.rows[0]?.status === 'ENROLLING') throw new ConflictError('PERPL_ENROLLMENT_IN_PROGRESS')
      throw new NotFoundError('PERPL_CONNECTION_NOT_FOUND')
    }
    return { connectionId: id, status: 'REVOKED', perplKeyPageUrl: keyPage(this.config.environment) }
  }
}

export function createPerplEnrollmentService(
  store: PostgresStore,
  config: Config,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
  custody: KeyCustody | undefined = configuredKeyCustody(env, config.environment),
): PerplEnrollmentService | undefined {
  if (!custody) return undefined
  const settings = loadEnrollmentConfig(env, config)
  return new PerplEnrollmentService(
    store,
    settings,
    custody,
    new PerplEnrollmentClient(config.perplRestUrl, settings.origin, fetcher),
  )
}
