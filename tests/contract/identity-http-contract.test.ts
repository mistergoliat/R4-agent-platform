import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainError, type IdentityResolution } from '@r4-adapters/domains';
import { CUSTOMER_IDENTITY_ROUTE, CustomerIdentityHttpClient, pinnedIdentityContract, type CustomerIdentityFetch } from '@r4-adapters/identity-http';

// R4-J4-R3 contract tests: the CIA adapter against the producer's v1-d2 artifacts, copied byte for
// byte from MS-pesaschile-customer-identity-authority at 7525395 (D2 accepted for synthetic
// interoperability). CONTRACT tests over fixtures: they do not prove end-to-end interoperability.

const ROOT = join(import.meta.dirname, '..', '..');
const PACKAGE = join(ROOT, 'adapters', 'domains', 'identity', 'http');
const CONTRACT = join(PACKAGE, 'contract');
type Entry = { file: string; sourcePath: string; gitBlob: string; sha256: string; contentSha256: string };
const SOURCE = JSON.parse(readFileSync(join(CONTRACT, 'SOURCE.json'), 'utf8')) as { ownerCommit: string; revision: string; revisionLabel: string; files: Entry[] };
const lf = (file: string) => Buffer.from(readFileSync(join(CONTRACT, file), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const contentHash = (bytes: Buffer) => sha256(JSON.stringify(JSON.parse(bytes.toString('utf8'))));
const json = (file: string) => JSON.parse(lf(file).toString('utf8')) as Record<string, unknown>;
const listed = (dir: string): string[] =>
  readdirSync(join(CONTRACT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listed(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

describe('pinned CIA artifacts (provenance)', () => {
  it('records the owner commit and the accepted D2 revision', () => {
    expect(SOURCE).toMatchObject({ ownerCommit: '7525395d14d72c36853add31b327c6ebd5fb9e73', revision: 'v1-d2', revisionLabel: 'v1-d2-candidate' });
    expect(json('MANIFEST.v1-d2.json')).toMatchObject({ revision: 'v1-d2-candidate', base: { revision: 'v1-s0-candidate' } });
  });

  it('every copied file is byte-identical to the owner blob it records (3 schemas, 22 fixtures, 2 manifests)', () => {
    const copied = [...listed('schemas'), ...listed('fixtures'), 'MANIFEST.v1.json', 'MANIFEST.v1-d2.json'].sort();
    expect(SOURCE.files.map((entry) => entry.file).sort()).toEqual(copied);
    expect(copied).toHaveLength(27);
    for (const entry of SOURCE.files) {
      const bytes = lf(entry.file);
      expect(sha256(bytes), entry.file).toBe(entry.sha256);
      expect(contentHash(bytes), entry.file).toBe(entry.contentSha256);
      expect(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest('hex'), entry.file).toBe(entry.gitBlob);
    }
  });

  it('the S0 MANIFEST of the owner agrees with the copied schemas and fixtures (owner hash rule)', () => {
    const s0 = json('MANIFEST.v1.json') as { schemas: { file: string; sha256: string }[]; fixtures: { file: string; sha256: string }[] };
    const owned = [...s0.schemas, ...s0.fixtures];
    for (const entry of SOURCE.files.filter((e) => e.file.startsWith('schemas/') || e.file.startsWith('fixtures/'))) {
      const ownerEntry = owned.find((o) => o.file === entry.file);
      expect(ownerEntry, entry.file).toBeDefined();
      expect(ownerEntry!.sha256, entry.file).toBe(entry.contentSha256);
    }
  });

  it('the runtime loads the pinned schemas (hash-checked); the valid request fixture validates and the invalid ones do not', () => {
    const contract = pinnedIdentityContract();
    expect(contract.ownerCommit).toBe(SOURCE.ownerCommit);
    expect(contract.validateRequest(json('fixtures/resolve/request.valid.json'))).toBe(true);
    for (const file of ['fixtures/resolve/request.invalid.channel-shape.json', 'fixtures/resolve/request.invalid.empty-purposes.json']) expect(contract.validateRequest(json(file)), file).toBe(false);
  });
});

// The verified fixture: resolvedAt 18:00:00Z, grant expires 18:05:00Z, purposes [purchase_history].
const NOW = new Date('2026-10-19T18:00:30.000Z');
const SUBJECT = { channel: 'whatsapp', accountRef: '100000000000001', subjectRef: '15555550101', sessionRef: 'bnd_synthetic_0001' };
const respond = (status: number, body: unknown): CustomerIdentityFetch => () => Promise.resolve({
  status,
  headers: new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
  body: new Response(JSON.stringify(body)).body,
});
const client = (fetch: CustomerIdentityFetch) =>
  new CustomerIdentityHttpClient({ config: { baseUrl: 'http://127.0.0.1:8787', bearerToken: 'synthetic-r4-sales-agent-token-0001', timeoutMs: 1_500, lifecycle: 'synthetic' }, fetch, now: () => NOW });
const fails = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a DomainError'); }, (error: unknown) => {
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
});

describe('every owner resolve fixture maps to the port (CIA v1-d2 §5.3, §7)', () => {
  const VALID: Record<string, IdentityResolution['status']> = {
    'response.verified.json': 'verified',
    'response.not-linked.json': 'not_linked',
    'response.not-verified.json': 'not_verified',
    'response.ambiguous.json': 'ambiguous',
    'response.conflicted.json': 'conflicted',
    'response.not-authorized.json': 'not_authorized',
  };

  it.each(Object.entries(VALID))('%s → %s, with customerRef and grant only when verified', async (file, status) => {
    const resolution = await client(respond(200, json(`fixtures/resolve/${file}`))).resolve(SUBJECT, ['purchase_history']);
    expect(resolution.status).toBe(status);
    expect(Object.keys(resolution).sort()).toEqual(status === 'verified' ? ['customerRef', 'grant', 'resolvedAt', 'status'] : ['resolvedAt', 'status']);
  });

  it('the verified fixture keeps the grant opaque and identical (token, expiresAt, purposes) and drops schemaVersion', async () => {
    const wire = json('fixtures/resolve/response.verified.json') as { customerRef: string; grant: Record<string, unknown>; resolvedAt: string };
    expect(await client(respond(200, wire)).resolve(SUBJECT, ['purchase_history'])).toEqual({ status: 'verified', customerRef: wire.customerRef, grant: wire.grant, resolvedAt: wire.resolvedAt });
  });

  it.each(['response.invalid.master-customer-id.json', 'response.invalid.not-linked-with-customer-ref.json', 'response.invalid.verified-without-grant.json'])('%s is a contract_violation', async (file) => {
    expect(await fails(client(respond(200, json(`fixtures/resolve/${file}`))).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ category: 'contract_violation', code: 'invalid_response' });
  });
});

describe('every owner error fixture maps to a DomainError category by its HTTP status', () => {
  const STATUS: Record<string, [number, string, string]> = {
    'invalid-request.json': [400, 'validation', 'invalid_request'],
    'unauthenticated.json': [401, 'unauthorized', 'identity_unauthorized'],
    'consumer-not-allowed.json': [403, 'unauthorized', 'identity_unauthorized'],
    'rate-limited.json': [429, 'temporarily_unavailable', 'rate_limited'],
    'dependency-unavailable.json': [503, 'temporarily_unavailable', 'dependency_unavailable'],
  };
  it.each(Object.entries(STATUS))('%s (HTTP %s)', async (file, [status, category, code]) => {
    const error = await fails(client(respond(status, json(`fixtures/errors/${file}`))).resolve(SUBJECT, ['purchase_history']));
    expect(error).toMatchObject({ category, code });
    expect(error.details.ownerCode).toBe((json(`fixtures/errors/${file}`) as { error: { code: string } }).error.code);
  });

  it('an error body outside the schema (free text) is classified by status alone and never echoed', async () => {
    const error = await fails(client(respond(503, json('fixtures/errors/invalid.free-text-message.json'))).resolve(SUBJECT, ['purchase_history']));
    expect(error).toMatchObject({ category: 'temporarily_unavailable', code: 'identity_unavailable', details: { ownerCode: null } });
  });
});

describe('package boundaries', () => {
  const sources = readdirSync(join(PACKAGE, 'src')).map((file) => ({ file, text: readFileSync(join(PACKAGE, 'src', file), 'utf8') }));

  it('depends on no R4 Core package: only node:, ajv, ajv-formats, the domain ports and its own files', () => {
    for (const { file, text } of sources) {
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      expect(imports.filter((s) => !/^(\.\/[\w-]+\.js|node:[\w/]+|ajv\/dist\/2020\.js|ajv-formats|@r4-adapters\/domains)$/.test(s)), file).toEqual([]);
    }
    expect((JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { dependencies: unknown }).dependencies).toEqual({ '@r4-adapters/domains': '*', ajv: '8.20.0', 'ajv-formats': '3.0.1' });
  });

  it('calls exactly one route, resolve (no verification, confirmation or revocation routes: SEC-OTP-01/02)', () => {
    const all = sources.map((source) => source.text).join('\n');
    expect(CUSTOMER_IDENTITY_ROUTE).toBe('/v1/identity/resolve');
    expect([...all.matchAll(/'\/v1\/[^']*'/g)].map((match) => match[0])).toEqual(["'/v1/identity/resolve'"]);
    expect(all).not.toMatch(/verifications|confirm|links\/revoke|jwks/);
  });

  it('never decodes, signs or rewrites a grant', () => {
    const all = sources.map((source) => source.text).join('\n');
    expect(all).not.toMatch(/base64url|atob\(|jose|createSign|\.split\('\.'\)/);
  });
});
