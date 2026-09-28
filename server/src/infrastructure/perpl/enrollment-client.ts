import { ConflictError, InfrastructureError, KeelError, NotFoundError, ValidationError } from '../../application/errors.js'

export type EnrollmentPayloadRequest = {
  chain_id: number; address: string; public_key: string; scope_mask: 3; label: 'KEEL'; expires_at: number
  ip_cidrs?: string[]; builder_id?: number; max_builder_fee_per_100k?: number
}
export type EnrollmentPayload = { typed_data: unknown; mac: string }
export type EnrollmentRequest = { chain_id: number; address: string; typed_data: unknown; mac: string; signature: string; pop_signature: string }
export type EnrolledKey = { api_key: { api_key: string; address: string; scope_mask: number; label: string; origin: string; expires_at: number; builder_id?: number; max_builder_fee_per_100k?: number } }

export class PerplEnrollmentClient {
  constructor(private readonly baseUrl: string, private readonly origin: string, private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 10_000) {
    if (!/^https:\/\//.test(baseUrl)) throw new Error('INVALID_PERPL_REST_URL')
  }
  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: this.origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch { throw new InfrastructureError('PERPL_ENROLLMENT_UNAVAILABLE') }
    if (response.status === 400) throw new ValidationError('PERPL_ENROLLMENT_INVALID_REQUEST')
    if (response.status === 404) throw new NotFoundError('PERPL_ENROLLMENT_TARGET_NOT_FOUND')
    if (response.status === 409) throw new ConflictError('PERPL_ENROLLMENT_KEY_CONFLICT')
    if (response.status === 423) throw new KeelError('PERPL_ENROLLMENT_KEY_LIMIT', 423)
    if (!response.ok) throw new InfrastructureError('PERPL_ENROLLMENT_UNAVAILABLE')
    try { return await response.json() } catch { throw new InfrastructureError('PERPL_ENROLLMENT_INVALID_RESPONSE') }
  }
  async payload(input: EnrollmentPayloadRequest): Promise<EnrollmentPayload> {
    const value = await this.post('/v1/api-key/payload', input)
    if (!value || typeof value !== 'object' || !('typed_data' in value) || typeof (value as EnrollmentPayload).mac !== 'string') throw new InfrastructureError('PERPL_ENROLLMENT_INVALID_RESPONSE')
    return value as EnrollmentPayload
  }
  async enroll(input: EnrollmentRequest): Promise<EnrolledKey> {
    const value = await this.post('/v1/api-key/enroll', input)
    if (!value || typeof value !== 'object' || !('api_key' in value) || typeof (value as EnrolledKey).api_key?.api_key !== 'string') throw new InfrastructureError('PERPL_ENROLLMENT_INVALID_RESPONSE')
    return value as EnrolledKey
  }
}
