import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '@r4/api';
import { createSilentLogger } from '@r4/observability';
import { PostgresArtifacts } from '@r4/persistence-postgres';
import { ACTION_AGENTS_DIR } from '../support/actions.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';

/**
 * ADR-058: the console reads a kind's versions, signatures and proposals (service reader), and a signed operator
 * decides proposals (artifact.curate) and signs a version (artifact.sign). Content and changes stay opaque.
 */
const TOKEN = 'console-reader-token-artifacts-0123456789abcdef';
const BEARER = { authorization: `Bearer ${TOKEN}` };
const KEY = randomBytes(32).toString('base64url');
const ISS = 'https://accounts.google.com';
const SUB = '109876543210987654321';
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code;

let db: TestDatabase;
let platform: Platform;
let artifacts: PostgresArtifacts;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  const operatorsFile = join(mkdtempSync(join(tmpdir(), 'r4-artifacts-it-')), 'operators.json');
  writeFileSync(operatorsFile, JSON.stringify([{ issuer: ISS, subject: SUB, operatorRef: 'owner', scopes: ['artifact.curate', 'artifact.sign'] }]), { mode: 0o600 });
  platform = await createPlatform({
    databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: ACTION_AGENTS_DIR, dbPoolMax: 2,
    serviceReaderTokenSha256: createHash('sha256').update(TOKEN).digest('hex'), consoleOperatorKey: KEY, consoleOperatorsFile: operatorsFile, anonymousWrites: 'disabled',
  }, { logger: createSilentLogger() });
  artifacts = new PostgresArtifacts(platform.pool);
  for (const content of [{ n: 1 }, { n: 2 }]) {
    const { version } = await artifacts.createVersion({ kind: 'test.graph', content, createdBy: 'oidc:owner', note: `v${content.n}` });
    await artifacts.sign({ kind: 'test.graph', version: version.version, signedBy: 'oidc:owner', note: null, correlationId: `api-${content.n}` });
  }
  await artifacts.createVersion({ kind: 'test.graph', content: { n: 3 }, createdBy: 'oidc:owner', note: 'v3 sin firmar' });
  await artifacts.propose({ kind: 'test.graph', baseVersion: 2, source: 'test', correlationId: 'p', proposals: [
    { fingerprint: 'a', summary: 'cambio A', evidence: { x: 1 }, change: { op: 'a' } },
    { fingerprint: 'b', summary: 'aviso B', evidence: {}, change: null },
  ] });
}, 120_000);

afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

const get = (url: string, headers: Record<string, string> = BEARER) => platform.app.inject({ method: 'GET', url, headers });
function assertion(path: string, body: string, scopes: string[]): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, iss: ISS, sub: SUB, scopes, method: 'POST', path, bodySha256: createHash('sha256').update(body).digest('hex'), iat, exp: iat + 60, jti: randomUUID() })).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', Buffer.from(KEY, 'base64url')).update(`v1.${payload}`).digest('base64url')}`;
}
const post = (path: string, body: object, scopes: string[]) => {
  const payload = JSON.stringify(body);
  return platform.app.inject({ method: 'POST', url: path, payload, headers: { 'content-type': 'application/json', 'x-r4-console-assertion': assertion(path, payload, scopes) } });
};

