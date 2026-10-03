/**
 * Transport-agnostic domain errors. The HTTP layer maps `kind` to a status code
 * (see ProblemDetailsFilter); the Kafka consumer treats them as non-retryable.
 */
export type DomainErrorKind = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'UNPROCESSABLE' | 'UNAVAILABLE';

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const Errors = {
  validation: (code: string, message: string, details?: Record<string, unknown>) =>
    new DomainError('VALIDATION', code, message, details),
  notFound: (code: string, message: string, details?: Record<string, unknown>) =>
    new DomainError('NOT_FOUND', code, message, details),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new DomainError('CONFLICT', code, message, details),
  unprocessable: (code: string, message: string, details?: Record<string, unknown>) =>
    new DomainError('UNPROCESSABLE', code, message, details),
  unavailable: (code: string, message: string, details?: Record<string, unknown>) =>
    new DomainError('UNAVAILABLE', code, message, details),
};
