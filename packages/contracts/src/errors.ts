/**
 * Platform error taxonomy. `kind` is the coarse class used by transports (HTTP
 * status mapping); `code` is the stable, machine-readable reason.
 */
export type PlatformErrorKind =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'precondition'
  | 'unavailable'
  | 'internal';

export class PlatformError extends Error {
  readonly kind: PlatformErrorKind;
  readonly code: string;
  readonly details: unknown;

  constructor(kind: PlatformErrorKind, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PlatformError';
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}
