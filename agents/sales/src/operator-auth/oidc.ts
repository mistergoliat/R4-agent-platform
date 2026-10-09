import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

/**
 * (R4-J3D-S, ADR-033) OpenID Connect ID-token verification for human
 * operators. The identity is the IdP's: an ID token is accepted only when
 *
 *   alg        is RS256 (no `none`, no HMAC: a shared secret is not an identity proof)
 *   signature  verifies against a key of the issuer's published JWKS (by `kid`)
 *   iss        is the configured issuer (discovery must agree)
 *   aud        contains the configured client id (and `azp`, when present, is it)
 *   exp        has not passed; `iat` is not in the future and not older than the
 *              maximum authentication age (a fresh login per decision)
 *   nonce      equals the nonce this client generated for this login
 *   email_verified / hd   are true / the configured Workspace domain (defense in
 *              depth; authorization is keyed on the stable (iss, sub), never on email)
 *
 * Keys are loaded asynchronously (`discover`), verification is synchronous:
 * the platform's `humanContext` seam is a synchronous function.
 */
export const ALLOWED_ALGORITHMS: readonly string[] = Object.freeze(['RS256']);
const CLOCK_SKEW_S = 60;
const GOOGLE_ISSUER = 'https://accounts.google.com';

export class OidcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
  }
}

export interface OperatorAuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  /** Installed-app client secret (not confidential for a desktop/CLI client); never logged. */
  readonly clientSecret: string | null;
  /** Google Workspace domain (`hd`) the operator account must belong to; required for Google. */
  readonly hostedDomain: string | null;
  readonly registryFile: string;
  /** Loopback port of the authorization-code redirect (RFC 8252 §7.3). */
  readonly redirectPort: number;
  /** How old the authentication may be (seconds since `iat`). */
  readonly maxAuthAgeS: number;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** HTTPS only, except a loopback issuer (local test issuers). */
