import type { FastifyRequest } from 'fastify';
import type { Principal } from '@r4/contracts';

/**
 * Resolves who is calling. Identity is platform authority: it is derived from
 * the authenticated transport, never from the request body.
 *
 * R4-B ships no authentication (the API must only be bound to loopback / a
 * private network). The seam is here so an authenticating resolver can be
 * dropped in without touching routes or the Task Runtime.
 */
export type PrincipalResolver = (request: FastifyRequest) => Principal;

export const unauthenticatedPrincipalResolver: PrincipalResolver = () => ({
  kind: 'unauthenticated',
  ref: 'anonymous',
});
