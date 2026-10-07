import type { PostgresStore } from '../database/postgres-store.js'
import { credentialContext, type CredentialContext } from './key-custody.js'

type Row = {
  id: string
  user_id: string
  sealed_private_key: string | null
  sealed_api_token: string | null
  sealed_mac: string | null
}
type Rewrapper = { rotate(sealed: string, context: CredentialContext): Promise<string>; envelopePrefix?: string }

/** Maintenance only. Compare-and-swap avoids resurrecting revoked or replaced credentials. */
export async function rotateCredentialBatch(
  store: PostgresStore,
  custody: Rewrapper,
  environment: 'mainnet' | 'testnet',
  options: { apply?: boolean; after?: string } = {},
) {
  const found = await store.pool.query<Row>(
    `SELECT id,user_id,sealed_private_key,sealed_api_token,sealed_mac FROM perpl_connections
    WHERE environment=$1 AND status IN ('ACTIVE','PENDING') AND revoked_at IS NULL
    AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 100`,
    [environment, options.after ?? null],
  )
  let rotated = 0,
    skipped = 0
  for (const row of found.rows) {
    if (!options.apply) continue
    const original = [row.sealed_private_key, row.sealed_api_token, row.sealed_mac]
    const prefix = custody.envelopePrefix ?? 'kms-v1:'
    if (original.some((value) => value !== null && !value.startsWith(prefix)))
      throw new Error('LEGACY_CREDENTIAL_REENROLLMENT_REQUIRED')
    const next = [...original]
    const fields = ['private_key', 'api_token', 'mac'] as const
    for (let i = 0; i < fields.length; i++)
      if (original[i] !== null)
        next[i] = await custody.rotate(original[i]!, credentialContext(row.user_id, row.id, fields[i]))
    const updated = await store.pool.query(
      `UPDATE perpl_connections SET sealed_private_key=$4,sealed_api_token=$5,sealed_mac=$6
      WHERE id=$1 AND user_id=$2 AND environment=$3 AND status IN ('ACTIVE','PENDING') AND revoked_at IS NULL
      AND sealed_private_key IS NOT DISTINCT FROM $7 AND sealed_api_token IS NOT DISTINCT FROM $8 AND sealed_mac IS NOT DISTINCT FROM $9 RETURNING id`,
      [row.id, row.user_id, environment, ...next, ...original],
    )
    if (updated.rows.length) rotated++
    else skipped++
  }
  return { scanned: found.rows.length, rotated, skipped, nextCursor: found.rows.at(-1)?.id }
}
