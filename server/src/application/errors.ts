export class EyelerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
  ) {
    super(message)
    this.name = 'EyelerError'
  }
}

export class ValidationError extends EyelerError {
  constructor(message: string) {
    super(message, 400)
  }
}
export class AuthenticationError extends EyelerError {
  constructor(message = 'UNAUTHENTICATED') {
    super(message, 401)
  }
}
export class AuthorizationError extends EyelerError {
  constructor(message = 'FORBIDDEN') {
    super(message, 403)
  }
}
export class NotFoundError extends EyelerError {
  constructor(message: string) {
    super(message, 404)
  }
}
export class ConflictError extends EyelerError {
  constructor(message: string) {
    super(message, 409)
  }
}
export class PolicyRejectedError extends ConflictError {
  readonly details: {
    requestedAction: ActionKind
    state: Decision['state']
    action: Decision['action']
    reasonCodes: string[]
    reasons: string[]
    evaluatedAt: string
  }
  constructor(requestedAction: ActionKind, decision: Decision) {
    super('POLICY_REJECTED')
    this.details = {
      requestedAction,
      state: decision.state,
      action: decision.action,
      reasonCodes: decision.reasonCodes,
      reasons: decision.humanReadableReasons,
      evaluatedAt: decision.createdAt,
    }
  }
}
export class InfrastructureError extends EyelerError {
  constructor(message: string) {
    super(message, 503)
  }
}
import type { ActionKind, Decision } from '../../../packages/domain/src/index.js'
