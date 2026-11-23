import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type ApiConfig, type Platform } from '@r4/api';
import { createSilentLogger } from '@r4/observability';
import { migrateSales } from '@r4-sales/agent';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { REPO_AGENTS_DIR, validTaskBody } from '../support/platform.js';

/**
 * ADR-050: the console's signed, per-request assertion is a trusted human on
 * the real composition root. The service reader still never writes, and
 * R4_API_ANONYMOUS_WRITES=disabled closes the R4-B anonymous writes.
 */
const KEY = randomBytes(32).toString('base64url');
const ISS = 'https://accounts.google.com';
const SUB = '109876543210987654321';
const TOKEN = 'console-reader-token-0123456789abcdef0123456789';
const BEARER = { authorization: `Bearer ${TOKEN}` };
const JSON_TYPE = { 'content-type': 'application/json' };
const DESK_KEY = randomBytes(32).toString('base64url');
const DESK_TOKEN = 'desk-reader-token-0123456789abcdef0123456789abc';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let db: TestDatabase | null = null;
let hardened: Platform | null = null;
let legacy: Platform | null = null;
beforeAll(async () => {
  db = await createMigratedTestDatabase();
  const pool = openPool(db.url);
  try {
    await migrateSales(pool);
  } finally {
    await pool.end();
  }
  const dir = mkdtempSync(join(tmpdir(), 'r4-console-it-'));
  const operatorsFile = join(dir, 'operators.json');
  writeFileSync(operatorsFile, JSON.stringify([{ issuer: ISS, subject: SUB, operatorRef: 'felipe', scopes: ['autonomy.control', 'handoff.manage', 'task.cancel'] }]), { mode: 0o600 });
  const deskOperatorsFile = join(dir, 'desk-operators.json');
  writeFileSync(deskOperatorsFile, JSON.stringify([{ issuer: ISS, subject: SUB, operatorRef: 'felipe', scopes: ['handoff.manage', 'consultation.answer'] }]), { mode: 0o600 });
  const base: ApiConfig = { databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: REPO_AGENTS_DIR, dbPoolMax: 2 };
  hardened = await createPlatform(
    {
      ...base, serviceReaderTokenSha256: `${sha256(TOKEN)},${sha256(DESK_TOKEN)}`, consoleOperatorKey: KEY, consoleOperatorsFile: operatorsFile,
      deskOperatorKey: DESK_KEY, deskOperatorsFile, anonymousWrites: 'disabled',
    },
    { logger: createSilentLogger() },
  );
  legacy = await createPlatform(base, { logger: createSilentLogger() });
});
afterAll(async () => {
  await hardened?.close();
  await legacy?.close();
  await db?.drop();
});

function assertion(path: string, body: string, key = KEY, scopes: readonly string[] = ['autonomy.control']): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, iss: ISS, sub: SUB, scopes, method: 'POST', path, bodySha256: createHash('sha256').update(body).digest('hex'), iat: now, exp: now + 60, jti: randomUUID() }),
  ).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', Buffer.from(key, 'base64url')).update(`v1.${payload}`).digest('base64url')}`;
}
const post = (platform: Platform, url: string, body: string, headers: Record<string, string> = {}) =>
  platform.app.inject({ method: 'POST', url, payload: body, headers: { ...JSON_TYPE, ...headers } });
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code;

describe('ADR-050 console operator identity', () => {
  it('a signed assertion turns autonomy off and on, attributed to oidc:<operatorRef>; a replay is refused', async () => {
    const off = JSON.stringify({ scope: 'global', autonomyEnabled: false, reason: 'console phase 3 test: off' });
    const offAssertion = assertion('/v1/production/controls', off);
    const res = await post(hardened!, '/v1/production/controls', off, { 'x-r4-console-assertion': offAssertion });
    expect(res.statusCode).toBe(200);
    expect(res.json().control).toMatchObject({ scope: 'global', autonomyEnabled: false, reason: 'console phase 3 test: off', changedBy: 'oidc:felipe' });

    const replay = await post(hardened!, '/v1/production/controls', off, { 'x-r4-console-assertion': offAssertion });
    expect([replay.statusCode, code(replay)]).toEqual([422, 'trusted_human_required']);

    const on = JSON.stringify({ scope: 'global', autonomyEnabled: true, reason: 'console phase 3 test: on' });
    const back = await post(hardened!, '/v1/production/controls', on, { 'x-r4-console-assertion': assertion('/v1/production/controls', on) });
    expect(back.statusCode).toBe(200);

    const controls = await hardened!.app.inject({ method: 'GET', url: '/v1/production/controls', headers: BEARER });
    const records: { changedBy: string }[] = controls.json().records;
    expect(records.find((r) => r.changedBy === 'oidc:felipe')).toMatchObject({ autonomyEnabled: true, reason: 'console phase 3 test: on' });
  });

  it('an assertion for another body or path is refused', async () => {
    const body = JSON.stringify({ scope: 'global', autonomyEnabled: false, reason: 'x' });
    const other = await post(hardened!, '/v1/production/controls', body.replace('"x"', '"y"'), { 'x-r4-console-assertion': assertion('/v1/production/controls', body) });
    expect([other.statusCode, code(other)]).toEqual([422, 'trusted_human_required']);
  });

  it('(ADR-048 phase 2) the desk signer cannot reach what only the console grants; the desk reader token reads', async () => {
    const body = JSON.stringify({ scope: 'global', autonomyEnabled: false, reason: 'desk' });
    const res = await post(hardened!, '/v1/production/controls', body, { 'x-r4-console-assertion': assertion('/v1/production/controls', body, DESK_KEY, ['autonomy.control', 'handoff.manage']) });
    // The desk's person is known (handoff.manage), but autonomy is not the desk's to change.
    expect([res.statusCode, code(res)]).toEqual([422, 'human_scope_denied']);
    const read = await hardened!.app.inject({ method: 'GET', url: '/v1/production/controls', headers: { authorization: `Bearer ${DESK_TOKEN}` } });
    expect(read.statusCode).toBe(200);
    const stranger = await hardened!.app.inject({ method: 'GET', url: '/v1/production/controls', headers: { authorization: `Bearer ${DESK_TOKEN}x` } });
    expect(stranger.statusCode).not.toBe(200);
  });

  it('the service reader token alone still cannot write', async () => {
    const body = JSON.stringify({ scope: 'global', autonomyEnabled: false, reason: 'reader' });
    const res = await post(hardened!, '/v1/production/controls', body, BEARER);
    expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
  });

  it('anonymous POST /v1/tasks is refused with R4_API_ANONYMOUS_WRITES=disabled and still works without it', async () => {
    const body = JSON.stringify(validTaskBody());
    const refused = await post(hardened!, '/v1/tasks', body);
    expect([refused.statusCode, code(refused)]).toEqual([422, 'anonymous_writes_disabled']);
    const inputs = await post(hardened!, `/v1/tasks/${randomUUID()}/inputs`, JSON.stringify({}));
    expect([inputs.statusCode, code(inputs)]).toEqual([422, 'anonymous_writes_disabled']);
    expect((await post(legacy!, '/v1/tasks', body)).statusCode).toBe(201);
  });
});
