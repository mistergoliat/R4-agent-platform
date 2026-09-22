import { z } from 'zod';
import { isPlatformError, type PlatformErrorKind } from '@r4/contracts';

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly correlationId: string;
  };
}

const STATUS_BY_KIND: Readonly<Record<PlatformErrorKind, number>> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  precondition: 422,
  unavailable: 503,
  internal: 500,
};

/**
 * Maps any error to a stable envelope. Internal failures never leak their
 * message; the correlation id links the response to the server-side log.
 */
export function toErrorResponse(error: unknown, correlationId: string): { status: number; body: ErrorBody; internal: boolean } {
  if (isPlatformError(error)) {
    const status = STATUS_BY_KIND[error.kind];
    const internal = error.kind === 'internal';
    return {
      status,
      internal,
      body: {
        error: {
          code: internal ? 'internal_error' : error.code,
          message: internal ? 'internal error' : error.message,
          ...(internal || error.details === undefined ? {} : { details: error.details }),
          correlationId,
        },
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      internal: false,
      body: {
        error: {
          code: 'validation_failed',
          message: z.prettifyError(error),
          details: { issues: error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) },
          correlationId,
        },
      },
    };
  }
  // Fastify's own client errors (malformed JSON, body too large, wrong content type).
  const statusCode = (error as { statusCode?: number } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    const fastifyCode = (error as { code?: string }).code;
    return {
      status: statusCode,
      internal: false,
      body: {
        error: {
          code: statusCode === 413 ? 'payload_too_large' : statusCode === 415 ? 'unsupported_media_type' : 'invalid_request',
          message: error instanceof Error ? error.message : 'invalid request',
          ...(fastifyCode ? { details: { transportCode: fastifyCode } } : {}),
          correlationId,
        },
      },
    };
  }
  return { status: 500, internal: true, body: { error: { code: 'internal_error', message: 'internal error', correlationId } } };
}
