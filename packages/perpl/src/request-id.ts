const MAX_UINT64 = (1n << 64n) - 1n

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

// Quote only uint64 fields before JSON.parse, which otherwise rounds them as JS numbers.
export function parsePerplRequestIds(raw: string): unknown {
  return JSON.parse(raw.replace(/("(?:lfr|rq|r)"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"')) as unknown
}

export function orderFrameWithRequestId(frame: Record<string, unknown>, rq: string): string {
  requestId(rq)
  return JSON.stringify({ ...frame, rq: `__PERPL_RQ_${rq}__` }).replace(`"__PERPL_RQ_${rq}__"`, rq)
}
