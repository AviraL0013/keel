const MAX_UINT64 = (1n << 64n) - 1n
const SERIAL_MODULUS = 1n << 32n
const SERIAL_HALF_RANGE = 1n << 31n

export function requestId(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('PERPL_REQUEST_ID_INVALID')
    return BigInt(value)
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('PERPL_REQUEST_ID_INVALID')
  const parsed = BigInt(value)
  if (parsed > MAX_UINT64) throw new Error('PERPL_REQUEST_ID_OVERFLOW')
  return parsed
}

/** Exchange forwarding compares the low words using int32(rq - last).
 * Evidence and deployed implementation hash: docs/perpl-forwarded-request-ids.md.
 */
export function forwardedRequestDelta(candidate: string, baseline: string): bigint {
  return BigInt.asIntN(32, requestId(candidate) - requestId(baseline))
}

export function validForwardedRequestId(candidate: string, baseline: string): boolean {
  return requestId(candidate) > requestId(baseline) && forwardedRequestDelta(candidate, baseline) > 0n
}

/** Smallest unused uint64 above the durable high-water mark in the venue's serial window. */
export function nextForwardedRequestId(baseline: string, highWater: string): string {
  const last = requestId(baseline), highest = requestId(highWater)
  let next = (highest > last ? highest : last) + 1n
  const delta = BigInt.asUintN(32, next - last)
  if (delta === 0n) next += 1n
  else if (delta >= SERIAL_HALF_RANGE) next += SERIAL_MODULUS - delta + 1n
  const selected = requestId(next.toString()).toString()
  if (!validForwardedRequestId(selected, baseline)) throw new Error('PERPL_REQUEST_ID_ALLOCATION_INVALID')
  return selected
}

// Quote only uint64 fields before JSON.parse, which otherwise rounds them as JS numbers.
export function parsePerplRequestIds(raw: string): unknown {
  return JSON.parse(raw.replace(/("(?:lfr|rq|r)"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"')) as unknown
}

export function orderFrameWithRequestId(frame: Record<string, unknown>, rq: string): string {
  requestId(rq)
  return JSON.stringify({ ...frame, rq: `__PERPL_RQ_${rq}__` }).replace(`"__PERPL_RQ_${rq}__"`, rq)
}