export function assertSecureUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcError('oidc_config_invalid', `${what} is not a URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new OidcError('oidc_config_invalid', `${what} must use https`);
  return url;
}

/** Reads the operator-auth configuration from the process environment (fails closed). */
export function loadOperatorAuthConfig(env: Readonly<Record<string, string | undefined>>): OperatorAuthConfig {
  const problems: string[] = [];
  const issuer = env.R4_OPERATOR_OIDC_ISSUER?.trim() ?? '';
  const clientId = env.R4_OPERATOR_OIDC_CLIENT_ID?.trim() ?? '';
  const registryFile = env.R4_OPERATOR_REGISTRY_FILE?.trim() ?? '';
  if (!issuer) problems.push('R4_OPERATOR_OIDC_ISSUER is required (e.g. https://accounts.google.com)');
  if (!clientId) problems.push('R4_OPERATOR_OIDC_CLIENT_ID is required');
  if (!registryFile) problems.push('R4_OPERATOR_REGISTRY_FILE is required (the authorized operator registry)');
  const hostedDomain = env.R4_OPERATOR_OIDC_HOSTED_DOMAIN?.trim() || null;
  if (issuer === GOOGLE_ISSUER && !hostedDomain) problems.push('R4_OPERATOR_OIDC_HOSTED_DOMAIN is required with Google (only Workspace accounts of that domain)');
  const port = Number(env.R4_OPERATOR_OIDC_REDIRECT_PORT ?? '8765');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) problems.push('R4_OPERATOR_OIDC_REDIRECT_PORT must be an integer 1024-65535');
  const maxAge = Number(env.R4_OPERATOR_OIDC_MAX_AUTH_AGE_S ?? '300');
  if (!Number.isInteger(maxAge) || maxAge < 30 || maxAge > 900) problems.push('R4_OPERATOR_OIDC_MAX_AUTH_AGE_S must be an integer 30-900');
  if (problems.length > 0) throw new OidcError('operator_auth_config_incomplete', `operator authentication is not configured:\n- ${problems.join('\n- ')}`);
  assertSecureUrl(issuer, 'R4_OPERATOR_OIDC_ISSUER');
  return { issuer, clientId, clientSecret: env.R4_OPERATOR_OIDC_CLIENT_SECRET?.trim() || null, hostedDomain, registryFile, redirectPort: port, maxAuthAgeS: maxAge };
}

export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

/** The claims R4 relies on after verification. */
export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly hostedDomain: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

type Json = Record<string, unknown>;

function b64json(part: string, what: string): Json {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Json;
  } catch {
    throw new OidcError('oidc_token_malformed', `the ID token ${what} is not a JSON object`);
  }
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<Json> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new OidcError('oidc_discovery_failed', `GET ${new URL(url).origin}${new URL(url).pathname} answered ${response.status}`);
  return (await response.json()) as Json;
}

/** Issuers whose tokens are accepted for a configured issuer (Google documents both forms of its `iss`). */
function acceptedIssuers(issuer: string): readonly string[] {
  return issuer === GOOGLE_ISSUER ? [GOOGLE_ISSUER, 'accounts.google.com'] : [issuer];
}

export class OidcVerifier {
  readonly config: OperatorAuthConfig;
  readonly discovery: OidcDiscovery;
  readonly #keys: ReadonlyMap<string, KeyObject>;

  private constructor(config: OperatorAuthConfig, discovery: OidcDiscovery, keys: ReadonlyMap<string, KeyObject>) {
    this.config = config;
    this.discovery = discovery;
    this.#keys = keys;
  }

  /** Discovery document + JWKS of the configured issuer (both must be served securely and agree on the issuer). */
  static async discover(config: OperatorAuthConfig, fetchImpl: typeof fetch = fetch): Promise<OidcVerifier> {
    const doc = await getJson(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, fetchImpl);
    if (doc.issuer !== config.issuer) throw new OidcError('oidc_discovery_failed', 'the discovery document names a different issuer');
    const discovery: OidcDiscovery = {
      issuer: config.issuer,
      authorizationEndpoint: assertSecureUrl(String(doc.authorization_endpoint), 'authorization_endpoint').toString(),
      tokenEndpoint: assertSecureUrl(String(doc.token_endpoint), 'token_endpoint').toString(),
      jwksUri: assertSecureUrl(String(doc.jwks_uri), 'jwks_uri').toString(),
    };
    const jwks = await getJson(discovery.jwksUri, fetchImpl);
    const keys = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(jwks.keys) ? (jwks.keys as Json[]) : []) {
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig') || (jwk.alg !== undefined && (typeof jwk.alg !== 'string' || !ALLOWED_ALGORITHMS.includes(jwk.alg)))) continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: String(jwk.n), e: String(jwk.e) }, format: 'jwk' }));
      } catch {
        // An unusable key is skipped; a token signed with it then fails as unknown_key.
      }
    }
    if (keys.size === 0) throw new OidcError('oidc_discovery_failed', 'the issuer publishes no usable RS256 signing key');
    return new OidcVerifier(config, discovery, keys);
  }

  /** Verifies one ID token for the expected nonce at `nowS` (seconds). Throws OidcError with a specific code. */
  verify(token: string, expected: { readonly nonce: string; readonly nowS?: number }): VerifiedIdentity {
    const now = expected.nowS ?? Math.floor(Date.now() / 1000);
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new OidcError('oidc_token_malformed', 'the ID token is not a compact JWS');
    const [h, p, s] = parts as [string, string, string];
    const header = b64json(h, 'header');
    if (typeof header.alg !== 'string' || !ALLOWED_ALGORITHMS.includes(header.alg)) throw new OidcError('oidc_algorithm_rejected', `ID token algorithm ${String(header.alg)} is not accepted`);
    const key = typeof header.kid === 'string' ? this.#keys.get(header.kid) : undefined;
    if (!key) throw new OidcError('oidc_unknown_key', 'the ID token is not signed with a published key of the issuer');
    if (!verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new OidcError('oidc_signature_invalid', 'the ID token signature does not verify');
    const claims = b64json(p, 'payload');
    if (typeof claims.iss !== 'string' || !acceptedIssuers(this.config.issuer).includes(claims.iss)) throw new OidcError('oidc_issuer_mismatch', 'the ID token was issued by another issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.clientId)) throw new OidcError('oidc_audience_mismatch', 'the ID token was issued for another client');
    if (claims.azp !== undefined && claims.azp !== this.config.clientId) throw new OidcError('oidc_audience_mismatch', 'the ID token was authorized for another client');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S <= now) throw new OidcError('oidc_token_expired', 'the ID token has expired');
    if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_S > now) throw new OidcError('oidc_token_not_yet_valid', 'the ID token is issued in the future');
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) throw new OidcError('oidc_token_not_yet_valid', 'the ID token is not valid yet');
    if (now - claims.iat > this.config.maxAuthAgeS) throw new OidcError('oidc_authentication_stale', 'the authentication is too old; sign in again');
    if (typeof claims.nonce !== 'string' || claims.nonce.length < 16 || claims.nonce !== expected.nonce) throw new OidcError('oidc_nonce_mismatch', 'the ID token does not carry the nonce of this login');
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255) throw new OidcError('oidc_token_malformed', 'the ID token has no subject');
    if (claims.email_verified !== undefined && claims.email_verified !== true) throw new OidcError('oidc_email_unverified', 'the operator account email is not verified');
    const hd = typeof claims.hd === 'string' ? claims.hd : null;
    if (this.config.hostedDomain && hd !== this.config.hostedDomain) throw new OidcError('oidc_domain_mismatch', 'the operator account does not belong to the configured Workspace domain');
    return {
      issuer: this.config.issuer, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : null, hostedDomain: hd,
      issuedAt: claims.iat, expiresAt: claims.exp, nonce: claims.nonce,
    };
  }
}

/** The nonce claim of a token, read WITHOUT verification (only to find the ledger entry; verification follows). */
export function unverifiedNonce(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const value = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Json).nonce;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}
