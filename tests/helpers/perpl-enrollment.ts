import type { EnrollmentPayloadRequest } from '../../server/src/infrastructure/perpl/enrollment-client.js'

// Schema observed from Perpl's unsigned /v1/api-key/payload on 2026-10-06.
// All keys, salt and addresses here are synthetic test inputs.
export function perplEnrollmentPayload(request: EnrollmentPayloadRequest, origin: string, now: number) {
  return {
    domain: {
      name: 'perpl.xyz',
      version: '1',
      chainId: `0x${request.chain_id.toString(16)}`,
      verifyingContract: '0x0000000000000000000000000000000000000000',
      salt: `0x${'aa'.repeat(32)}`,
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      PerplRegisterApiKey: [
        { name: 'signer', type: 'address' },
        { name: 'statement', type: 'string' },
        { name: 'publicKey', type: 'string' },
        { name: 'scope', type: 'string' },
        { name: 'label', type: 'string' },
        { name: 'expiresAt', type: 'string' },
        { name: 'ipCidrs', type: 'string' },
        { name: 'origin', type: 'string' },
        { name: 'builderId', type: 'string' },
        { name: 'maxBuilderFeePer100K', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
    },
    primaryType: 'PerplRegisterApiKey',
    message: {
      signer: request.address,
      statement:
        request.builder_id === undefined
          ? 'I authorize the creation of Perpl API key with the specified scope and parameters'
          : `Authorize Eyeler (builder code ${request.builder_id}) to place orders from this wallet and to charge a builder fee of up to 0.000% per order. This does not permit withdrawals.`,
      publicKey: request.public_key,
      scope: String(request.scope_mask),
      label: request.label,
      expiresAt: String(request.expires_at),
      ipCidrs: (request.ip_cidrs ?? []).join(','),
      origin,
      builderId: String(request.builder_id ?? 0),
      maxBuilderFeePer100K: String(request.max_builder_fee_per_100k ?? 0),
      time: `0x${now.toString(16)}`,
    },
  }
}
