import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NonceLedger,
  OidcVerifier,
  OperatorRegistry,
  assertSecureUrl,
  createOidcHumanContext,
  loadOperatorAuthConfig,
  loadOperatorRegistry,
  loopbackLogin,
  type OperatorAuthConfig,
} from '../../../agents/sales/src/operator-auth/index.js';
import { parseOperatorCommand } from '../../../agents/sales/src/cli/operator-command.js';
import { FakeOidcProvider, freePort } from '../../support/oidc-provider.js';

let idp: FakeOidcProvider;
let config: OperatorAuthConfig;
let verifier: OidcVerifier;
const NONCE = 'n'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);

const registryDoc = (issuer: string) => ({
  version: 1,
  operators: [
    { operatorRef: 'ops.approver', issuer, subject: 'sub-approver', roles: ['approver'] },
    { operatorRef: 'ops.viewer', issuer, subject: 'sub-viewer', roles: [] },
    { operatorRef: 'ops.gone', issuer, subject: 'sub-gone', roles: ['approver'], disabled: true },
  ],
});

beforeAll(async () => {
  idp = new FakeOidcProvider();
  await idp.start();
  config = { issuer: idp.issuer, clientId: idp.clientId, clientSecret: null, hostedDomain: 'pesaschile.test', registryFile: 'unused', redirectPort: await freePort(), maxAuthAgeS: 300 };
  verifier = await OidcVerifier.discover(config);
});

afterAll(async () => {
  await idp?.stop();
});

const good = (claims: Record<string, unknown> = {}) => idp.mint({ claims: { sub: 'sub-approver', nonce: NONCE, email: 'ops@pesaschile.test', email_verified: true, hd: 'pesaschile.test', ...claims } });

describe('ID token verification', () => {
  it('accepts a correctly signed, fresh token for this client, issuer, nonce and domain', () => {
    expect(verifier.verify(good(), { nonce: NONCE })).toMatchObject({ issuer: idp.issuer, subject: 'sub-approver', email: 'ops@pesaschile.test', hostedDomain: 'pesaschile.test', nonce: NONCE });
  });

  it.each([
    ['another signing key under the issuer kid', () => idp.mint({ claims: { sub: 'x', nonce: NONCE, hd: 'pesaschile.test' }, forge: 'attacker-key' }), 'oidc_signature_invalid'],
    ['alg none', () => idp.mint({ claims: { sub: 'x', nonce: NONCE }, forge: 'alg-none' }), 'oidc_token_malformed'],
    ['HMAC algorithm', () => idp.mint({ claims: { sub: 'x', nonce: NONCE }, forge: 'hs256' }), 'oidc_algorithm_rejected'],
    ['unpublished kid', () => idp.mint({ claims: { sub: 'x', nonce: NONCE }, forge: 'unknown-kid' }), 'oidc_unknown_key'],
    ['another issuer', () => good({ iss: 'https://evil.example' }), 'oidc_issuer_mismatch'],
    ['another audience', () => good({ aud: 'someone-else' }), 'oidc_audience_mismatch'],
    ['another authorized party', () => good({ azp: 'someone-else' }), 'oidc_audience_mismatch'],
    ['expired', () => good({ iat: now() - 7200, exp: now() - 3600 }), 'oidc_token_expired'],
    ['issued in the future', () => good({ iat: now() + 600 }), 'oidc_token_not_yet_valid'],
    ['stale authentication (older than the max age)', () => good({ iat: now() - 900 }), 'oidc_authentication_stale'],
    ['another nonce', () => good({ nonce: 'x'.repeat(32) }), 'oidc_nonce_mismatch'],
    ['no nonce', () => good({ nonce: undefined }), 'oidc_nonce_mismatch'],
    ['unverified email', () => good({ email_verified: false }), 'oidc_email_unverified'],
    ['another Workspace domain', () => good({ hd: 'gmail.com' }), 'oidc_domain_mismatch'],
    ['no Workspace domain (consumer account)', () => good({ hd: undefined }), 'oidc_domain_mismatch'],
    ['garbage', () => 'not.a.token!', 'oidc_token_malformed'],
  ])('refuses %s', (_name, token, code) => {
    expect(() => verifier.verify(token(), { nonce: NONCE })).toThrow(expect.objectContaining({ code }));
  });

  it('discovery must be served securely and name the configured issuer', async () => {
    expect(() => assertSecureUrl('http://idp.example.com', 'x')).toThrow(expect.objectContaining({ code: 'oidc_config_invalid' }));
    expect(assertSecureUrl('http://127.0.0.1:1/', 'x').hostname).toBe('127.0.0.1');
    await expect(OidcVerifier.discover({ ...config, issuer: `${idp.issuer}/other` })).rejects.toMatchObject({ code: 'oidc_discovery_failed' });
  });

  it('configuration fails closed, and Google requires a Workspace domain', () => {
    expect(() => loadOperatorAuthConfig({})).toThrow(expect.objectContaining({ code: 'operator_auth_config_incomplete' }));
    expect(() => loadOperatorAuthConfig({ R4_OPERATOR_OIDC_ISSUER: 'https://accounts.google.com', R4_OPERATOR_OIDC_CLIENT_ID: 'c', R4_OPERATOR_REGISTRY_FILE: 'f' })).toThrow(/HOSTED_DOMAIN/);
    expect(loadOperatorAuthConfig({ R4_OPERATOR_OIDC_ISSUER: 'https://accounts.google.com', R4_OPERATOR_OIDC_CLIENT_ID: 'c', R4_OPERATOR_REGISTRY_FILE: 'f', R4_OPERATOR_OIDC_HOSTED_DOMAIN: 'pesaschile.cl' })).toMatchObject({ redirectPort: 8765, maxAuthAgeS: 300, clientSecret: null });
  });
});