describe('ADR-058 artifact reads', () => {
  it('the current version comes with its content and signer; its signatures newest first, without content', async () => {
    const current = await get('/v1/artifacts/test.graph/current');
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({ artifact: { kind: 'test.graph', version: 2, content: { n: 2 }, signedBy: 'oidc:owner' } });
    const signatures = (await get('/v1/artifacts/test.graph/signatures')).json<{ signatures: Record<string, unknown>[] }>().signatures;
    expect(signatures.map((s) => [s.version, s.replacesVersion])).toEqual([[2, 1], [1, null]]);
    expect(signatures[0]).not.toHaveProperty('content');
  });

  it('versions list the unsigned one too; proposals filter by state', async () => {
    const versions = (await get('/v1/artifacts/test.graph/versions')).json<{ versions: Record<string, unknown>[] }>().versions;
    expect(versions.map((v) => [v.version, v.signatures, v.current])).toEqual([[3, 0, false], [2, 1, true], [1, 1, false]]);
    expect(versions[0]).not.toHaveProperty('content');
    const proposals = (await get('/v1/artifacts/test.graph/proposals?state=proposed')).json<{ proposals: { summary: string }[] }>().proposals;
    expect(proposals.map((p) => p.summary)).toEqual(['cambio A', 'aviso B']);
  });

  it('a kind with nothing signed is null / empty', async () => {
    expect((await get('/v1/artifacts/other.kind/current')).json()).toEqual({ artifact: null });
    expect((await get('/v1/artifacts/other.kind/signatures')).json()).toEqual({ signatures: [] });
    expect((await get('/v1/artifacts/other.kind/proposals')).json()).toEqual({ proposals: [] });
  });

  it.each(['/v1/artifacts/test.graph/current', '/v1/artifacts/test.graph/signatures', '/v1/artifacts/test.graph/versions', '/v1/artifacts/test.graph/proposals'])('%s refuses without the service token', async (url) => {
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}-wrong` }]) {
      const res = await get(url, headers);
      expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    }
  });

  it.each(['/v1/artifacts/Test/current', '/v1/artifacts/test.graph/current?x=1', '/v1/artifacts/a%25/signatures', '/v1/artifacts/test.graph/proposals?state=x'])('GET %s is a 400', async (url) => {
    const res = await get(url);
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });
});

describe('ADR-058 artifact writes', () => {
  it('deciding needs artifact.curate; only proposed ones are decided', async () => {
    const ids = (await artifacts.proposals('test.graph', 'proposed')).map((p) => p.proposalId);
    const body = { proposalIds: ids, decision: 'approved', note: 'ok' };
    const denied = await post('/v1/artifacts/test.graph/proposals/decide', body, ['artifact.sign']);
    expect([denied.statusCode, code(denied)]).toEqual([422, 'human_scope_denied']);
    const ok = await post('/v1/artifacts/test.graph/proposals/decide', body, ['artifact.curate']);
    expect([ok.statusCode, ok.json()]).toEqual([200, { decided: 2, skipped: 0 }]);
    expect((await post('/v1/artifacts/test.graph/proposals/decide', body, ['artifact.curate'])).json()).toEqual({ decided: 0, skipped: 2 });
    expect((await artifacts.proposals('test.graph', 'approved')).map((p) => p.decidedBy)).toEqual(['oidc:owner', 'oidc:owner']);
  });

  it('signing needs artifact.sign and makes the version current', async () => {
    const denied = await post('/v1/artifacts/test.graph/sign', { version: 3 }, ['artifact.curate']);
    expect([denied.statusCode, code(denied)]).toEqual([422, 'human_scope_denied']);
    const ok = await post('/v1/artifacts/test.graph/sign', { version: 3, note: 'revisado' }, ['artifact.sign']);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ signature: { version: 3, replacesVersion: 2, signedBy: 'oidc:owner' } });
    expect((await artifacts.current('test.graph'))!.version).toBe(3);
    const again = await post('/v1/artifacts/test.graph/sign', { version: 3 }, ['artifact.sign']);
    expect([again.statusCode, code(again)]).toEqual([409, 'already_current']);
  });

  it.each([
    ['/v1/artifacts/test.graph/proposals/decide', { proposalIds: [], decision: 'approved' }],
    ['/v1/artifacts/test.graph/proposals/decide', { proposalIds: ['not-a-uuid'], decision: 'approved' }],
    ['/v1/artifacts/test.graph/proposals/decide', { proposalIds: [randomUUID()], decision: 'applied' }],
    ['/v1/artifacts/test.graph/sign', { version: 0 }],
    ['/v1/artifacts/test.graph/sign', { version: 1, extra: true }],
  ])('POST %s %j is a 400', async (url, body) => {
    const res = await post(url, body, ['artifact.curate', 'artifact.sign']);
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });
});

describe('ADR-058 D10 facts', () => {
  it('recording needs artifact.curate; the latest answer is the current fact', async () => {
    const body = { subject: 'P1', field: 'Perfiles', value: '50x50', note: 'medido en bodega' };
    const denied = await post('/v1/artifacts/test.graph/facts', body, ['artifact.sign']);
    expect([denied.statusCode, code(denied)]).toEqual([422, 'human_scope_denied']);
    const first = await post('/v1/artifacts/test.graph/facts', body, ['artifact.curate']);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ fact: { subject: 'P1', field: 'Perfiles', value: '50x50', source: 'console', recordedBy: 'oidc:owner' } });
    await post('/v1/artifacts/test.graph/facts', { ...body, value: '60x60' }, ['artifact.curate']);
    const current = (await get('/v1/artifacts/test.graph/facts?subject=P1')).json<{ facts: { value: string }[] }>().facts;
    expect(current.map((f) => f.value)).toEqual(['60x60']);
    const res = await get('/v1/artifacts/test.graph/facts', {});
    expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
  });

  it.each([{ subject: 'P1', field: 'Perfiles' }, { subject: 'P1', field: 'Perfiles', value: 'x'.repeat(501) }, { subject: '', field: 'f', value: 'v' }, { subject: 'P1', field: 'f', value: 'v', extra: 1 }])('POST facts %j is a 400', async (body) => {
    const res = await post('/v1/artifacts/test.graph/facts', body, ['artifact.curate']);
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });
});
