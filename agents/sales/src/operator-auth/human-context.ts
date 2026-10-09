import { randomBytes } from 'node:crypto';
import type { TrustedHumanContext } from '@r4/contracts';
import { OidcError, unverifiedNonce, type OidcVerifier, type VerifiedIdentity } from './oidc.js';
import type { AuthorizedOperator, OperatorRegistry } from './registry.js';

/**
 * (R4-J3D-S, ADR-033) The platform's `humanContext` seam, implemented with
 * a verified OIDC identity. It is the ONLY place in the Sales pack that
 * produces a TrustedHumanContext, and only after: a bearer ID token
 * verifies (signature, issuer, audience, expiry, freshness), its nonce is
 * an outstanding nonce of THIS process that is consumed now (single use:
 * a replayed token is refused), and its (issuer, subject) is an authorized
 * operator in the registry. Anything else yields null — the API then
 * answers `trusted_human_required`. No header other than
 * `Authorization: Bearer`, no body field and no email selects an identity.
 */
const NONCE_TTL_MS = 10 * 60_000;

/** Single-use login nonces of this process (issued before login, consumed once at decision time). */
export class NonceLedger {
  readonly #open = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(): string {
    const nonce = randomBytes(24).toString('base64url');
    this.#open.set(nonce, this.#now() + NONCE_TTL_MS);
    return nonce;
  }

  /** Whether the nonce is outstanding and unexpired (does not consume). */
  isOpen(nonce: string): boolean {
    const until = this.#open.get(nonce);
    return until !== undefined && until > this.#now();
  }

  /** Consumes the nonce: true exactly once per issued, unexpired nonce. */
  consume(nonce: string): boolean {
    const open = this.isOpen(nonce);
    this.#open.delete(nonce);
    return open;
  }
}

export interface OperatorAuthentication {
  readonly identity: VerifiedIdentity;
  readonly operator: AuthorizedOperator;
  readonly humanRef: string;
}

export interface OidcHumanContext {
  /** The seam itself (structurally `AppDependencies['humanContext']`). */
  readonly resolve: (request: { readonly headers: Readonly<Record<string, string | string[] | undefined>> }) => TrustedHumanContext | null;
  /** The same checks with a specific error, WITHOUT consuming the nonce (for operator feedback before deciding). */
  diagnose(token: string): OperatorAuthentication;
}

export function humanRefOf(operator: AuthorizedOperator): string {
  return `oidc:${operator.operatorRef}`;
}

export function createOidcHumanContext(options: { readonly verifier: OidcVerifier; readonly registry: OperatorRegistry; readonly nonces: NonceLedger; readonly nowS?: () => number }): OidcHumanContext {
  const nowS = options.nowS ?? (() => Math.floor(Date.now() / 1000));
  const authenticate = (token: string): OperatorAuthentication => {
    const nonce = unverifiedNonce(token);
    if (!nonce || !options.nonces.isOpen(nonce)) throw new OidcError('oidc_nonce_mismatch', 'the ID token does not carry an outstanding nonce of this login (replayed, expired or foreign)');
    const identity = options.verifier.verify(token, { nonce, nowS: nowS() });
    const operator = options.registry.find(identity.issuer, identity.subject);
    if (!operator) throw new OidcError('operator_not_registered', 'the authenticated identity is not an authorized operator');
    return { identity, operator, humanRef: humanRefOf(operator) };
  };
  return {
    diagnose: authenticate,
    resolve(request) {
      const header = request.headers.authorization;
      const value = Array.isArray(header) ? undefined : header;
      const match = value ? /^Bearer ([A-Za-z0-9_.-]+)$/.exec(value.trim()) : null;
      if (!match) return null;
      let auth: OperatorAuthentication;
      try {
        auth = authenticate(match[1]!);
      } catch {
        return null;
      }
      // Single use: the nonce is consumed by the first successful resolution only.
      if (!options.nonces.consume(auth.identity.nonce)) return null;
      return { humanRef: auth.humanRef, scopes: [...auth.operator.scopes] as TrustedHumanContext['scopes'], correlationId: 'operator-oidc' };
    },
  };
}
