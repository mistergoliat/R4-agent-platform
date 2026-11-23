import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '@r4/api';
import { createSilentLogger } from '@r4/observability';
import { PostgresArtifacts } from '@r4/persistence-postgres';
import { ACTION_AGENTS_DIR } from '../support/actions.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';

/** ADR-058: the console reads a kind's signed version and its signatures (service reader only; content opaque). */
const TOKEN = 'console-reader-token-artifacts-0123456789abcdef';
const BEARER = { authorization: `Bearer ${TOKEN}` };
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code;

let db: TestDatabase;
let platform: Platform;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  platform = await createPlatform({
    databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: ACTION_AGENTS_DIR, dbPoolMax: 2,
    serviceReaderTokenSha256: createHash('sha256').update(TOKEN).digest('hex'), anonymousWrites: 'disabled',
  }, { logger: createSilentLogger() });
  const artifacts = new PostgresArtifacts(platform.pool);
  for (const content of [{ n: 1 }, { n: 2 }]) {
    const { version } = await artifacts.createVersion({ kind: 'test.graph', content, createdBy: 'oidc:owner', note: `v${content.n}` });
    await artifacts.sign({ kind: 'test.graph', version: version.version, signedBy: 'oidc:owner', note: null, correlationId: `api-${content.n}` });
  }
}, 120_000);

afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

const get = (url: string, headers: Record<string, string> = BEARER) => platform.app.inject({ method: 'GET', url, headers });

describe('ADR-058 artifact reads', () => {
  it('the current version comes with its content and signer; its signatures newest first, without content', async () => {
    const current = await get('/v1/artifacts/test.graph/current');
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({ artifact: { kind: 'test.graph', version: 2, content: { n: 2 }, signedBy: 'oidc:owner' } });
    const signatures = (await get('/v1/artifacts/test.graph/signatures')).json<{ signatures: Record<string, unknown>[] }>().signatures;
    expect(signatures.map((s) => [s.version, s.replacesVersion])).toEqual([[2, 1], [1, null]]);
    expect(signatures[0]).not.toHaveProperty('content');
  });

  it('a kind with nothing signed is null / empty', async () => {
    expect((await get('/v1/artifacts/other.kind/current')).json()).toEqual({ artifact: null });
    expect((await get('/v1/artifacts/other.kind/signatures')).json()).toEqual({ signatures: [] });
  });

  it.each(['/v1/artifacts/test.graph/current', '/v1/artifacts/test.graph/signatures'])('%s refuses without the service token', async (url) => {
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}-wrong` }]) {
      const res = await get(url, headers);
      expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    }
  });

  it.each(['/v1/artifacts/Test/current', '/v1/artifacts/test.graph/current?x=1', '/v1/artifacts/a%25/signatures'])('GET %s is a 400', async (url) => {
    const res = await get(url);
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });
});
