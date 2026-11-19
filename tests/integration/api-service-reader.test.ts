import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '@r4/api';
import { createSilentLogger } from '@r4/observability';
import { SALES_AGENT_DIR, migrateSales } from '@r4-sales/agent';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * ADR-049: the console's read-only service credential opens the operator-plane
 * GETs and nothing else. Without a human context adapter, every write still
 * answers trusted_human_required — even with the service token.
 */
const TOKEN = 'console-reader-token-0123456789abcdef0123456789';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const TASK = '0190f1a2-0000-7000-8000-000000000001';
const BEARER = { authorization: `Bearer ${TOKEN}` };

let db: TestDatabase | null = null;
let platform: Platform | null = null;
beforeAll(async () => {
  db = await createMigratedTestDatabase();
  const pool = openPool(db.url);
  try {
    await migrateSales(pool);
  } finally {
    await pool.end();
  }
  platform = await createPlatform(
    { databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 2, serviceReaderTokenSha256: HASH },
    { logger: createSilentLogger() },
  );
});
afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  platform!.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code;

describe('ADR-049 service reader on the operator plane', () => {
  const READS = ['/v1/attention', '/v1/production/attention', '/v1/production/conversations', '/v1/production/metrics', '/v1/production/controls'];

  it.each(READS)('GET %s answers with the service token', async (url) => {
    expect((await call('GET', url, BEARER)).statusCode).toBe(200);
  });

  it.each(READS)('GET %s still refuses without it or with a wrong one', async (url) => {
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}-wrong` }]) {
      const res = await call('GET', url, headers);
      expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    }
  });

  it('never authorizes a write', async () => {
    const writes = [
      call('POST', '/v1/production/controls', BEARER, { scope: 'global', autonomyEnabled: false, reason: 'test' }),
      call('POST', `/v1/tasks/${TASK}/operator-messages`, BEARER, { responseKey: 'k', text: 'hola' }),
      call('POST', `/v1/tasks/${TASK}/handoff`, BEARER, {}),
      call('POST', `/v1/tasks/${TASK}/cancel`, BEARER, {}),
      call('POST', `/v1/human-requests/${TASK}/respond`, BEARER, { decision: 'approve' }),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).not.toBe(201);
    }
    const controls = await call('POST', '/v1/production/controls', BEARER, { scope: 'global', autonomyEnabled: false, reason: 'test' });
    expect([controls.statusCode, code(controls)]).toEqual([422, 'trusted_human_required']);
  });
});
