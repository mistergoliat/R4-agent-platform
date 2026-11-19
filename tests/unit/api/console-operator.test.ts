import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createConsoleOperatorContext } from '@r4/api';

/** ADR-050: the console's signed, per-request operator assertion. */
const KEY = randomBytes(32).toString('base64url');
const ISS = 'https://accounts.google.com';
const SUB = '109876543210987654321';
const NOW = 1_800_000_000;
const clock = { now: () => new Date(NOW * 1000) };
const URL = '/v1/production/controls';
const BODY = JSON.stringify({ scope: 'global', autonomyEnabled: false, reason: 'test' });

const dir = mkdtempSync(join(tmpdir(), 'r4-console-op-'));
function operatorsFile(content: unknown): string {
  const file = join(dir, `${randomUUID()}.json`);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  return file;
}
const FILE = operatorsFile([{ issuer: ISS, subject: SUB, operatorRef: 'felipe', scopes: ['autonomy.control', 'handoff.manage'] }]);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function sign(overrides: Record<string, unknown> = {}, key = KEY): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, iss: ISS, sub: SUB, scopes: ['autonomy.control'], method: 'POST', path: URL, bodySha256: sha(BODY), iat: NOW, exp: NOW + 60, jti: randomUUID(), ...overrides }),
  ).toString('base64url');
  const sig = createHmac('sha256', Buffer.from(key, 'base64url')).update(`v1.${payload}`).digest('base64url');
  return `v1.${payload}.${sig}`;
}
function req(assertion: string | undefined, init: { method?: string; url?: string; body?: string | null } = {}) {
  const warn = vi.fn();
  const body = init.body === undefined ? BODY : init.body;
  const request = {
    id: 'corr-1',
    method: init.method ?? 'POST',
    url: init.url ?? URL,
    headers: assertion === undefined ? {} : { 'x-r4-console-assertion': assertion },
    ...(body === null ? {} : { rawBody: Buffer.from(body) }),
    log: { warn },
  } as unknown as FastifyRequest;
  return { request, warn };
}
const adapter = () => createConsoleOperatorContext({ key: KEY, operatorsFile: FILE, clock })!;
const reason = (warn: ReturnType<typeof vi.fn>) => (warn.mock.calls[0]?.[0] as { reason?: string } | undefined)?.reason;

describe('ADR-050 console operator assertion', () => {
  it('accepts a valid assertion: oidc:<operatorRef>, granted scopes only, request correlation', () => {
    const { request, warn } = req(sign({ scopes: ['autonomy.control', 'approval.decide', 'unknown.scope'] }));
    expect(adapter()(request)).toEqual({ humanRef: 'oidc:felipe', scopes: ['autonomy.control'], correlationId: 'corr-1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('binds an empty body to sha256("")', () => {
    const { request } = req(sign({ bodySha256: sha('') }), { body: null });
    expect(adapter()(request)?.humanRef).toBe('oidc:felipe');
  });

  it('ignores requests without the header (no log)', () => {
    const { request, warn } = req(undefined);
    expect(adapter()(request)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['bad signature', () => req(sign({}, randomBytes(32).toString('base64url'))), 'signature_invalid'],
    ['tampered payload', () => req(sign().replace(/^v1\.[^.]+/, `v1.${Buffer.from('{"v":1}').toString('base64url')}`)), 'signature_invalid'],
    ['malformed header', () => req('v2.abc.def'), 'header_malformed'],
    ['expired', () => req(sign({ iat: NOW - 61, exp: NOW - 1 })), 'not_current'],
    ['future iat (beyond 30 s skew)', () => req(sign({ iat: NOW + 31, exp: NOW + 61 })), 'not_current'],
    ['lifetime over 60 s', () => req(sign({ iat: NOW, exp: NOW + 61 })), 'lifetime_invalid'],
    ['exp not after iat', () => req(sign({ iat: NOW, exp: NOW })), 'lifetime_invalid'],
    ['method mismatch', () => req(sign(), { method: 'GET' }), 'request_mismatch'],
    ['path mismatch', () => req(sign(), { url: `${URL}?x=1` }), 'request_mismatch'],
    ['body mismatch', () => req(sign(), { body: BODY.replace('false', 'true') }), 'body_mismatch'],
    ['unknown (iss, sub)', () => req(sign({ sub: 'someone-else' })), 'operator_not_registered'],
    ['scope not granted', () => req(sign({ scopes: ['approval.decide'] })), 'scope_not_granted'],
    ['extra payload field (email)', () => req(sign({ email: 'owner@example.com' })), 'payload_invalid'],
  ])('refuses %s (reason code only)', (_name, make, code) => {
    const { request, warn } = make();
    expect(adapter()(request)).toBeNull();
    expect(reason(warn)).toBe(code);
  });

  it('accepts iat within the 30 s skew', () => {
    expect(adapter()(req(sign({ iat: NOW + 30, exp: NOW + 60 })).request)).not.toBeNull();
  });

  it('is single use: a replayed jti is refused', () => {
    const a = adapter();
    const assertion = sign();
    expect(a(req(assertion).request)).not.toBeNull();
    const replay = req(assertion);
    expect(a(replay.request)).toBeNull();
    expect(reason(replay.warn)).toBe('replayed');
  });

  it('does not exist without configuration (fail closed)', () => {
    expect(createConsoleOperatorContext({ clock })).toBeUndefined();
  });

  it('fails the boot on half or malformed configuration', () => {
    expect(() => createConsoleOperatorContext({ key: KEY, clock })).toThrow(/set together/);
    expect(() => createConsoleOperatorContext({ operatorsFile: FILE, clock })).toThrow(/set together/);
    expect(() => createConsoleOperatorContext({ key: randomBytes(31).toString('base64url'), operatorsFile: FILE, clock })).toThrow(/at least 32 bytes/);
    expect(() => createConsoleOperatorContext({ key: 'not base64url!!'.repeat(4), operatorsFile: FILE, clock })).toThrow(/at least 32 bytes/);
    expect(() => createConsoleOperatorContext({ key: KEY, operatorsFile: join(dir, 'missing.json'), clock })).toThrow(/cannot be read/);
    expect(() => createConsoleOperatorContext({ key: KEY, operatorsFile: operatorsFile('nope'), clock })).toThrow(/not JSON/);
    expect(() => createConsoleOperatorContext({ key: KEY, operatorsFile: operatorsFile([{ issuer: ISS, subject: SUB, operatorRef: 'x', scopes: ['root'] }]), clock })).toThrow(/schema/);
    const twice = { issuer: ISS, subject: SUB, operatorRef: 'a', scopes: ['task.cancel'] };
    expect(() => createConsoleOperatorContext({ key: KEY, operatorsFile: operatorsFile([twice, { ...twice, operatorRef: 'b' }]), clock })).toThrow(/twice/);
  });

  it.skipIf(process.platform === 'win32')('refuses an operators file readable by group or others', () => {
    const file = operatorsFile([]);
    chmodSync(file, 0o644);
    expect(() => createConsoleOperatorContext({ key: KEY, operatorsFile: file, clock })).toThrow(/chmod 600/);
  });
});