describe('operator registry (RBAC on the stable identity)', () => {
  it('authorizes by (issuer, subject) only; roles map to scopes; disabled and unknown identities are not operators', () => {
    const registry = new OperatorRegistry(registryDoc(idp.issuer));
    expect(registry.find(idp.issuer, 'sub-approver')).toEqual({ operatorRef: 'ops.approver', roles: ['approver'], scopes: ['approval.decide'] });
    expect(registry.find(idp.issuer, 'sub-viewer')).toEqual({ operatorRef: 'ops.viewer', roles: [], scopes: [] });
    expect(registry.find(idp.issuer, 'sub-gone')).toBeNull();
    expect(registry.find('https://other.example', 'sub-approver')).toBeNull();
    expect(registry.find(idp.issuer, 'ops@pesaschile.test')).toBeNull();
  });

  it('refuses an invalid or ambiguous registry', () => {
    expect(() => new OperatorRegistry({ version: 1, operators: [{ operatorRef: 'a', issuer: 'i', subject: 's', roles: ['admin'] }] })).toThrow(expect.objectContaining({ code: 'operator_registry_invalid' }));
    expect(() => new OperatorRegistry({ version: 1, operators: [{ operatorRef: 'a', issuer: 'i', subject: 's', roles: [] }, { operatorRef: 'b', issuer: 'i', subject: 's', roles: [] }] })).toThrow(/twice/);
    expect(() => new OperatorRegistry({ version: 1, operators: [{ operatorRef: 'a', issuer: 'i', subject: 's', roles: [], email: 'x@y' }] })).toThrow(expect.objectContaining({ code: 'operator_registry_invalid' }));
  });

  it.skipIf(process.platform === 'win32')('refuses a registry file that group or others can access', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'r4-reg-')), 'operators.json');
    writeFileSync(file, JSON.stringify(registryDoc('i')));
    chmodSync(file, 0o644);
    expect(() => loadOperatorRegistry(file)).toThrow(expect.objectContaining({ code: 'operator_registry_insecure' }));
    chmodSync(file, 0o600);
    expect(loadOperatorRegistry(file).find('i', 'sub-approver')?.operatorRef).toBe('ops.approver');
  });
});

