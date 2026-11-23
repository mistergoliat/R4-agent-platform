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
  // One hash per reader (the console, the desk), comma-separated, so each one can be revoked alone.
  const hashes = tokenSha256.split(',');
  if (!hashes.every((h) => SHA256_HEX.test(h))) throw new Error('R4_SERVICE_READER_TOKEN_SHA256 must be 64 lowercase hex characters (comma-separated for several readers)');
  const expected = hashes.map((h) => Buffer.from(h, 'hex'));
  return (request) => {
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (!match) return false;
    const given = createHash('sha256').update(match[1]!).digest();
    return expected.some((e) => timingSafeEqual(given, e));
  };
}
