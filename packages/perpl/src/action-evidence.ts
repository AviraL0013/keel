import { requestId } from './request-id.js'

/** Interpret stored evidence, never independently verify a receipt or infer a fill. */
export function storedActionEvidence(input: {
  kind: unknown
  status: unknown
  accountId: unknown
  venueReference: unknown
  venueProgress: unknown
}) {
  const progress =
    input.venueProgress && typeof input.venueProgress === 'object'
      ? (input.venueProgress as Record<string, unknown>)
      : {}
  const match = String(input.venueReference ?? '').match(/^([1-9]\d*):([1-9]\d*)(?::(0x[0-9a-fA-F]{64}|[1-9]\d*))?$/)
  const account = match ? Number(match[1]) : undefined
  let identityValid = false
  try {
    identityValid =
      !!match &&
      Number.isSafeInteger(account) &&
      account === Number(input.accountId) &&
      requestId(match[2]) > 0n &&
      (progress.requestId === undefined || progress.requestId === match[2])
  } catch {
    /* Invalid/overflowing request IDs are not evidence. */
  }
  const positiveBlock = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
  const executionBlock =
    identityValid && input.status === 'CONFIRMED' ? positiveBlock(progress.confirmedExecutionBlock) : undefined
  const transactionHash = match?.[3]?.startsWith('0x') ? match[3] : undefined
  const receiptBacked =
    identityValid &&
    input.kind === 'DEFEND' &&
    input.status === 'CONFIRMED' &&
    !!transactionHash &&
    !!executionBlock &&
    progress.requestId === match?.[2]
  return {
    accountId: identityValid ? account : undefined,
    requestId: identityValid ? match?.[2] : undefined,
    transactionHash,
    executionBlock,
    requestedLastExecBlock: positiveBlock(progress.requestedLastExecBlock),
    admittedLastExecBlock: positiveBlock(progress.effectiveLastExecBlock),
    level: !identityValid
      ? ('IDENTITY_UNVERIFIED' as const)
      : receiptBacked
        ? ('STORED_RECEIPT_BACKED' as const)
        : input.status === 'CONFIRMED'
          ? ('VENUE_RECONCILED' as const)
          : ('NOT_CONFIRMED' as const),
    receiptBacked,
  }
}