describe('humanContext adapter', () => {
  const adapter = (nonces: NonceLedger) => createOidcHumanContext({ verifier, registry: new OperatorRegistry(registryDoc(idp.issuer)), nonces });
  const req = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } });

  it('yields a trusted context only for a verified, registered identity with an outstanding nonce — exactly once', () => {
    const nonces = new NonceLedger();
    const nonce = nonces.issue();
    const token = good({ nonce });
    const a = adapter(nonces);
    expect(a.diagnose(token).humanRef).toBe('oidc:ops.approver');
    expect(a.resolve(req(`Bearer ${token}`))).toEqual({ humanRef: 'oidc:ops.approver', scopes: ['approval.decide'], correlationId: 'operator-oidc' });
    // Replay of the same token: the nonce was consumed.
    expect(a.resolve(req(`Bearer ${token}`))).toBeNull();
    expect(() => a.diagnose(token)).toThrow(expect.objectContaining({ code: 'oidc_nonce_mismatch' }));
  });

  it('refuses missing or non-bearer credentials, forged tokens, foreign nonces and unregistered identities', () => {
    const nonces = new NonceLedger();
    const a = adapter(nonces);
    const nonce = nonces.issue();
    expect(a.resolve(req())).toBeNull();
    expect(a.resolve(req(`Basic ${Buffer.from('ops:x').toString('base64')}`))).toBeNull();
    expect(a.resolve({ headers: { 'x-operator': 'ops.approver', authorization: undefined } })).toBeNull();
    expect(a.resolve(req(`Bearer ${idp.mint({ claims: { sub: 'sub-approver', nonce, hd: 'pesaschile.test' }, forge: 'attacker-key' })}`))).toBeNull();
    expect(a.resolve(req(`Bearer ${good({ nonce: 'f'.repeat(32) })}`))).toBeNull();
    expect(() => a.diagnose(good({ nonce, sub: 'sub-unknown' }))).toThrow(expect.objectContaining({ code: 'operator_not_registered' }));
    expect(a.resolve(req(`Bearer ${good({ nonce, sub: 'sub-unknown' })}`))).toBeNull();
    // The failed attempts did not consume the nonce; a valid token still resolves once.
    expect(a.resolve(req(`Bearer ${good({ nonce })}`))?.humanRef).toBe('oidc:ops.approver');
  });

  it('nonces are single use and expire', () => {
    let t = 0;
    const nonces = new NonceLedger(() => t);
    const n = nonces.issue();
    expect(nonces.consume(n)).toBe(true);
    expect(nonces.consume(n)).toBe(false);
    const m = nonces.issue();
    t = 11 * 60_000;
    expect(nonces.consume(m)).toBe(false);
  });
});

describe('loopback sign-in (authorization code + PKCE + state + nonce)', () => {
  it('returns the ID token bound to the nonce after the operator signs in', async () => {
    idp.login = { sub: 'sub-approver', email: 'ops@pesaschile.test', hd: 'pesaschile.test' };
    const nonces = new NonceLedger();
    const nonce = nonces.issue();
    const token = await loopbackLogin({ verifier, nonce, openUrl: idp.browser, timeoutMs: 10_000 });
    expect(verifier.verify(token, { nonce })).toMatchObject({ subject: 'sub-approver' });
  });

  it('refuses a callback that this login did not start (state mismatch / CSRF) and a denied sign-in', async () => {
    const forged = (url: string) => {
      const u = new URL(url);
      const redirect = new URL(u.searchParams.get('redirect_uri')!);
      redirect.search = new URLSearchParams({ code: 'attacker-code', state: 'attacker-state' }).toString();
      return fetch(redirect).then(() => undefined);
    };
    await expect(loopbackLogin({ verifier, nonce: NONCE, openUrl: forged, timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'oidc_state_mismatch' });
    idp.login = null;
    await expect(loopbackLogin({ verifier, nonce: NONCE, openUrl: idp.browser, timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'oidc_login_denied' });
  });

  it('expires when nobody signs in', async () => {
    await expect(loopbackLogin({ verifier, nonce: NONCE, openUrl: () => undefined, timeoutMs: 200 })).rejects.toMatchObject({ code: 'oidc_login_timeout' });
  });
});

describe('production:sales:operator command', () => {
  it('requires the request, the reviewed argument hash and a reason for a decision', () => {
    expect(parseOperatorCommand(['approvals', 'approve', '--request', 'r', '--arguments-hash', 'h', '--reason', 'ok'])).toEqual({ kind: 'approvals-decide', decision: 'approve', requestId: 'r', argumentsHash: 'h', reason: 'ok' });
    expect(() => parseOperatorCommand(['approvals', 'approve', '--request', 'r', '--reason', 'ok'])).toThrow(/--arguments-hash is required/);
    expect(() => parseOperatorCommand(['approvals', 'reject', '--request', 'r', '--arguments-hash', 'h', '--reason', ' '])).toThrow(/--reason/);
    expect(() => parseOperatorCommand(['approvals', 'approve', '--request', 'r', '--arguments-hash', 'h', '--reason', 'ok', '--as', 'felipe'])).toThrow(/unexpected argument: --as/);
    expect(parseOperatorCommand(['whoami'])).toEqual({ kind: 'whoami' });
  });
});
