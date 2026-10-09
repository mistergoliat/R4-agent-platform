import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createServer, type Server } from 'node:http';

/**
 * A local, standards-conformant OpenID Connect issuer for tests (loopback
 * only): discovery, JWKS (RS256), an authorization endpoint that "signs in"
 * the configured test user and redirects with code + state, and a token
 * endpoint that enforces single-use codes, the client id, the redirect URI
 * and PKCE S256 before minting an RS256 ID token with the login's nonce.
 *
 * `mint` produces tokens directly (valid or deliberately wrong) for the
 * negative matrix. Nothing here is used outside tests.
 */
export interface TestLogin {
  readonly sub: string;
  readonly email?: string;
  readonly hd?: string;
  readonly emailVerified?: boolean;
}

type Claims = Record<string, unknown>;

export interface MintOptions {
  readonly claims?: Claims;
  /** Sign with an attacker key under the issuer's kid, with no signature, or with HMAC. */
  readonly forge?: 'attacker-key' | 'alg-none' | 'hs256' | 'unknown-kid';
}

export class FakeOidcProvider {
  readonly clientId = 'r4-operator-test-client';
  readonly kid = 'test-key-1';
  login: TestLogin | null = null;
  /** Applied to every ID token minted by the token endpoint (e.g. a stale `iat`). */
  tokenClaims: Claims = {};
  tokenForge: MintOptions['forge'] | undefined;
  authorizeRequests = 0;
  readonly #key: { privateKey: KeyObject; publicKey: KeyObject };
  readonly #attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly #codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; login: TestLogin }>();
  #server: Server | null = null;
  #port = 0;

  constructor() {
    this.#key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  }

  get issuer(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', this.issuer);
      const json = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return json(200, { issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` });
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        return json(200, { keys: [{ ...this.#key.publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' }] });
      }
      if (request.method === 'GET' && url.pathname === '/authorize') {
        this.authorizeRequests += 1;
        const q = url.searchParams;
        const redirect = new URL(q.get('redirect_uri') ?? 'http://127.0.0.1/');
        const state = q.get('state') ?? '';
        if (q.get('client_id') !== this.clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || redirect.hostname !== '127.0.0.1') return json(400, { error: 'invalid_request' });
        if (!this.login) {
          redirect.search = new URLSearchParams({ error: 'access_denied', state }).toString();
        } else {
          const code = randomBytes(16).toString('hex');
          this.#codes.set(code, { nonce: q.get('nonce') ?? '', challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri') ?? '', login: this.login });
          redirect.search = new URLSearchParams({ code, state }).toString();
        }
        return response.writeHead(302, { location: redirect.toString() }).end();
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        let raw = '';
        request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
        request.on('end', () => {
          const form = new URLSearchParams(raw);
          const entry = this.#codes.get(form.get('code') ?? '');
          this.#codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          if (!entry || form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== this.clientId || form.get('redirect_uri') !== entry.redirectUri || createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) {
            return json(400, { error: 'invalid_grant' });
          }
          const l = entry.login;
          const idToken = this.mint({
            claims: { sub: l.sub, nonce: entry.nonce, ...(l.email ? { email: l.email } : {}), email_verified: l.emailVerified ?? true, ...(l.hd ? { hd: l.hd } : {}), ...this.tokenClaims },
            ...(this.tokenForge ? { forge: this.tokenForge } : {}),
          });
          return json(200, { access_token: 'unused', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
        });
        return undefined;
      }
      return json(404, { error: 'not_found' });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.#port = (this.#server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  /** An ID token for this issuer and client (defaults: valid, fresh), optionally forged. */
  mint(options: MintOptions = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: this.issuer, aud: this.clientId, azp: this.clientId, iat: now, exp: now + 3600, ...options.claims };
    const forge = options.forge;
    const header = { alg: forge === 'alg-none' ? 'none' : forge === 'hs256' ? 'HS256' : 'RS256', kid: forge === 'unknown-kid' ? 'not-published' : this.kid, typ: 'JWT' };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    if (forge === 'alg-none') return `${h}.${p}.`;
    if (forge === 'hs256') return `${h}.${p}.${createHash('sha256').update(`${h}.${p}secret`).digest('base64url')}`;
    const key = forge === 'attacker-key' ? this.#attacker.privateKey : this.#key.privateKey;
    return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
  }

  /** The operator's browser: follows the authorization URL to the issuer, then its redirect to the loopback callback. */
  readonly browser = async (url: string): Promise<void> => {
    const issued = await fetch(url, { redirect: 'manual' });
    const location = issued.headers.get('location');
    if (location) await fetch(location);
  };
}

/** A free loopback TCP port (for the login's redirect listener). */
export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
