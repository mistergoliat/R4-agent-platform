import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * ADR-049: a service credential that may only READ the operator plane (the
 * R4 console's backend). It never builds a TrustedHumanContext: every write
 * still requires an authenticated human.
 *
 * The host stores only the SHA-256 of the token (`R4_SERVICE_READER_TOKEN_SHA256`).
 * Absent → no service reader exists (fail closed).
 */
export type ServiceReader = (request: FastifyRequest) => boolean;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{32,512})$/;

export function createServiceReader(tokenSha256: string | undefined): ServiceReader | undefined {
  if (tokenSha256 === undefined) return undefined;
  if (!SHA256_HEX.test(tokenSha256)) throw new Error('R4_SERVICE_READER_TOKEN_SHA256 must be 64 lowercase hex characters');
  const expected = Buffer.from(tokenSha256, 'hex');
  return (request) => {
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (!match) return false;
    return timingSafeEqual(createHash('sha256').update(match[1]!).digest(), expected);
  };
}
