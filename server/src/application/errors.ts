export class KeelError extends Error {
  constructor(message: string, readonly statusCode = 500) {
    super(message)
    this.name = 'KeelError'
  }
}

export class ValidationError extends KeelError { constructor(message: string) { super(message, 400) } }
export class AuthenticationError extends KeelError { constructor(message = 'UNAUTHENTICATED') { super(message, 401) } }
export class AuthorizationError extends KeelError { constructor(message = 'FORBIDDEN') { super(message, 403) } }
export class NotFoundError extends KeelError { constructor(message: string) { super(message, 404) } }
export class ConflictError extends KeelError { constructor(message: string) { super(message, 409) } }
export class InfrastructureError extends KeelError { constructor(message: string) { super(message, 503) } }
