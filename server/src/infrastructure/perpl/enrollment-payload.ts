import { InfrastructureError } from '../../application/errors.js'
import type { EnrollmentPayloadRequest } from './enrollment-client.js'

export type EnrollmentTypedData = {
  domain: Record<string, unknown>
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

const fields = [
  ['signer', 'address'],
  ['statement', 'string'],
  ['publicKey', 'string'],
  ['scope', 'string'],
  ['label', 'string'],
  ['expiresAt', 'string'],
  ['ipCidrs', 'string'],
  ['origin', 'string'],
  ['builderId', 'string'],
  ['maxBuilderFeePer100K', 'string'],
  ['time', 'uint64'],
]
const domainFields = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
]
const keysEqual = (object: object, keys: string[]) =>
  Object.keys(object).sort().join('|') === [...keys].sort().join('|')

/** Fail closed if the venue asks the wallet to authorize anything beyond this request. */
export function validateEnrollmentPayload(
  value: unknown,
  request: EnrollmentPayloadRequest,
  origin: string,
  now: number,
): EnrollmentTypedData {
  try {
    const typed = value as EnrollmentTypedData
    if (!keysEqual(typed, ['domain', 'types', 'primaryType', 'message']) || typed.primaryType !== 'PerplRegisterApiKey')
      throw new Error()
    const { domain, message, types } = typed
    if (
      !keysEqual(types, ['EIP712Domain', 'PerplRegisterApiKey']) ||
      !keysEqual(
        message,
        fields.map(([name]) => name),
      ) ||
      !keysEqual(
        domain,
        domainFields.map(([name]) => name),
      )
    )
      throw new Error()
    const exactField = (actual: { name: string; type: string }, expected: string[]) =>
      keysEqual(actual, ['name', 'type']) && actual.name === expected[0] && actual.type === expected[1]
    if (
      types.PerplRegisterApiKey.length !== fields.length ||
      !fields.every((field, i) => exactField(types.PerplRegisterApiKey[i], field))
    )
      throw new Error()
    if (
      types.EIP712Domain.length !== domainFields.length ||
      !domainFields.every((field) => types.EIP712Domain.filter((actual) => exactField(actual, field)).length === 1)
    )
      throw new Error()
    if (
      domain.name !== 'perpl.xyz' ||
      domain.version !== '1' ||
      BigInt(String(domain.chainId)) !== BigInt(request.chain_id) ||
      domain.verifyingContract !== '0x0000000000000000000000000000000000000000' ||
      !/^0x[\da-f]{64}$/i.test(String(domain.salt))
    )
      throw new Error()
    const expected = {
      signer: request.address.toLowerCase(),
      scope: String(request.scope_mask),
      label: request.label,
      expiresAt: String(request.expires_at),
      origin,
      builderId: String(request.builder_id ?? 0),
      maxBuilderFeePer100K: String(request.max_builder_fee_per_100k ?? 0),
    }
    for (const [key, wanted] of Object.entries(expected)) {
      const actual = message[key]
      if (typeof actual !== 'string' || (key === 'signer' ? actual.toLowerCase() : actual) !== wanted) throw new Error()
    }
    // Perpl serializes the requested 32 Ed25519 public-key bytes as base64url
    // inside the signed payload, while the request uses hex.
    if (!/^0x[\da-f]{64}$/i.test(request.public_key)) throw new Error()
    const keyBytes = Buffer.from(request.public_key.slice(2), 'hex')
    const venueKey = keyBytes.toString('base64url')
    if (message.publicKey !== venueKey && message.publicKey !== request.public_key) throw new Error()
    // Nonempty CIDR serialization has not been verified against Perpl's payload contract.
    // Do not silently normalize potentially different signed restrictions.
    if (request.ip_cidrs?.length || message.ipCidrs !== '') throw new Error()
    const statement = String(message.statement)
    if (request.builder_id === undefined) {
      if (statement !== 'I authorize the creation of Perpl API key with the specified scope and parameters')
        throw new Error()
    } else {
      const terms = ` (builder code ${request.builder_id}) to place orders from this wallet and to charge a builder fee of up to ${((request.max_builder_fee_per_100k ?? 0) / 1000).toFixed(3)}% per order. This does not permit withdrawals.`
      if (!/^Authorize [\p{L}\p{N} ._-]+ \(builder code /u.test(statement) || !statement.endsWith(terms))
        throw new Error()
    }
    const stamp = BigInt(String(message.time))
    if (stamp < BigInt(now - 600_000) || stamp > BigInt(now + 30_000) || request.expires_at <= now) throw new Error()
    return typed
  } catch {
    throw new InfrastructureError('PERPL_ENROLLMENT_PAYLOAD_MISMATCH')
  }
}
