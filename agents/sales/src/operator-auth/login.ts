import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { OidcError, type OidcVerifier } from './oidc.js';

/**
 * (R4-J3D-S, ADR-033) Operator sign-in for a command-line client: OAuth 2.0
 * Authorization Code with PKCE (S256), `state` and OIDC `nonce`, redirected
 * to a loopback listener (RFC 8252 §7.3; Google "Desktop app" clients).
 *
 *   state   random per login, compared in constant time on the callback:
 *           a callback this login did not start is refused (CSRF / mix-up)
 *   PKCE    the code is useless without this process's verifier
 *   nonce   issued by the caller's NonceLedger, bound into the ID token
 *   one     the listener accepts exactly one callback on one path, then closes
 *   timeout the login expires (default 5 minutes)
 *
 * The listener binds 127.0.0.1 only. On a remote host the operator forwards
 * the port (`ssh -L <port>:127.0.0.1:<port>`) and opens the printed URL in
 * their own browser. The ID token never leaves this process.
 */
const CALLBACK_PATH = '/oidc/callback';

export interface LoginOptions {
  readonly verifier: OidcVerifier;
  readonly nonce: string;
  /** Shows the authorization URL to the operator (prints it; tests follow it). */
  readonly openUrl: (url: string) => void | Promise<void>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Runs one sign-in and returns the raw ID token (to be verified by the caller). */
export async function loopbackLogin(options: LoginOptions): Promise<string> {
  const { config, discovery } = options.verifier;
  const state = b64(24);
  const codeVerifier = b64(48);
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const redirectUri = `http://127.0.0.1:${config.redirectPort}${CALLBACK_PATH}`;
  const url = new URL(discovery.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, scope: 'openid email', state, nonce: options.nonce,
    code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account', max_age: String(config.maxAuthAgeS),
    ...(config.hostedDomain ? { hd: config.hostedDomain } : {}),
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let server: Server | null = null;
    const finish = (error: OidcError | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // One callback only: stop listening and drop every (keep-alive) connection now.
      server?.close();
      server?.closeAllConnections();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new OidcError('oidc_login_timeout', 'the sign-in was not completed in time')), options.timeoutMs ?? 5 * 60_000);
    server = createServer((request, response) => {
      const at = new URL(request.url ?? '/', redirectUri);
      if (request.method !== 'GET' || at.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { connection: 'close' }).end();
        return;
      }
      const returned = at.searchParams.get('state') ?? '';
      const error = at.searchParams.get('error');
      const received = at.searchParams.get('code');
      const ok = sameSecret(returned, state) && !error && received;
      const outcome: [OidcError | null, string?] = !sameSecret(returned, state)
        ? [new OidcError('oidc_state_mismatch', 'the sign-in callback does not belong to this login (state mismatch)')]
        : error || !received
          ? [new OidcError('oidc_login_denied', `the identity provider did not authorize the sign-in${error ? ` (${error.slice(0, 64)})` : ''}`)]
          : [null, received];
      // Settle once the answer is flushed to the browser (settling closes every connection).
      response.once('finish', () => finish(...outcome));
      response.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }).end(ok ? 'Sign-in received. You can close this window.' : 'Sign-in refused.');
    });
    server.on('error', () => finish(new OidcError('oidc_login_unavailable', `cannot listen on 127.0.0.1:${config.redirectPort}`)));
    server.listen(config.redirectPort, '127.0.0.1', () => {
      void Promise.resolve(options.openUrl(url.toString())).catch(() => undefined);
    });
  });

  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.clientId, code_verifier: codeVerifier, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) });
  const response = await (options.fetchImpl ?? fetch)(discovery.tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString(), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new OidcError('oidc_token_exchange_failed', `the token endpoint answered ${response.status}`);
  const tokens = (await response.json()) as { id_token?: unknown };
  if (typeof tokens.id_token !== 'string') throw new OidcError('oidc_token_exchange_failed', 'the token endpoint returned no ID token');
  return tokens.id_token;
}
